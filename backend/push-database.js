// backend/connect-database.js
require("dotenv").config();

const cassandra = require("cassandra-driver");
const path = require("path");
const SpotifyWebApi = require("spotify-web-api-node");
const logger = require("./configurations/logger");

// ====== ENV ======
const KEYSPACE =
  process.env.ASTRA_DB_KEYSPACE || process.env.KEYSPACE_NAME || "planetary";
const SCB_PATH = process.env.ASTRA_SCB_PATH;
const APPLICATION_TOKEN =
  process.env.APPLICATION_TOKEN || process.env.ASTRA_DB_APPLICATION_TOKEN;

const SPOTIFY_CLIENT_ID = process.env.CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.CLIENT_SECRET;

// Prefix fanout settings for artists_by_prefix
const PREFIX_MIN = parseInt(process.env.PREFIX_MIN || "2", 10); // 2 reduces hot partitions
const PREFIX_MAX = parseInt(process.env.PREFIX_MAX || "3", 10); // 3 gives nice UX

if (!SCB_PATH) throw new Error("[cassandra] Missing ASTRA_SCB_PATH");
if (!APPLICATION_TOKEN)
  throw new Error(
    "[cassandra] Missing APPLICATION_TOKEN / ASTRA_DB_APPLICATION_TOKEN",
  );
if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  throw new Error("[spotify] Missing CLIENT_ID/CLIENT_SECRET in .env");
}

// ====== Cassandra Client ======
let client = null;
function getClient() {
  if (client) return client;
  client = new cassandra.Client({
    cloud: { secureConnectBundle: path.resolve(SCB_PATH) },
    authProvider: new cassandra.auth.PlainTextAuthProvider(
      "token",
      APPLICATION_TOKEN,
    ),
    pooling: {
      coreConnectionsPerHost: {
        [cassandra.types.distance.local]: 1,
        [cassandra.types.distance.remote]: 1,
      },
    },
  });
  return client;
}

// ====== Schema ======
async function ensureSchema() {
  const c = getClient();

  const stmts = [
    // Artists table, now with name_lc for case-insensitive exact match
    `
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.artists (
      artist_id   text PRIMARY KEY,
      name        text,
      name_lc     text,
      genres      text,   /* JSON array */
      followers   int,
      popularity  int,
      images      text,   /* JSON array */
      updated_at  timestamp
    )
    `,
    // Albums table (one row per album)
    `
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.albums (
      album_id     text PRIMARY KEY,
      name         text,
      album_type   text,
      release_date text,
      total_tracks int,
      images       text,   /* JSON array */
      artists      text,   /* JSON array of {id,name} */
      updated_at   timestamp
    )
    `,
    // Mapping table to query albums by contributing artist
    `
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.albums_by_artist (
      artist_id    text,
      album_id     text,
      name         text,
      release_date text,
      PRIMARY KEY ((artist_id), album_id)
    )
    `,
    // Helper table for fast, case-insensitive prefix search (no LIKE needed)
    `
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.artists_by_prefix (
      prefix   text,      /* lowercased name prefix, length ${PREFIX_MIN}..${PREFIX_MAX} */
      name_lc  text,      /* full lowercased name for sorting */
      artist_id text,
      name     text,
      PRIMARY KEY ((prefix), name_lc, artist_id)
    ) WITH CLUSTERING ORDER BY (name_lc ASC, artist_id ASC)
    `,
    // SAI index for exact name lookups (optional but fine to keep)
    `
    CREATE CUSTOM INDEX IF NOT EXISTS artists_name_idx
    ON ${KEYSPACE}.artists (name)
    USING 'StorageAttachedIndex'
    `,
    // SAI index for exact, case-insensitive lookups on name_lc
    `
    CREATE CUSTOM INDEX IF NOT EXISTS artists_name_lc_idx
    ON ${KEYSPACE}.artists (name_lc)
    USING 'StorageAttachedIndex'
    `,
  ];

  for (const q of stmts) {
    await c.execute(q);
  }

  // NEW: ensure embedding column exists (JSON text)
  try {
    await c.execute(`ALTER TABLE ${KEYSPACE}.artists ADD embedding text`);
    logger.info(`[schema] added embedding column to ${KEYSPACE}.artists`);
  } catch (e) {
    // Ignore "already exists" style errors
    if (!/Invalid column name|already exists/i.test(e.message)) {
      logger.warn(`[schema] could not add embedding column: ${e.message}`);
    }
  }

  logger.info(
    `[schema] ensured: ${KEYSPACE}.artists (+name_lc, +embedding), ${KEYSPACE}.albums, ${KEYSPACE}.albums_by_artist, ${KEYSPACE}.artists_by_prefix, SAI indexes on name/name_lc`,
  );
}

// ====== Helpers ======
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeJson(obj) {
  try {
    return JSON.stringify(obj ?? null);
  } catch {
    return null;
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isRetriable(e) {
  const code = e?.statusCode || e?.status || e?.code;
  const retriableStatus = [429, 500, 502, 503, 504];
  const retriableCodes = [
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ECONNABORTED",
  ];
  return retriableStatus.includes(code) || retriableCodes.includes(code);
}

function retryDelayMs(e, attempt) {
  const ra =
    e?.headers?.["retry-after"] ||
    e?.response?.headers?.["retry-after"] ||
    e?.body?.headers?.["retry-after"];
  if (ra) {
    const s = parseInt(Array.isArray(ra) ? ra[0] : ra, 10);
    if (!isNaN(s) && s > 0) return s * 1000;
  }
  const base = Math.min(1000 * 2 ** attempt, 8000);
  return base + Math.floor(Math.random() * 400);
}

async function withRetry(label, fn, maxRetries = 4) {
  let last;
  for (let a = 0; a <= maxRetries; a++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isRetriable(e) || a === maxRetries) {
        logger.error(`[spotify] ${label} failed (final): ${e?.message || e}`);
        throw e;
      }
      const wait = retryDelayMs(e, a);
      logger.warn(
        `[spotify] ${label} retry ${a + 1}/${maxRetries} in ${wait}ms`,
      );
      await sleep(wait);
    }
  }
  throw last;
}

// ====== Hugging Face Embeddings ======
const HF_API_KEY = process.env.HUGGING_FACE_API_KEY;
const HF_MODEL = "BAAI/bge-small-en-v1.5"; // returns 384-dim vectors

function buildArtistSentence(a) {
  const name = a?.name ?? "";
  const genres = Array.isArray(a?.genres)
    ? a.genres
    : a?.genres
      ? a.genres
      : []; // Spotify gives array here
  const pop = a?.popularity ?? 0;
  const fol = a?.followers?.total ?? 0;
  const g = (genres || []).join(", ");
  return `${name}. Genres: ${g || "unknown"}. Popularity: ${pop}. Followers: ${fol}.`;
}

async function embedBatch(texts) {
  if (!HF_API_KEY) throw new Error("[hf] Missing HUGGING_FACE_API_KEY");
  const resp = await fetch(
    `https://api-inference.huggingface.co/models/${HF_MODEL}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: texts,
        options: { wait_for_model: true },
      }),
    },
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`[hf] ${resp.status} ${resp.statusText}: ${err}`);
  }

  const data = await resp.json();
  if (!Array.isArray(data)) throw new Error("[hf] unexpected response");
  return Array.isArray(data[0]) ? data : [data];
}

// ====== Spotify App Client ======
const spotify = new SpotifyWebApi({
  clientId: SPOTIFY_CLIENT_ID,
  clientSecret: SPOTIFY_CLIENT_SECRET,
});

async function ensureSpotifyToken() {
  const { body } = await withRetry("clientCredentialsGrant", () =>
    spotify.clientCredentialsGrant(),
  );
  spotify.setAccessToken(body.access_token);
  logger.info(`[spotify] app token acquired (expires_in=${body.expires_in}s)`);
}

// ====== Extract distinct artist_ids and album_ids from tracks ======
async function collectIdsFromTracks() {
  const c = getClient();
  const rs = await c.execute(
    `SELECT track_id, album_id, album_name, artists FROM ${KEYSPACE}.tracks`,
  );

  const artistIds = new Set();
  const albumIds = new Set();

  for (const row of rs.rows) {
    if (row.album_id) albumIds.add(row.album_id);
    // artists stored as TEXT JSON array of { id, name }
    if (row.artists) {
      try {
        const arr = JSON.parse(row.artists);
        for (const a of arr || []) {
          if (a?.id) artistIds.add(a.id);
        }
      } catch {}
    }
  }
  return { artistIds: Array.from(artistIds), albumIds: Array.from(albumIds) };
}

// ====== Write helpers ======
function* namePrefixes(nameLc) {
  if (!nameLc) return;
  const start = Math.max(PREFIX_MIN, 1);
  const end = Math.max(PREFIX_MAX, start);
  for (let n = start; n <= end; n++) {
    const p = nameLc.slice(0, n);
    if (p) yield p;
  }
}

async function upsertArtistPrefixes(c, artistId, name, nameLc) {
  if (!nameLc) return;
  for (const p of namePrefixes(nameLc)) {
    await c.execute(
      `
      INSERT INTO ${KEYSPACE}.artists_by_prefix (prefix, name_lc, artist_id, name)
      VALUES (?, ?, ?, ?)
      `,
      [p, nameLc, artistId, name ?? null],
      { prepare: true },
    );
  }
}

// ====== Upsert functions ======
async function upsertArtists(artists) {
  const c = getClient();

  const insertArtist = `
    INSERT INTO ${KEYSPACE}.artists
      (artist_id, name, name_lc, genres, followers, popularity, images, updated_at, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  // Build batch texts once
  const sentences = artists.map((a) => buildArtistSentence(a));
  let vectors = [];
  try {
    vectors = await withRetry("hf.embedBatch", () => embedBatch(sentences), 2);
  } catch (e) {
    logger.warn("[hf] embed batch failed; proceeding without embeddings", {
      err: e.message,
    });
    vectors = new Array(artists.length).fill(null);
  }

  for (let i = 0; i < artists.length; i++) {
    const a = artists[i];
    const name = a.name ?? null;
    const nameLc = name ? name.toLowerCase() : null;

    const embedding = vectors[i]; // float[] or null
    const embeddingJson = embedding ? safeJson(embedding) : null;

    await c.execute(
      insertArtist,
      [
        a.id,
        name,
        nameLc,
        safeJson(a.genres || []),
        a.followers?.total ?? null,
        a.popularity ?? null,
        safeJson(a.images || []),
        new Date(),
        embeddingJson,
      ],
      { prepare: true },
    );

    // Keep prefix table in sync
    await upsertArtistPrefixes(c, a.id, name, nameLc);
  }
}

async function upsertAlbumsAndMappings(albums) {
  const c = getClient();

  const albumQuery = `
    INSERT INTO ${KEYSPACE}.albums
      (album_id, name, album_type, release_date, total_tracks, images, artists, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const mapQuery = `
    INSERT INTO ${KEYSPACE}.albums_by_artist
      (artist_id, album_id, name, release_date)
    VALUES (?, ?, ?, ?)
  `;

  for (const al of albums) {
    const artistsLite = (al.artists || []).map((x) => ({
      id: x.id,
      name: x.name,
    }));

    await c.execute(
      albumQuery,
      [
        al.id,
        al.name ?? null,
        al.album_type ?? null,
        al.release_date ?? null,
        al.total_tracks ?? null,
        safeJson(al.images || []),
        safeJson(artistsLite),
        new Date(),
      ],
      { prepare: true },
    );

    // mapping rows so we can query albums by artist quickly
    for (const ar of artistsLite) {
      if (!ar?.id) continue;
      await c.execute(
        mapQuery,
        [ar.id, al.id, al.name ?? null, al.release_date ?? null],
        { prepare: true },
      );
    }
  }
}

// ====== Main run ======
async function run() {
  const c = getClient();
  try {
    await c.connect();
    logger.info("[astra] connected");

    await ensureSchema(); // tables + indexes + prefix table (+ embedding column)
    await ensureSpotifyToken(); // app token

    const { artistIds, albumIds } = await collectIdsFromTracks();
    logger.info(
      `[collect] unique artistIds=${artistIds.length}, albumIds=${albumIds.length}`,
    );

    if (artistIds.length === 0 && albumIds.length === 0) {
      logger.info("[collect] nothing to enrich — no tracks found");
      return;
    }

    // --- Fetch & upsert ARTISTS in chunks of 50 ---
    let artistFetched = 0;
    for (const group of chunk(artistIds, 50)) {
      const resp = await withRetry("getArtists", () =>
        spotify.getArtists(group),
      );
      const artists = (resp.body?.artists || []).filter(Boolean);
      await upsertArtists(artists);
      artistFetched += artists.length;
      logger.info(`[artists] upserted ${artistFetched}/${artistIds.length}`);
      await sleep(120);
    }

    // --- Fetch & upsert ALBUMS in chunks of 20 (and mappings) ---
    let albumFetched = 0;
    for (const group of chunk(albumIds, 20)) {
      const resp = await withRetry("getAlbums", () => spotify.getAlbums(group));
      const albums = (resp.body?.albums || []).filter(Boolean);
      await upsertAlbumsAndMappings(albums);
      albumFetched += albums.length;
      logger.info(`[albums] upserted ${albumFetched}/${albumIds.length}`);
      await sleep(120);
    }

    logger.info("[done] enrichment complete");
  } catch (err) {
    logger.error("[run] failed:", { err: err?.message || err });
    process.exitCode = 1;
  } finally {
    try {
      await c.shutdown();
      logger.info("[astra] disconnected");
    } catch {}
  }
}

run();
// End of file
