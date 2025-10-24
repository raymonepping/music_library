// backend/controllers/statsController.js
const { getClient, KEYSPACE } = require("../services/cassandra");
const logger = require("../configurations/logger");

async function countSimple(query, params = []) {
  const client = getClient();
  try {
    const rs = await client.execute(query, params, { prepare: true });
    const r = rs.first();
    // COUNT(*) comes back as Long in cassandra-driver; coerce to number safely if small
    const v = r?.count || r?.count_star || r?.cnt;
    if (v == null) return null;
    return typeof v.toNumber === "function" ? v.toNumber() : Number(v);
  } catch (e) {
    logger.warn("[stats] countSimple failed", { err: e?.message || e, query });
    return null;
  }
}

// Deep scan (paged) to count non-null embeddings.
// This is O(table) but fine for your current scale; uses paging under the hood.
async function countArtistsWithEmbeddingDeep(fetchSize = 1000) {
  const client = getClient();
  const ks = KEYSPACE();

  let pageState = null;
  let total = 0;

  do {
    const opts = { fetchSize, prepare: true };
    if (pageState) opts.pageState = pageState;

    const rs = await client.execute(
      `SELECT artist_id, embedding FROM ${ks}.artists`,
      [],
      opts,
    );

    for (const row of rs.rows) {
      const e = row.embedding;
      if (e && e !== "null" && e !== "[]") total++;
    }
    pageState = rs.pageState || null;
  } while (pageState);

  return total;
}

async function stats(req, res) {
  const client = getClient();
  const ks = KEYSPACE();
  const deep = String(req.query.deep || "").toLowerCase() === "1";

  // quick counts (fast); if your dataset grows massive, you may want to cache these.
  const [
    artists_total,
    albums_total,
    albums_by_artist_rows,
    artists_by_prefix_rows,
    tracks_total,
  ] = await Promise.all([
    countSimple(`SELECT COUNT(*) AS count FROM ${ks}.artists`),
    countSimple(`SELECT COUNT(*) AS count FROM ${ks}.albums`),
    countSimple(`SELECT COUNT(*) AS count FROM ${ks}.albums_by_artist`),
    countSimple(`SELECT COUNT(*) AS count FROM ${ks}.artists_by_prefix`),
    countSimple(`SELECT COUNT(*) AS count FROM ${ks}.tracks`),
  ]);

  let artists_with_embedding = null;
  let artists_with_embedding_pct = null;

  if (deep) {
    try {
      artists_with_embedding = await countArtistsWithEmbeddingDeep(2000);
      if (artists_total && artists_total > 0) {
        artists_with_embedding_pct =
          Math.round((artists_with_embedding / artists_total) * 1000) / 10; // one decimal
      }
    } catch (e) {
      logger.warn("[stats] deep embedding count failed", {
        err: e?.message || e,
      });
    }
  }

  res.json({
    artists_total,
    artists_with_embedding,
    artists_with_embedding_pct,
    albums_total,
    albums_by_artist_rows,
    artists_by_prefix_rows,
    tracks_total,
    generated_at: new Date().toISOString(),
  });
}

module.exports = { stats };
