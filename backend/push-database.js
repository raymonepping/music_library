// push-database.js
require("dotenv").config();

const cassandra = require("cassandra-driver");
const path = require("path");
const SpotifyWebApi = require("spotify-web-api-node");
const logger = require("./configurations/logger");
const config = require("./configurations");

// Prefix fanout settings for artists_by_prefix
const PREFIX_MIN = parseInt(process.env.PREFIX_MIN || "2", 10);
const PREFIX_MAX = parseInt(process.env.PREFIX_MAX || "3", 10);

// Helper to derive keyspace from Vault-backed config (with safe fallback)
function currentKeyspace() {
  return (
    config.ASTRA_DB_KEYSPACE ||
    process.env.ASTRA_DB_KEYSPACE ||
    process.env.KEYSPACE_NAME ||
    "planetary"
  );
}

// ====== Cassandra Client ======
let client = null;

function getClient() {
  if (client) return client;

  const SCB_PATH = config.ASTRA_SCB_PATH;
  const APPLICATION_TOKEN = config.ASTRA_DB_TOKEN || config.APPLICATION_TOKEN;

  if (!SCB_PATH) {
    throw new Error(
      "[cassandra] Missing ASTRA_SCB_PATH (from Vault kv/datastax)",
    );
  }
  if (!APPLICATION_TOKEN) {
    throw new Error(
      "[cassandra] Missing ASTRA_DB_TOKEN / APPLICATION_TOKEN (from Vault kv/datastax)",
    );
  }

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

  logger.debug("[astra] Cassandra client created", {
    keyspace: currentKeyspace(),
    scbPath: SCB_PATH,
  });

  return client;
}

// ====== Schema ======
async function ensureSchema() {
  const c = getClient();
  const KEYSPACE = currentKeyspace();

  const stmts = [
    `
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.artists (
      artist_id   text PRIMARY KEY,
      name        text,
      name_lc     text,
      genres      text,   /* JSON array */
      followers   int,
      popularity  int,
      images      text,   /* JSON array */
      updated_at  timestamp,
      embedding   text    /* JSON array of floats */
    )
    `,
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
    `
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.albums_by_artist (
      artist_id    text,
      album_id     text,
      name         text,
      release_date text,
      PRIMARY KEY ((artist_id), album_id)
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.artists_by_prefix (
      prefix   text,
      name_lc  text,
      artist_id text,
      name     text,
      PRIMARY KEY ((prefix), name_lc, artist_id)
    ) WITH CLUSTERING ORDER BY (name_lc ASC, artist_id ASC)
    `,
    `
    CREATE CUSTOM INDEX IF NOT EXISTS artists_name_idx
    ON ${KEYSPACE}.artists (name)
    USING 'StorageAttachedIndex'
    `,
    `
    CREATE CUSTOM INDEX IF NOT EXISTS artists_name_lc_idx
    ON ${KEYSPACE}.artists (name_lc)
    USING 'StorageAttachedIndex'
    `,
  ];

  for (const q of stmts) {
    await c.execute(q);
  }

  // Back-compat: if the artists table was created without 'embedding', try add it.
  try {
    await c.execute(`ALTER TABLE ${KEYSPACE}.artists ADD embedding text`);
    logger.info(`[schema] added embedding column to ${KEYSPACE}.artists`);
  } catch (e) {
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
const HF_MODEL = "BAAI/bge-small-en-v1.5"; // 384 dims

function buildArtistSentence(a) {
  const name = a?.name ?? "";
  const genres = Array.isArray(a?.genres)
    ? a.genres
    : a?.genres
      ? a.genres
      : [];
  const pop = a?.popularity ?? 0;
  const fol = a?.followers?.total ?? 0;
  const g = (genres || []).join(", ");
  return `${name}. Genres: ${g || "unknown"}. Popularity: ${pop}. Followers: ${fol}.`;
}

async function embedBatch(texts) {
  const doFetch = globalThis.fetch || require("node-fetch");

  const HF_API_KEY =
    config.HUGGING_FACE_API_KEY || process.env.HUGGING_FACE_API_KEY;

  if (!HF_API_KEY) {
    throw new Error(
      "[hf] Missing HUGGING_FACE_API_KEY (Vault kv/music or env)",
    );
  }

  const resp = await doFetch(
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

// ====== Spotify clients (lazy init using Vault-backed config) ======
let appSpotify = null;
let userSpotify = null;
let SPOTIFY_REFRESH_TOKEN = null;

function initSpotifyClients() {
  const SPOTIFY_CLIENT_ID = config.CLIENT_ID;
  const SPOTIFY_CLIENT_SECRET = config.CLIENT_SECRET;

  SPOTIFY_REFRESH_TOKEN =
    config.SPOTIFY_REFRESH_TOKEN || process.env.REFRESH_TOKEN || null;

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error(
      "[spotify] Missing CLIENT_ID/CLIENT_SECRET (from Vault kv/music or env)",
    );
  }

  appSpotify = new SpotifyWebApi({
    clientId: SPOTIFY_CLIENT_ID,
    clientSecret: SPOTIFY_CLIENT_SECRET,
  });

  userSpotify = new SpotifyWebApi({
    clientId: SPOTIFY_CLIENT_ID,
    clientSecret: SPOTIFY_CLIENT_SECRET,
    refreshToken: SPOTIFY_REFRESH_TOKEN || undefined,
  });

  logger.debug("[spotify] clients initialised from Vault-backed config", {
    hasRefreshToken: Boolean(SPOTIFY_REFRESH_TOKEN),
  });
}

// ====== Spotify: App token (client credentials) ======
async function ensureAppToken() {
  const { body } = await withRetry("clientCredentialsGrant", () =>
    appSpotify.clientCredentialsGrant(),
  );
  appSpotify.setAccessToken(body.access_token);
  logger.info(`[spotify] app token acquired (expires_in=${body.expires_in}s)`);
}

// ====== Spotify: User token (refresh token) ======
async function ensureUserTokenIfPossible() {
  if (!SPOTIFY_REFRESH_TOKEN) return false;
  try {
    const { body } = await withRetry("refreshAccessToken", () =>
      userSpotify.refreshAccessToken(),
    );
    userSpotify.setAccessToken(body.access_token);
    logger.info("[spotify] user token acquired via refresh_token");
    return true;
  } catch (e) {
    logger.warn(`[spotify] refreshAccessToken failed: ${e?.message || e}`);
    return false;
  }
}

// ====== Collect IDs from Astra tracks ======
async function collectIdsFromAstraTracks() {
  const c = getClient();
  const KEYSPACE = currentKeyspace();

  const rs = await c.execute(
    `SELECT track_id, album_id, album_name, artists FROM ${KEYSPACE}.tracks`,
  );

  const artistIds = new Set();
  const albumIds = new Set();

  for (const row of rs.rows) {
    if (row.album_id) albumIds.add(row.album_id);
    if (row.artists) {
      try {
        const arr = JSON.parse(row.artists);
        for (const a of arr || []) {
          if (a?.id) artistIds.add(a.id);
        }
      } catch {}
    }
  }
  return { artistIds, albumIds };
}

// ====== Collect IDs from Followed Artists (user) ======
async function collectIdsFromFollowedArtists() {
  const artistIds = new Set();
  if (!userSpotify.getAccessToken()) return artistIds;

  logger.info("[collect] followed artists: start");
  let after = undefined;
  const limit = 50;
  for (;;) {
    const resp = await withRetry("getFollowedArtists", () =>
      userSpotify.getFollowedArtists({ type: "artist", limit, after }),
    );
    const artists = resp.body?.artists || resp.body;
    const items = artists?.items || [];
    items.forEach((a) => a?.id && artistIds.add(a.id));

    const nextHref = artists?.next;
    if (!nextHref) break;

    after = items.length ? items[items.length - 1].id : undefined;
    if (!after) break;

    await sleep(120);
  }
  logger.info(`[collect] followed artists: +${artistIds.size}`);
  return artistIds;
}

// ====== Collect IDs from ALL User Playlists (user) ======
async function collectIdsFromUserPlaylists() {
  const artistIds = new Set();
  const albumIds = new Set();
  if (!userSpotify.getAccessToken()) return { artistIds, albumIds };

  const me = (await withRetry("getMe", () => userSpotify.getMe())).body;
  const userId = me?.id;
  logger.info(`[collect] playlists of @${userId}: start`);

  // list playlists (paginated)
  const plLimit = 50;
  let offset = 0;
  const playlists = [];
  for (;;) {
    const resp = await withRetry("getUserPlaylists", () =>
      userSpotify.getUserPlaylists(userId, { limit: plLimit, offset }),
    );
    const items = resp.body?.items || [];
    playlists.push(...items);

    logger.info(`[collect] fetched ${playlists.length} playlists so far...`);
    if (items.length < plLimit) break;
    offset += plLimit;
    await sleep(120);
  }
  logger.info(`[collect] playlists: found ${playlists.length}`);

  // iterate each playlist & collect ids from tracks (paginated)
  const trLimit = 100;
  for (let i = 0; i < playlists.length; i++) {
    const p = playlists[i];
    const pName = p?.name || "(untitled)";
    logger.info(
      `➡ processing playlist ${i + 1}/${playlists.length}: "${pName}"`,
    );

    let trOffset = 0;
    for (;;) {
      const trResp = await withRetry("getPlaylistTracks", () =>
        userSpotify.getPlaylistTracks(p.id, {
          limit: trLimit,
          offset: trOffset,
        }),
      );
      const tracks = trResp.body?.items || [];

      for (const it of tracks) {
        const t = it?.track;
        if (!t) continue;
        if (t.album?.id) albumIds.add(t.album.id);
        if (Array.isArray(t.artists)) {
          for (const a of t.artists) {
            if (a?.id) artistIds.add(a.id);
          }
        }
      }

      if (tracks.length < trLimit) break;
      trOffset += trLimit;

      logger.info(`   ... ${trOffset} tracks processed in "${pName}"`);
      await sleep(120);
    }
  }

  logger.info(
    `[collect] from playlists: +${artistIds.size} artists, +${albumIds.size} albums`,
  );
  return { artistIds, albumIds };
}

// (Optional) Saved tracks — enable if you want liked songs too
async function collectIdsFromSavedTracks() {
  const artistIds = new Set();
  const albumIds = new Set();
  if (!userSpotify.getAccessToken()) return { artistIds, albumIds };

  try {
    const limit = 50;
    let offset = 0;
    for (;;) {
      const res = await withRetry("getMySavedTracks", () =>
        userSpotify.getMySavedTracks({ limit, offset }),
      );
      const items = res.body?.items || [];
      for (const it of items) {
        const t = it?.track;
        if (!t) continue;
        if (t.album?.id) albumIds.add(t.album.id);
        if (Array.isArray(t.artists)) {
          for (const a of t.artists) {
            if (a?.id) artistIds.add(a.id);
          }
        }
      }
      if (items.length < limit) break;
      offset += limit;
      await sleep(120);
    }
    logger.info(
      `[collect] saved tracks: +${artistIds.size} artists, +${albumIds.size} albums`,
    );
  } catch (e) {
    logger.warn(
      `[spotify] getMySavedTracks failed (missing scope?) ${e.message}`,
    );
  }
  return { artistIds, albumIds };
}

// ====== Prefix helpers ======
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
  const KEYSPACE = currentKeyspace();
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
  const KEYSPACE = currentKeyspace();

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
  const KEYSPACE = currentKeyspace();

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
  // Ensure Vault-backed config is loaded before using it
  if (config.ready && typeof config.ready.then === "function") {
    await config.ready;
  }

  logger.info("[startup] using Vault-backed configuration", {
    keyspace: currentKeyspace(),
    hasAstraToken: Boolean(config.ASTRA_DB_TOKEN || config.APPLICATION_TOKEN),
    hasSpotifyClientId: Boolean(config.CLIENT_ID),
    hasSpotifyClientSecret: Boolean(config.CLIENT_SECRET),
    hasSpotifyRefreshToken: Boolean(config.SPOTIFY_REFRESH_TOKEN),
    hasHfKey: Boolean(config.HUGGING_FACE_API_KEY),
  });

  // Now we can safely create Spotify clients with Vault-loaded secrets
  initSpotifyClients();

  const c = getClient();
  try {
    await c.connect();
    logger.info("[astra] connected");

    await ensureSchema(); // tables + indexes + prefix table (+ embedding column)
    await ensureAppToken(); // app token for getArtists/getAlbums

    // Try to get a user token if refresh token exists
    const haveUser = await ensureUserTokenIfPossible();
    if (haveUser) {
      logger.info("[spotify:user] enabled (followed artists + playlists)");
    } else {
      logger.info(
        "[spotify:user] not configured (set SPOTIFY_REFRESH_TOKEN in Vault kv/music to enable)",
      );
    }

    // --- Collect IDs from sources ---
    // 1) Existing Astra tracks table
    const fromAstra = await collectIdsFromAstraTracks();

    // 2) Optional: followed artists
    const followedArtistIds = haveUser
      ? await collectIdsFromFollowedArtists()
      : new Set();

    // 3) Optional: all user playlists (and their tracks)
    const fromPlaylists = haveUser
      ? await collectIdsFromUserPlaylists()
      : { artistIds: new Set(), albumIds: new Set() };

    // 4) Optional: saved tracks (enable if desired)
    // const fromSaved = haveUser ? await collectIdsFromSavedTracks() : { artistIds: new Set(), albumIds: new Set() };

    // Merge
    const allArtistIds = new Set([
      ...fromAstra.artistIds,
      ...followedArtistIds,
      ...fromPlaylists.artistIds,
      // ...fromSaved.artistIds,
    ]);
    const allAlbumIds = new Set([
      ...fromAstra.albumIds,
      ...fromPlaylists.albumIds,
      // ...fromSaved.albumIds,
    ]);

    logger.info(
      `[collect] unique artistIds=${allArtistIds.size}, albumIds=${allAlbumIds.size}`,
    );

    if (allArtistIds.size === 0 && allAlbumIds.size === 0) {
      logger.info("[collect] nothing to enrich — no ids found");
      return;
    }

    // --- Fetch & upsert ARTISTS in chunks of 50 ---
    let artistFetched = 0;
    for (const group of chunk(Array.from(allArtistIds), 50)) {
      const resp = await withRetry("getArtists", () =>
        appSpotify.getArtists(group),
      );
      const artists = (resp.body?.artists || []).filter(Boolean);
      await upsertArtists(artists);
      artistFetched += artists.length;
      logger.info(`[artists] upserted ${artistFetched}/${allArtistIds.size}`);
      await sleep(120); // gentle pacing
    }

    // --- Fetch & upsert ALBUMS in chunks of 20 (and mappings) ---
    let albumFetched = 0;
    for (const group of chunk(Array.from(allAlbumIds), 20)) {
      const resp = await withRetry("getAlbums", () =>
        appSpotify.getAlbums(group),
      );
      const albums = (resp.body?.albums || []).filter(Boolean);
      await upsertAlbumsAndMappings(albums);
      albumFetched += albums.length;
      logger.info(`[albums] upserted ${albumFetched}/${allAlbumIds.size}`);
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
