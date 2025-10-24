// backend/controllers/authController.js (NEW file)
const config = require("../configurations");
const logger = require("../configurations/logger");

const { makeSpotify, SCOPES } = require("../services/spotify");

function login(req, res) {
  const api = makeSpotify({});
  const url = api.createAuthorizeURL(SCOPES, "state123");
  res.redirect(url);
}

async function callback(req, res) {
  const api = makeSpotify({});
  try {
    const code = req.query.code;
    const { body } = await api.authorizationCodeGrant(code);
    req.session.accessToken = body.access_token;
    req.session.refreshToken = body.refresh_token;
    req.session.expiresAt = Date.now() + body.expires_in * 1000;
    res.redirect("/");
  } catch (e) {
    logger.error("Auth error:", e?.body || e);
    res.status(500).send("Auth failed");
  }
}

function logout(req, res) {
  req.session.destroy(() => res.redirect("/"));
}

function health(req, res) {
  res.json({
    ok: true,
    spotifyConfigured: true,
    redirectUri: config.SPOTIFY_REDIRECT_URI,
  });
}

module.exports = { login, callback, logout, health };
