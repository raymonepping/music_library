// backend/controllers/artistsController.js
const assert = require("node:assert");
const { getClient, KEYSPACE } = require("../services/cassandra");
const logger = require("../configurations/logger");

// helper (top of file)
function pickThumb(imagesText, prefer = 160) {
  try {
    const arr = JSON.parse(imagesText || "[]");
    if (!Array.isArray(arr) || arr.length === 0) return null;
    // choose the image closest to preferred width (fallback to first)
    let best = arr[0];
    let bestDelta = Math.abs((best.width || best.height || 9999) - prefer);
    for (const im of arr) {
      const w = im?.width || im?.height || prefer;
      const d = Math.abs(w - prefer);
      if (d < bestDelta) {
        best = im;
        bestDelta = d;
      }
    }
    return best?.url || null;
  } catch {
    return null;
  }
}

function parseJson(text, fallback) {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

const Q_ORDERED_RANGE = ks => `
  SELECT artist_id, name, name_lc, images
  FROM ${ks}.artists
  WHERE name_lc >= ? AND name_lc < ?
  LIMIT ?
`;

const Q_ARTIST = (ks) => `
  SELECT artist_id, name, genres, followers, popularity, images, updated_at
  FROM ${ks}.artists
  WHERE artist_id = ?
`;

const Q_ALBUMS_BY_ARTIST = (ks) => `
  SELECT album_id, name, release_date
  FROM ${ks}.albums_by_artist
  WHERE artist_id = ?
`;

const Q_LIST_ARTISTS = (ks) => `
  SELECT artist_id, name, images
  FROM ${ks}.artists
`;

async function listArtistsAZ(req, res) {
  const client = getClient();
  const ks = KEYSPACE();

  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const after = (req.query.after || '').toLowerCase();           // last name from previous page
  const start = after ? `${after}\u0000` : '';                   // move past the last item
  const end = '\uffff';

  try {
    const rs = await client.execute(Q_ORDERED_RANGE(ks), [start, end, limit], { prepare: true });
    const items = rs.rows
      .sort((a, b) => (a.name_lc || '').localeCompare(b.name_lc || '')) // defensive (C* returns may not be strictly ordered)
      .map(r => ({
        artist_id: r.artist_id,
        name: r.name,
        image_url: pickThumb(r.images, 160),
        name_lc: r.name_lc
      }));

    const next_after = items.length ? items[items.length - 1].name_lc : null;

    return res.json({
      items,
      limit,
      next_after,       // use this as ?after= for next page
      has_more: items.length === limit
    });
  } catch (e) {
    logger.error('[api] listArtistsAZ failed', { err: e?.message || e });
    return res.status(500).json({ error: 'internal error' });
  }
}

async function listArtists(req, res) {
  const client = getClient();
  const ks = KEYSPACE();

  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
  const pageState = req.query.page_state || null;

  try {
    const opts = { prepare: true, fetchSize: limit };
    if (pageState) opts.pageState = pageState;

    // Full table scan with server paging. Fine at your scale (≈800).
    const rs = await client.execute(Q_LIST_ARTISTS(ks), [], opts);

    const items = rs.rows.map((r) => ({
      artist_id: r.artist_id,
      name: r.name,
      image_url: pickThumb(r.images, 160), // small grid thumb
    }));

    return res.json({
      items,
      limit,
      next_page_state: rs.pageState || null,
      has_more: Boolean(rs.pageState),
    });
  } catch (e) {
    logger.error("[api] listArtists failed", { err: e?.message || e });
    return res.status(500).json({ error: "internal error" });
  }
}

async function getArtist(req, res) {
  const client = getClient();
  const ks = KEYSPACE();
  const { id } = req.params;
  assert(id, "artist id required");

  try {
    const rs = await client.execute(Q_ARTIST(ks), [id], { prepare: true });
    if (rs.rowLength === 0)
      return res.status(404).json({ error: "artist not found" });

    const r = rs.first();
    return res.json({
      artist_id: r.artist_id,
      name: r.name,
      genres: parseJson(r.genres, []),
      followers: r.followers,
      popularity: r.popularity,
      images: parseJson(r.images, []),
      updated_at: r.updated_at,
    });
  } catch (e) {
    logger.error("[api] getArtist failed", { err: e?.message || e });
    return res.status(500).json({ error: "internal error" });
  }
}

async function getArtistAlbums(req, res) {
  const client = getClient();
  const ks = KEYSPACE();
  const { id } = req.params;
  assert(id, "artist id required");

  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
  const pageState = req.query.page_state || null;

  try {
    const opts = { prepare: true, fetchSize: limit };
    if (pageState) opts.pageState = pageState;

    const rs = await client.execute(Q_ALBUMS_BY_ARTIST(ks), [id], opts);

    const items = rs.rows.map((r) => ({
      album_id: r.album_id,
      name: r.name,
      release_date: r.release_date,
    }));

    return res.json({
      items,
      limit,
      next_page_state: rs.pageState || null,
      has_more: Boolean(rs.pageState),
    });
  } catch (e) {
    logger.error("[api] getArtistAlbums failed", { err: e?.message || e });
    return res.status(500).json({ error: "internal error" });
  }
}

module.exports = { getArtist, getArtistAlbums, listArtists, listArtistsAZ };
