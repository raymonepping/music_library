// backend/middleware/ensureToken.js (NEW file)
const { makeSpotify } = require("../services/spotify");
const logger = require("../configurations/logger");

module.exports = async function ensureToken(req, res, next) {
  try {
    const exp = req.session.expiresAt || 0;
    if (!req.session.accessToken || Date.now() > exp) {
      if (!req.session.refreshToken) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      const api = makeSpotify({
        accessToken: req.session.accessToken,
        refreshToken: req.session.refreshToken,
      });
      const { body } = await api.refreshAccessToken();
      req.session.accessToken = body.access_token;
      req.session.expiresAt = Date.now() + body.expires_in * 1000;
    }
    next();
  } catch (e) {
    logger.error("Refresh error:", e?.body || e);
    return res.status(401).json({ error: "Re-auth required" });
  }
};
