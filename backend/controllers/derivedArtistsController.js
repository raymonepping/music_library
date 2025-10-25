// backend/controllers/derivedArtistsController.js
const crypto = require('node:crypto');
const { getClient, KEYSPACE } = require('../services/cassandra');
const logger = require('../configurations/logger');
const { createJob, updateJob, getJob, cancelJob } = require('../services/jobState');

/**
 * Sort options (extend as you add columns to artists):
 * - int: bucketed partitions, descending for metrics like popularity/followers
 * - text: partitioned directly by value, alphabetical inside
 */
const SORTS = {
  popularity: { column: 'popularity', type: 'int', order: 'DESC' },
  followers:  { column: 'followers',  type: 'int', order: 'DESC' },
  name:       { column: 'name_lc',    type: 'text', order: 'ASC'  },
  // language: { column: 'language',   type: 'text', order: 'ASC' }, // once you add it
};

/** Hash → bucket (to avoid hot partitions). */
function bucketFor(key, buckets = 10) {
  const s = String(key || '');
  const h = crypto.createHash('md5').update(s).digest().readUInt32BE(0);
  return h % buckets;
}

function pickThumb(imagesText, prefer = 160) {
  try {
    const arr = JSON.parse(imagesText || '[]');
    if (!Array.isArray(arr) || arr.length === 0) return null;
    let best = arr[0];
    let bestDelta = Math.abs((best.width || best.height || 9999) - prefer);
    for (const im of arr) {
      const w = im?.width || im?.height || prefer;
      const d = Math.abs(w - prefer);
      if (d < bestDelta) { best = im; bestDelta = d; }
    }
    return best?.url || null;
  } catch { return null; }
}

/** ── meta table to remember per-derived-table settings ─────────────── */
async function ensureMetaTable(client, ks) {
  const cql = `
    CREATE TABLE IF NOT EXISTS ${ks}.iterate_meta (
      table_name text PRIMARY KEY,
      buckets int,
      updated_at timestamp
    )`;
  await client.execute(cql);
}

async function upsertMeta(client, ks, tableName, buckets) {
  await ensureMetaTable(client, ks);
  await client.execute(
    `INSERT INTO ${ks}.iterate_meta (table_name, buckets, updated_at)
     VALUES (?, ?, toTimestamp(now()))`,
    [tableName, buckets],
    { prepare: true }
  );
}

async function readBucketsFromMeta(client, ks, tableName, fallback = 10) {
  await ensureMetaTable(client, ks);
  const rs = await client.execute(
    `SELECT buckets FROM ${ks}.iterate_meta WHERE table_name = ?`,
    [tableName],
    { prepare: true }
  );
  return Number(rs.first()?.buckets ?? fallback);
}

/** Build CREATE TABLE CQL dynamically. */
function buildCreateTableCql(ks, key, cfg) {
  const table = `${ks}.artists_by_${key}`;

  if (cfg.type === 'int') {
    return {
      table,
      cql: `
        CREATE TABLE IF NOT EXISTS ${table} (
          bucket int,
          ${cfg.column} int,
          name_lc text,
          artist_id text,
          name text,
          images text,
          PRIMARY KEY ((bucket), ${cfg.column}, name_lc, artist_id)
        ) WITH CLUSTERING ORDER BY (${cfg.column} ${cfg.order}, name_lc ASC, artist_id ASC)
      `,
      insert: `
        INSERT INTO ${table} (bucket, ${cfg.column}, name_lc, artist_id, name, images)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      kind: 'int'
    };
  }

  // text
  const isSelf = cfg.column === 'name_lc';
  if (isSelf) {
    // Partition directly by name_lc. Use artist_id for uniqueness.
    return {
      table,
      cql: `
        CREATE TABLE IF NOT EXISTS ${table} (
          name_lc text,
          artist_id text,
          name text,
          images text,
          PRIMARY KEY ((name_lc), artist_id)
        ) WITH CLUSTERING ORDER BY (artist_id ASC)
      `,
      insert: `
        INSERT INTO ${table} (name_lc, artist_id, name, images)
        VALUES (?, ?, ?, ?)
      `,
      kind: 'text-self'
    };
  }

  // Generic text column different from name_lc
  return {
    table,
    cql: `
      CREATE TABLE IF NOT EXISTS ${table} (
        ${cfg.column} text,
        name_lc text,
        artist_id text,
        name text,
        images text,
        PRIMARY KEY ((${cfg.column}), name_lc, artist_id)
      ) WITH CLUSTERING ORDER BY (name_lc ASC, artist_id ASC)
    `,
    insert: `
      INSERT INTO ${table} (${cfg.column}, name_lc, artist_id, name, images)
      VALUES (?, ?, ?, ?, ?)
    `,
    kind: 'text-other'
  };
}

/**
 * POST /iterate/build
 * body: { by: "popularity" | "followers" | "name", buckets?: number }
 * query: ?mode=rebuild  // optional, truncates the derived table first
 */
async function startBuild(req, res) {
  const client = getClient();
  const ks = KEYSPACE();

  const by = String(req.body?.by || '').trim().toLowerCase();
  const cfg = SORTS[by];
  if (!cfg) return res.status(400).json({ error: `Unsupported 'by'. Use: ${Object.keys(SORTS).join(', ')}` });

  const buckets = Math.max(parseInt(req.body?.buckets || '10', 10), 1);
  const mode = String(req.query?.mode || '').toLowerCase();

  try {
    // Create derived table + optionally truncate for rebuilds
    const { table, cql, insert } = buildCreateTableCql(ks, by, cfg);
    await client.execute(cql);
    if (mode === 'rebuild') {
      await client.execute(`TRUNCATE ${table}`);
    }

    // Record bucket count for this table (text sorts store 1)
    await upsertMeta(client, ks, table, cfg.type === 'int' ? buckets : 1);

    // Job
    const job = createJob(by);
    updateJob(job.id, { status: 'building' });

    // Fire-and-forget backfill
    (async () => {
      try {
        // Count total for progress
        const countRs = await client.execute(`SELECT COUNT(*) AS n FROM ${ks}.artists`);
        const total = Number(countRs.first()?.n || 0);
        updateJob(job.id, { total });

        const fetchSize = 500;
        let pageState = null;
        let inserted = 0;

        outer: do {
          const opts = { prepare: true, fetchSize };
          if (pageState) opts.pageState = pageState;

          const rs = await client.execute(
            `SELECT artist_id, name, name_lc, followers, popularity, images FROM ${ks}.artists`,
            [], opts
          );
          pageState = rs.pageState || null;

          for (const r of rs.rows) {
            const j = getJob(job.id);
            if (!j || j.canceled) {
              updateJob(job.id, { status: 'canceled', finishedAt: new Date().toISOString() });
              break outer; // ← stop both loops immediately
            }

            const name = r.name || null;
            const nameLc = r.name_lc || (name ? name.toLowerCase() : null);
            const colVal = r[cfg.column];

            if (cfg.type === 'int') {
              if (colVal == null) continue;
              const b = bucketFor(nameLc ?? r.artist_id, buckets);
              await client.execute(insert, [b, colVal, nameLc, r.artist_id, name, r.images || null], { prepare: true });
            } else {
              if (cfg.column === 'name_lc') {
                const v = nameLc || (r.name ? r.name.toLowerCase() : '');
                await client.execute(insert, [v, r.artist_id, name, r.images || null], { prepare: true });
              } else {
                const v = (colVal == null) ? '' : String(colVal);
                await client.execute(insert, [v, nameLc, r.artist_id, name, r.images || null], { prepare: true });
              }
            }

            inserted++;
            if (inserted % 250 === 0) updateJob(job.id, { inserted });
          }

          updateJob(job.id, { inserted });
        } while (pageState);

        const j = getJob(job.id);
        if (j && j.status !== 'canceled' && j.status !== 'error') {
          updateJob(job.id, { status: 'done', inserted, finishedAt: new Date().toISOString() });
          logger.info(`[iterate] build done by=${by}, inserted=${inserted}, table=${table}`);
        }
      } catch (err) {
        logger.error('[iterate] build failed', { err: err?.message || err });
        updateJob(job.id, { status: 'error', error: err?.message || String(err), finishedAt: new Date().toISOString() });
      }
    })();

    return res.status(202).json({
      job_id: job.id,
      by,
      status: 'building',
      started_at: job.startedAt
    });
  } catch (e) {
    logger.error('[iterate] startBuild failed', { err: e?.message || e });
    return res.status(500).json({ error: 'internal error' });
  }
}

/** GET /iterate/status/:id — poll progress */
function getStatus(req, res) {
  const id = req.params.id;
  const job = getJob(id);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const percent = job.total
    ? Math.min(100, Math.round((Number(job.inserted) / Number(job.total)) * 100))
    : (job.status === 'done' ? 100 : 0);

  return res.json({ ...job, percent });
}

/**
 * GET /iterate/top?by=popularity&limit=5
 * Quick preview/top: pulls across buckets (for int types) or directly (for text).
 */
async function getTop(req, res) {
  const client = getClient();
  const ks = KEYSPACE();

  const by = String(req.query.by || 'popularity').trim().toLowerCase();
  const cfg = SORTS[by];
  if (!cfg) return res.status(400).json({ error: `Unsupported 'by'. Use: ${Object.keys(SORTS).join(', ')}` });

  const limit = Math.min(parseInt(req.query.limit || '5', 10), 50);
  const table = `${ks}.artists_by_${by}`;

  try {
    if (cfg.type === 'int') {
      // use stored bucket count for this derived table
      const buckets = await readBucketsFromMeta(client, ks, table, 10);

      // pull small slices from several buckets and merge
      const perBucket = Math.max(Math.ceil(limit / 5), 5);
      const rows = [];
      for (let b = 0; b < buckets; b++) {
        const rs = await client.execute(
          `SELECT artist_id, name, images, ${cfg.column}, name_lc
           FROM ${table} WHERE bucket = ? LIMIT ?`,
          [b, perBucket],
          { prepare: true }
        );
        rows.push(...rs.rows);
      }
      rows.sort((a, b) => {
        const d = (b[cfg.column] ?? 0) - (a[cfg.column] ?? 0);
        if (d !== 0) return d;
        return String(a.name_lc || '').localeCompare(String(b.name_lc || ''));
      });
      const items = rows.slice(0, limit).map(r => ({
        artist_id: r.artist_id,
        name: r.name,
        value: r[cfg.column],
        image_url: pickThumb(r.images, 160)
      }));
      return res.json({ by, items, limit });
    }

    // text: just take first N from any partition (for preview)
    const rs = await client.execute(
      `SELECT artist_id, name, images, ${cfg.column} FROM ${table} LIMIT ?`,
      [limit],
      { prepare: true }
    );
    const items = rs.rows.map(r => ({
      artist_id: r.artist_id,
      name: r.name,
      value: r[cfg.column],
      image_url: pickThumb(r.images, 160)
    }));
    return res.json({ by, items, limit });
  } catch (e) {
    const msg = e?.message || String(e);
    logger.error('[iterate] getTop failed', { err: msg });
    if (msg.includes('does not exist')) {
      return res.status(404).json({ error: 'Derived table not found; run /iterate/build first' });
    }
    return res.status(500).json({ error: 'internal error' });
  }
}

function cancelJobRoute(req, res) {
  const id = req.params.id;
  const j = cancelJob(id);
  if (!j) return res.status(404).json({ error: 'job not found' });
  return res.json({ ok: true, id, canceled: j.canceled });
}

module.exports = {
  listColumns: async (req, res) => {
    try {
      const items = Object.entries(SORTS).map(([key, cfg]) => ({
        key, column: cfg.column, type: cfg.type, order: cfg.order
      }));
      res.json(items);
    } catch (e) {
      logger.error('[iterate] listColumns failed', { err: e?.message || e });
      res.status(500).json({ error: 'internal error' });
    }
  },
  startBuild,
  getStatus,
  getTop,
  cancelJobRoute,
};
