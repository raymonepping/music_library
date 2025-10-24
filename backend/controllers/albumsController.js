// backend/controllers/albumsController.js
const assert = require("node:assert");
const { getClient, KEYSPACE } = require("../services/cassandra");
const logger = require("../configurations/logger");

function parseJson(text, fallback) {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function pickThumb(imagesText, prefer = 160) {
  try {
    const arr = JSON.parse(imagesText || "[]");
    if (!Array.isArray(arr) || arr.length === 0) return null;
    let best = arr[0];
    let bestDelta = Math.abs((best.width || best.height || 9_999) - prefer);
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

const Q_ALBUM = (ks) => `
  SELECT album_id, name, album_type, release_date, total_tracks, images, artists, updated_at
  FROM ${ks}.albums
  WHERE album_id = ?
`;

const Q_LIST_ALBUMS = (ks) => `
  SELECT album_id, name, release_date, images
  FROM ${ks}.albums
`;

// GET /albums?limit=50&page_state=...&sort=name&dir=asc|desc
async function listAlbums(req, res) {
  const client = getClient();
  const ks = KEYSPACE();

  // paging + optional in-page sort
  const limitRaw = Number.parseInt(req.query.limit ?? "50", 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 200)
    : 50;
  const pageState = req.query.page_state || null;

  const sort = (req.query.sort || "").toLowerCase(); // 'name' supported
  const dir = (req.query.dir || "asc").toLowerCase(); // 'asc' | 'desc'

  try {
    const opts = { prepare: true, fetchSize: limit };
    if (pageState) opts.pageState = pageState;

    // Full table scan with server paging (fine for your scale).
    const rs = await client.execute(Q_LIST_ALBUMS(ks), [], opts);

    // Map raw rows -> DTO
    let items = rs.rows.map((r) => ({
      album_id: r.album_id,
      name: r.name,
      release_date: r.release_date,
      image_url: pickThumb(r.images, 160),
    }));

    // Optional in-page alphabetical sort by name (only affects the current page)
    if (sort === "name") {
      items.sort((a, b) => {
        const an = (a.name || "").toLowerCase();
        const bn = (b.name || "").toLowerCase();
        if (an < bn) return dir === "desc" ? 1 : -1;
        if (an > bn) return dir === "desc" ? -1 : 1;
        return 0;
      });
    }

    return res.json({
      items,
      limit,
      next_page_state: rs.pageState || null,
      has_more: Boolean(rs.pageState),
    });
  } catch (e) {
    logger.error("[api] listAlbums failed", { err: e?.message || e });
    return res.status(500).json({ error: "internal error" });
  }
}

async function getAlbum(req, res) {
  const client = getClient();
  const ks = KEYSPACE();
  const { id } = req.params;
  try {
    assert(id, "album id required");
    const rs = await client.execute(Q_ALBUM(ks), [id], { prepare: true });
    if (rs.rowLength === 0) {
      return res.status(404).json({ error: "album not found" });
    }
    const r = rs.first();
    return res.json({
      album_id: r.album_id,
      name: r.name,
      album_type: r.album_type,
      release_date: r.release_date,
      total_tracks: r.total_tracks,
      images: parseJson(r.images, []),
      artists: parseJson(r.artists, []),
      updated_at: r.updated_at,
    });
  } catch (e) {
    logger.error("[api] getAlbum failed", { err: e?.message || e });
    return res.status(500).json({ error: "internal error" });
  }
}

module.exports = { getAlbum, listAlbums };
