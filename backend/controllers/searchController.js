// backend/controllers/searchController.js
const { getClient, KEYSPACE } = require("../services/cassandra");
const logger = require("../configurations/logger");

function normalizeTerm(s) {
  return (s || "").trim().toLowerCase();
}

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
      // align with your fanout 2..3, we normalize to 3 for the partition key
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
      error: "Use ?name= for exact case-insensitive or ?prefix= with 2+ chars",
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}

async function searchArtistsPrefixSAI(req, res) {
  const client = getClient();
  const ks = KEYSPACE();
  const raw = req.query.q || "";
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 200);
  const q = normalizeTerm(raw);

  if (!q) return res.json([]);

  // Range to emulate prefix: [q .. q + U+FFFF]
  const start = q;
  const end = `${q}\uffff`;

  try {
    const rs = await client.execute(
      `
      SELECT artist_id, name, name_lc, images
      FROM ${ks}.artists
      WHERE name_lc >= ? AND name_lc < ?
      LIMIT ?
      `,
      [start, end, limit],
      { prepare: true },
    );

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
    return res.status(500).json({ error: "internal error" });
  }
}

module.exports = { searchArtists, searchArtistsPrefixSAI };
