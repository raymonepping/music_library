// backend/services/spotify.js
const SpotifyWebApi = require("spotify-web-api-node");
const config = require("../configurations");
const logger = require("../configurations/logger");
const {
  sleep,
  makeTimeBudget,
  isRetriableError,
  retryAfterMs,
} = require("../utilities/retry");

let SPOTIFY_CLIENT_ID = config.CLIENT_ID;
let SPOTIFY_CLIENT_SECRET = config.CLIENT_SECRET;

const SCOPES = [
  "playlist-read-private",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-library-read",
  "user-library-modify",
];

async function loadSpotifySecrets() {
  // Make sure Vault-backed config has been initialised
  if (config.ready && typeof config.ready.then === "function") {
    await config.ready;
  }

  SPOTIFY_CLIENT_ID = config.CLIENT_ID;
  SPOTIFY_CLIENT_SECRET = config.CLIENT_SECRET;

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error(
      "Spotify CLIENT_ID / CLIENT_SECRET are not set. Check Vault kv/music or env.",
    );
  }

  logger.debug("[Spotify] Loaded client config from Vault-backed settings", {
    CLIENT_ID: `${SPOTIFY_CLIENT_ID.substring(0, 8)}...`,
    hasClientSecret: Boolean(SPOTIFY_CLIENT_SECRET),
    SPOTIFY_REDIRECT_URI: config.SPOTIFY_REDIRECT_URI,
    hasRefreshToken: Boolean(config.SPOTIFY_REFRESH_TOKEN),
  });
}

function makeSpotify({ accessToken, refreshToken } = {}) {
  const api = new SpotifyWebApi({
    clientId: SPOTIFY_CLIENT_ID,
    clientSecret: SPOTIFY_CLIENT_SECRET,
    redirectUri: config.SPOTIFY_REDIRECT_URI,
  });

  if (accessToken) api.setAccessToken(accessToken);

  const effectiveRefreshToken =
    refreshToken || config.SPOTIFY_REFRESH_TOKEN || null;
  if (effectiveRefreshToken) {
    api.setRefreshToken(effectiveRefreshToken);
  }

  return api;
}

// Generic Spotify call wrapper with retries/backoff
async function spCall(label, fn, maxRetries = 5) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetriableError(e) || attempt === maxRetries) {
        logger.error(`Spotify call failed [${label}] (final)`, {
          error: e?.body || e,
        });
        throw e;
      }
      const wait = retryAfterMs(e, attempt);
      logger.warn(
        `Spotify call retrying [${label}] attempt ${attempt + 1}/${maxRetries} in ${wait}ms`,
        {
          error: e?.body || e,
        },
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

module.exports = {
  SCOPES,
  loadSpotifySecrets,
  makeSpotify,
  spCall,
  makeTimeBudget,
};
