// backend/controllers/syncController.js (NEW file)
const config = require("../configurations");
const logger = require("../configurations/logger");

const { getClient, KEYSPACE, ensureSchema } = require("../services/cassandra");
const { makeSpotify, spCall, makeTimeBudget } = require("../services/spotify");
const { asJson, toTimestamp } = require("../utilities/json");
const { sleep } = require("../utilities/retry");

async function runSpotifySync(api) {
  const client = getClient();
  await ensureSchema();

  const withinBudget = makeTimeBudget(config.TIME_BUDGET_MS);

  // 1) User
  const meResp = await spCall("getMe", () => api.getMe());
  const me = meResp.body;

  const KS = KEYSPACE(); // resolve keyspace
  await client.execute(
    `
    INSERT INTO ${KS}.users (user_id, display_name, external_urls, followers, images, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    `,
    [
      me.id,
      me.display_name ?? null,
      asJson(me.external_urls),
      me.followers?.total ?? 0,
      asJson(me.images),
      new Date(),
    ],
    { prepare: true },
  );

  // 2) Playlists (paged + caps)
  const playlists = [];
  let offset = 0;
  let fetched = 0;

  while (true) {
    if (!withinBudget()) break;
    const page = await spCall("getUserPlaylists", () =>
      api.getUserPlaylists({ limit: config.PLAYLIST_LIMIT, offset }),
    );
    const items = page.body.items || [];
    playlists.push(...items);
    fetched += items.length;

    if (!page.body.next) break;
    if (
      config.MAX_PLAYLISTS_PER_RUN > 0 &&
      fetched >= config.MAX_PLAYLISTS_PER_RUN
    )
      break;

    offset += items.length;
    await sleep(150);
  }

  // Determine which need crawling (snapshot changed)
  const playlistsToCrawl = [];
  for (const p of playlists) {
    let existingSnapshot = null;
    try {
      const rs = await client.execute(
        `SELECT snapshot_id FROM ${KS}.playlists WHERE playlist_id = ?`,
        [p.id],
        { prepare: true },
      );
      if (rs.rowLength > 0) existingSnapshot = rs.rows[0]["snapshot_id"];
    } catch {}

    await client.execute(
      `
      INSERT INTO ${KS}.playlists
        (playlist_id, user_id, name, description, public, snapshot_id, track_count, images, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        p.id,
        me.id,
        p.name ?? null,
        p.description ?? null,
        !!p.public,
        p.snapshot_id ?? null,
        p.tracks?.total ?? 0,
        asJson(p.images),
        new Date(),
      ],
      { prepare: true },
    );

    if ((p.snapshot_id ?? "") !== (existingSnapshot ?? "")) {
      playlistsToCrawl.push(p);
    }
  }

  // 3) Tracks + mapping
  let totalPlaylistTracks = 0;

  for (const p of playlistsToCrawl) {
    if (!withinBudget()) break;

    let tOffset = 0;
    let pos = 0;
    let pages = 0;

    while (true) {
      if (!withinBudget()) break;
      if (
        config.MAX_TRACK_PAGES_PER_PLAYLIST > 0 &&
        pages >= config.MAX_TRACK_PAGES_PER_PLAYLIST
      )
        break;

      const page = await spCall("getPlaylistTracks", () =>
        api.getPlaylistTracks(p.id, {
          limit: config.TRACK_LIMIT,
          offset: tOffset,
        }),
      );
      const items = page.body.items || [];
      pages++;

      for (const item of items) {
        const tr = item.track;
        if (!tr) continue;

        await client.execute(
          `
          INSERT INTO ${KS}.tracks
            (track_id, title, duration_ms, explicit, popularity, isrc, album_id, album_name, artists, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            tr.id,
            tr.name ?? null,
            tr.duration_ms ?? null,
            !!tr.explicit,
            tr.popularity ?? null,
            tr.external_ids?.isrc ?? null,
            tr.album?.id ?? null,
            tr.album?.name ?? null,
            asJson((tr.artists || []).map((a) => ({ id: a.id, name: a.name }))),
            new Date(),
          ],
          { prepare: true },
        );

        await client.execute(
          `
          INSERT INTO ${KS}.playlist_tracks
            (playlist_id, position, track_id, added_at, added_by, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          `,
          [
            p.id,
            pos,
            tr.id,
            toTimestamp(item.added_at),
            item.added_by?.id ?? null,
            new Date(),
          ],
          { prepare: true },
        );

        pos++;
        totalPlaylistTracks++;
      }

      if (!page.body.next) break;
      tOffset += items.length;
      await sleep(150);
    }
  }

  return {
    user_id: me.id,
    playlists_cached: playlists.length,
    playlists_crawled: playlistsToCrawl.length,
    playlist_tracks_cached: totalPlaylistTracks,
  };
}

async function syncPost(req, res) {
  try {
    const api = makeSpotify({
      accessToken: req.session.accessToken,
      refreshToken: req.session.refreshToken,
    });
    const result = await runSpotifySync(api);
    res.json({ ok: true, ...result });
  } catch (e) {
    logger.error("Sync error:", e?.body || e);
    res.status(500).json({ ok: false, error: e?.body || e.toString() });
  }
}

async function syncRedirect(req, res) {
  try {
    const api = makeSpotify({
      accessToken: req.session.accessToken,
      refreshToken: req.session.refreshToken,
    });
    const result = await runSpotifySync(api);
    const qs = new URLSearchParams({
      synced: "1",
      pc: String(result.playlists_cached || 0),
      tc: String(result.playlist_tracks_cached || 0),
    }).toString();
    return res.redirect(`${config.FRONTEND_ORIGIN}/?${qs}`);
  } catch (e) {
    logger.error("Sync error:", e?.body || e);
    return res.redirect(`${config.FRONTEND_ORIGIN}/?synced=0`);
  }
}

module.exports = { syncPost, syncRedirect };
