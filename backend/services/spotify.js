// backend/services/spotify.js (NEW file)
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

// Minimal Vault KV v2 reader using global fetch
async function readKvV2({ addr, token, mount, path }) {
  const url = `${addr}/v1/${mount}/data/${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: { "X-Vault-Token": token } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vault read failed ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json && json.data && json.data.data ? json.data.data : {};
}

async function loadSpotifySecrets() {
  if (SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET) return;

  if (!config.VAULT_ADDR || !config.VAULT_TOKEN) {
    throw new Error(
      "Missing CLIENT_ID/CLIENT_SECRET and VAULT_ADDR/VAULT_TOKEN. Set env or provide Vault token with read on kv/music.",
    );
  }

  const data = await readKvV2({
    addr: config.VAULT_ADDR,
    token: config.VAULT_TOKEN,
    mount: config.VAULT_KV_MOUNT,
    path: config.VAULT_SPOTIFY_PATH,
  });

  SPOTIFY_CLIENT_ID = data.CLIENT_ID || data.client_id || "";
  SPOTIFY_CLIENT_SECRET = data.CLIENT_SECRET || data.client_secret || "";

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error(
      "Spotify creds not found at kv/music (CLIENT_ID, CLIENT_SECRET).",
    );
  }
}

function makeSpotify({ accessToken, refreshToken }) {
  const api = new SpotifyWebApi({
    clientId: SPOTIFY_CLIENT_ID,
    clientSecret: SPOTIFY_CLIENT_SECRET,
    redirectUri: config.SPOTIFY_REDIRECT_URI,
  });
  if (accessToken) api.setAccessToken(accessToken);
  if (refreshToken) api.setRefreshToken(refreshToken);
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
