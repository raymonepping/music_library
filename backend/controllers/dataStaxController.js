// backend/controllers/dbController.js
const { getClient, KEYSPACE } = require("../services/cassandra");
const logger = require("../configurations/logger");

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function meFromDb(req, res) {
  try {
    const client = getClient();
    const KS = KEYSPACE();
    // Single-user project: grab any user (first row)
    const rs = await client.execute(
      `SELECT user_id, display_name, external_urls, followers, images FROM ${KS}.users LIMIT 1`,
    );
    if (rs.rowLength === 0) {
      return res
        .status(404)
        .json({ error: "No user found. Run a sync first." });
    }
    const row = rs.rows[0];
    const images = parseJson(row.images) || [];
    const external_urls = parseJson(row.external_urls) || {};
    const me = {
      id: row.user_id,
      display_name: row.display_name,
      followers: { total: row.followers ?? 0 },
      images,
      external_urls,
    };
    res.json(me);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}

async function playlistsFromDb(req, res) {
  try {
    const client = getClient();
    const KS = KEYSPACE();

    // We need the user's playlists; get user_id same way as in meFromDb
    const userRs = await client.execute(
      `SELECT user_id FROM ${KS}.users LIMIT 1`,
    );
    if (userRs.rowLength === 0) {
      return res.json([]); // no data yet
    }
    const userId = userRs.rows[0].user_id;

    const rs = await client.execute(
      `SELECT playlist_id, name, description, public, snapshot_id, track_count, images 
       FROM ${KS}.playlists WHERE user_id = ? ALLOW FILTERING`,
      [userId],
      { prepare: true },
    );

    const items = rs.rows.map((r) => {
      const images = parseJson(r.images) || [];
      return {
        id: r.playlist_id,
        name: r.name,
        description: r.description,
        public: !!r.public,
        snapshot_id: r.snapshot_id,
        tracks: { total: r.track_count ?? 0 },
        images,
      };
    });

    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}

module.exports = { meFromDb, playlistsFromDb };
