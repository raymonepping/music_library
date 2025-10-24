// backend/controllers/searchController.js
const { getClient, KEYSPACE } = require("../services/cassandra");
const logger = require("../configurations/logger");

const norm = (s) => (s || "").toLowerCase().trim();

const Q_EXACT = (ks) => `
  SELECT artist_id, name
  FROM ${ks}.artists
  WHERE name_lc = ?
`;

const Q_PREFIX = (ks) => `
  SELECT artist_id, name
  FROM ${ks}.artists_by_prefix
  WHERE prefix = ?
`;

/**
 * Legacy endpoint:
 *   /search/artists?name=andre hazes
 *   /search/artists?prefix=ramm
 */
async function searchArtists(req, res) {
  const client = getClient();
  const ks = KEYSPACE();
  const name = norm(req.query.name);
  const prefix = norm(req.query.prefix);
  const limit = Math.min(parseInt(req.query.limit || "25", 10), 100);

  try {
    if (name) {
      const rs = await client.execute(Q_EXACT(ks), [name], { prepare: true });
      return res.json(
        rs.rows.map((r) => ({ artist_id: r.artist_id, name: r.name })),
      );
    }

    if (prefix && prefix.length >= 2) {
      // align with your fanout 2..3: normalize to 3 for the partition key
      const p = prefix.slice(0, 3);
      const rs = await client.execute(Q_PREFIX(ks), [p], {
        prepare: true,
        fetchSize: limit,
      });
      return res.json(
        rs.rows
          .slice(0, limit)
          .map((r) => ({ artist_id: r.artist_id, name: r.name })),
      );
    }

    return res.status(400).json({
      error:
        "Use ?name= for exact (case-insensitive) or ?prefix= with 2+ chars",
    });
  } catch (e) {
    logger.error("[api] searchArtists failed", { err: e?.message || e });
    return res.status(500).json({ error: "internal error" });
  }
}

/**
 * New exact endpoint (matches your frontend):
 *   /search/artists/exact?q=andre hazes
 */
async function searchArtistsExact(req, res) {
  const client = getClient();
  const ks = KEYSPACE();
  const q = norm(req.query.q);
  if (!q) return res.json([]);

  try {
    const rs = await client.execute(Q_EXACT(ks), [q], { prepare: true });
    const items = rs.rows.map((r) => ({
      artist_id: r.artist_id,
      name: r.name,
    }));
    return res.json(items);
  } catch (e) {
    logger.error("[api] searchArtistsExact failed", { err: e?.message || e });
    return res.status(500).json({ error: "internal error" });
  }
}

/**
 * New prefix endpoint (matches your frontend):
 *   /search/artists/prefix-sai?q=rammstein&limit=20
 * Uses SAI range on name_lc to emulate "starts with".
 */
async function searchArtistsPrefixSAI(req, res) {
  const client = getClient();
  const ks = KEYSPACE();
  const q = (req.query.q || "").trim().toLowerCase();
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 200);

  if (!q) return res.json([]);

  try {
    let rs;
    if (q.length <= 3) {
      // Use artists_by_prefix table for fast search
      const prefix = q.slice(0, q.length);
      rs = await client.execute(
        `SELECT artist_id, name, name_lc, images
         FROM ${ks}.artists_by_prefix
         WHERE prefix = ?
         LIMIT ?`,
        [prefix, limit],
        { prepare: true },
      );
    } else {
      // Use SAI with ALLOW FILTERING for longer prefixes
      const start = q;
      const end = `${q}\uffff`;
      rs = await client.execute(
        `SELECT artist_id, name, name_lc, images
         FROM ${ks}.artists
         WHERE name_lc >= ? AND name_lc < ?
         LIMIT ${limit}
         ALLOW FILTERING`,
        [start, end],
        { prepare: true },
      );
    }

    const items = rs.rows
      .sort((a, b) => (a.name_lc || "").localeCompare(b.name_lc || ""))
      .map((r) => ({
        artist_id: r.artist_id,
        name: r.name,
        image_url: (() => {
          try {
            const arr = JSON.parse(r.images || "[]");
            return Array.isArray(arr) && arr[0]?.url ? arr[0].url : null;
          } catch {
            return null;
          }
        })(),
      }));

    return res.json(items);
  } catch (e) {
    logger.error("[api] searchArtistsPrefixSAI failed", {
      err: e?.message || e,
    });
    return res.status(500).json({ error: e?.message || "internal error" });
  }
}

module.exports = { searchArtists, searchArtistsExact, searchArtistsPrefixSAI };
