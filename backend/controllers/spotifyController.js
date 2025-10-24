// backend/controllers/spotifyController.js (NEW file)
const { makeSpotify, spCall } = require("../services/spotify");

async function me(req, res) {
  try {
    const api = makeSpotify({
      accessToken: req.session.accessToken,
      refreshToken: req.session.refreshToken,
    });
    const r = await spCall("getMe", () => api.getMe());
    res.json(r.body);
  } catch (e) {
    res.status(500).json({ error: e?.body || String(e) });
  }
}

async function playlists(req, res) {
  try {
    const api = makeSpotify({
      accessToken: req.session.accessToken,
      refreshToken: req.session.refreshToken,
    });
    const items = [];
    let offset = 0;
    while (true) {
      const page = await spCall("getUserPlaylists", () =>
        api.getUserPlaylists({ limit: 50, offset }),
      );
      items.push(...(page.body.items || []));
      if (!page.body.next) break;
      offset += (page.body.items || []).length;
    }
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e?.body || String(e) });
  }
}

async function playlistTracks(req, res) {
  try {
    const api = makeSpotify({
      accessToken: req.session.accessToken,
      refreshToken: req.session.refreshToken,
    });
    const items = [];
    let offset = 0;
    while (true) {
      const page = await spCall("getPlaylistTracks", () =>
        api.getPlaylistTracks(req.params.id, { limit: 100, offset }),
      );
      items.push(...(page.body.items || []));
      if (!page.body.next) break;
      offset += (page.body.items || []).length;
    }
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e?.body || String(e) });
  }
}

module.exports = { me, playlists, playlistTracks };
