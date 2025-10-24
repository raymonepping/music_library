// backend/controllers/vectorController.js
const assert = require("node:assert");
const { getClient, KEYSPACE } = require("../services/cassandra");
const logger = require("../configurations/logger");

/** ========= Small in-memory TTL cache ========= **/
const CACHE_TTL_MS = parseInt(process.env.VECTOR_CACHE_TTL_MS || "300000", 10); // default 5 minutes
const _cache = new Map(); // key -> { expiresAt:number, value:any }

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value, ttlMs = CACHE_TTL_MS) {
  _cache.set(key, { expiresAt: Date.now() + ttlMs, value });
}

/** ========= Helpers ========= **/
function pickThumb(imagesText, prefer = 160) {
  try {
    const arr = JSON.parse(imagesText || "[]");
    if (!Array.isArray(arr) || arr.length === 0) return null;
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

const Q_ARTIST_EMBEDDING = (ks) => `
  SELECT artist_id, name, images, embedding
  FROM ${ks}.artists
  WHERE artist_id = ?
`;

const Q_ALL_ARTISTS_WITH_EMBEDDING = (ks) => `
  SELECT artist_id, name, images, embedding
  FROM ${ks}.artists
`;

// Cosine similarity
function cosineSim(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i],
      bi = b[i];
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return dot / denom;
}

/**
 * GET /vectors/artists/:id/similar?limit=5
 * Response:
 * {
 *   base: { artist_id, name, image_url },
 *   items: [{ artist_id, name, image_url, score, score_percent }],
 *   limit,
 *   cached: boolean,
 *   scored_at: ISODate
 * }
 */
async function similarArtists(req, res) {
  const client = getClient();
  const ks = KEYSPACE();
  const { id } = req.params;
  assert(id, "artist id required");

  const limit = Math.min(parseInt(req.query.limit || "5", 10), 25);
  const cacheKey = `similar:${id}:${limit}`;

  // Try cache first
  const cached = cacheGet(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    // 1) Base artist
    const baseRs = await client.execute(Q_ARTIST_EMBEDDING(ks), [id], {
      prepare: true,
    });
    if (baseRs.rowLength === 0)
      return res.status(404).json({ error: "artist not found" });

    const baseRow = baseRs.first();
    const baseEmbedding = parseJson(baseRow.embedding, null);
    if (!Array.isArray(baseEmbedding) || baseEmbedding.length === 0) {
      return res.status(400).json({ error: "base artist has no embedding" });
    }

    // 2) Scan all artists with paging and score
    const fetchSize = 500;
    let pageState = null;
    const candidates = [];

    do {
      const opts = { prepare: true, fetchSize };
      if (pageState) opts.pageState = pageState;

      const rs = await client.execute(
        Q_ALL_ARTISTS_WITH_EMBEDDING(ks),
        [],
        opts,
      );

      for (const r of rs.rows) {
        if (r.artist_id === id) continue;
        if (!r.embedding) continue;
        const vec = parseJson(r.embedding, null);
        if (!Array.isArray(vec) || vec.length === 0) continue;

        const score = cosineSim(baseEmbedding, vec);
        candidates.push({
          artist_id: r.artist_id,
          name: r.name,
          image_url: pickThumb(r.images, 160),
          score,
          score_percent: Math.round(score * 1000) / 10, // 1 decimal, e.g. 80.8
        });
      }

      pageState = rs.pageState || null;
    } while (pageState);

    candidates.sort((a, b) => b.score - a.score);
    const items = candidates.slice(0, limit);

    const payload = {
      base: {
        artist_id: baseRow.artist_id,
        name: baseRow.name,
        image_url: pickThumb(baseRow.images, 160),
      },
      items,
      limit,
      cached: false,
      scored_at: new Date().toISOString(),
    };

    // Cache it
    cacheSet(cacheKey, payload);

    return res.json(payload);
  } catch (e) {
    logger.error("[api] similarArtists failed", { err: e?.message || e });
    return res.status(500).json({ error: "internal error" });
  }
}

module.exports = { similarArtists };
