// backend/config/index.js
require("dotenv").config();
const logger = require("./logger");

// Use our shared Vault client
const { createVaultClient } = require("../services/vaultClient");

// Swagger
const swaggerDocs = require("./swaggerOptions");

const {
  PORT = 3002,
  SESSION_SECRET = "dev",
  FRONTEND_ORIGIN = "http://localhost:8075",

  // Spotify (env are now fallbacks only)
  SPOTIFY_REDIRECT_URI = "http://localhost:3002/auth/callback",
  CLIENT_ID = "",
  CLIENT_SECRET = "",
  SPOTIFY_REFRESH_TOKEN = "",
  HUGGING_FACE_API_KEY = "",

  // Vault
  VAULT_ADDR,
  VAULT_TOKEN,
  VAULT_KV_MOUNT = "kv",
  VAULT_SPOTIFY_PATH = "music",
  VAULT_DATASTAX_PATH = "datastax",
  VAULT_NAMESPACE,

  // Sync tunables
  SYNC_PLAYLIST_PAGE_LIMIT = 25,
  SYNC_TRACK_PAGE_LIMIT = 100,
  SYNC_MAX_PLAYLISTS_PER_RUN = 200,
  SYNC_MAX_TRACK_PAGES_PER_PLAYLIST = 10,
  SYNC_TIME_BUDGET_MS = 60000,

  // Logging / debug
  LOG_LEVEL = "info",
  DEBUG = "false",
} = process.env;

// Shared Vault client instance (lazy)
let vaultClient = null;

function getVaultClient() {
  if (!VAULT_ADDR || !VAULT_TOKEN) {
    logger.warn(
      "[config] VAULT_ADDR/VAULT_TOKEN missing, Vault-backed config will be skipped.",
    );
    return null;
  }

  if (!vaultClient) {
    vaultClient = createVaultClient({
      addr: VAULT_ADDR,
      token: VAULT_TOKEN,
      namespace: VAULT_NAMESPACE,
      kvMount: VAULT_KV_MOUNT,
      // Transit key not used here (only KV), but we keep a sane default
      transitKey: process.env.VAULT_TRANSIT_KEY || "astra-transit",
    });
  }

  return vaultClient;
}

// ---- Config object ----
const config = {
  PORT: Number(PORT),
  SESSION_SECRET,
  FRONTEND_ORIGIN,

  // Spotify + HF
  SPOTIFY_REDIRECT_URI,
  CLIENT_ID,
  CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN,
  HUGGING_FACE_API_KEY,

  // Vault
  VAULT_ADDR,
  VAULT_TOKEN,
  VAULT_KV_MOUNT,
  VAULT_SPOTIFY_PATH,
  VAULT_DATASTAX_PATH,
  VAULT_NAMESPACE,

  PLAYLIST_LIMIT: Number(SYNC_PLAYLIST_PAGE_LIMIT),
  TRACK_LIMIT: Number(SYNC_TRACK_PAGE_LIMIT),
  MAX_PLAYLISTS_PER_RUN: Number(SYNC_MAX_PLAYLISTS_PER_RUN),
  MAX_TRACK_PAGES_PER_PLAYLIST: Number(SYNC_MAX_TRACK_PAGES_PER_PLAYLIST),
  TIME_BUDGET_MS: Number(SYNC_TIME_BUDGET_MS),

  // Astra values
  // Tokens now come from Transit via initAstraSecrets().
  // These envs are only fallbacks / metadata.
  ASTRA_DB_TOKEN: process.env.ASTRA_DB_TOKEN || process.env.APPLICATION_TOKEN,
  APPLICATION_TOKEN:
    process.env.APPLICATION_TOKEN || process.env.ASTRA_DB_TOKEN,
  ASTRA_DB_ID: process.env.ASTRA_DB_ID,
  ASTRA_DB_REGION: process.env.ASTRA_DB_REGION,
  ASTRA_DB_KEYSPACE: process.env.ASTRA_DB_KEYSPACE,
  ASTRA_SCB_PATH: process.env.ASTRA_SCB_PATH,
  ASTRA_DB_ENDPOINT: process.env.ASTRA_DB_ENDPOINT,

  // Extra configs
  loggerConfig: require("./logger"),
  swaggerOptions: swaggerDocs,
};

// ---- Load Datastax metadata from Vault (no tokens here anymore) ----
async function loadDatastaxFromVault() {
  const client = getVaultClient();
  if (!client) {
    return;
  }

  try {
    const data = await client.readKvV2(VAULT_DATASTAX_PATH);

    // Do NOT override the Astra token here anymore.
    // Transit + initAstraSecrets is now the source of truth.

    config.ASTRA_DB_ID = data.ASTRA_DB_ID || config.ASTRA_DB_ID;
    config.ASTRA_DB_REGION = data.ASTRA_DB_REGION || config.ASTRA_DB_REGION;
    config.ASTRA_DB_KEYSPACE =
      data.ASTRA_DB_KEYSPACE || data.KEYSPACE_NAME || config.ASTRA_DB_KEYSPACE;
    config.ASTRA_SCB_PATH = data.ASTRA_SCB_PATH || config.ASTRA_SCB_PATH;
    config.ASTRA_DB_ENDPOINT =
      data.ASTRA_DB_ENDPOINT || config.ASTRA_DB_ENDPOINT;

    logger.debug(
      `[Vault] ASTRA_DB_ENDPOINT from KV: ${
        config.ASTRA_DB_ENDPOINT || "not set"
      }`,
    );

    if (LOG_LEVEL === "debug" || DEBUG === "true") {
      logger.debug("[Vault] Loaded Astra DB KV values", {
        ASTRA_DB_ID: config.ASTRA_DB_ID,
        ASTRA_DB_REGION: config.ASTRA_DB_REGION,
        ASTRA_DB_KEYSPACE: config.ASTRA_DB_KEYSPACE,
        ASTRA_SCB_PATH: config.ASTRA_SCB_PATH,
        ASTRA_DB_ENDPOINT: config.ASTRA_DB_ENDPOINT,
      });
    }
  } catch (e) {
    logger.error(
      `[config] Failed to load Datastax metadata from Vault: ${e.message}`,
    );
  }
}

// ---- Load Spotify + HF creds from Vault (still KV) ----
async function loadSpotifyFromVault() {
  const client = getVaultClient();
  if (!client) {
    return;
  }

  try {
    const data = await client.readKvV2(VAULT_SPOTIFY_PATH);

    config.CLIENT_ID = data.CLIENT_ID || data.client_id || config.CLIENT_ID;
    config.CLIENT_SECRET =
      data.CLIENT_SECRET || data.client_secret || config.CLIENT_SECRET;
    config.SPOTIFY_REDIRECT_URI =
      data.SPOTIFY_REDIRECT_URI || config.SPOTIFY_REDIRECT_URI;
    config.SPOTIFY_REFRESH_TOKEN =
      data.SPOTIFY_REFRESH_TOKEN || config.SPOTIFY_REFRESH_TOKEN;

    config.HUGGING_FACE_API_KEY =
      data.HUGGING_FACE_API_KEY || config.HUGGING_FACE_API_KEY;

    if (LOG_LEVEL === "debug" || DEBUG === "true") {
      logger.debug("[Vault] Loaded Spotify KV values", {
        CLIENT_ID: config.CLIENT_ID
          ? `${config.CLIENT_ID.substring(0, 8)}...`
          : null,
        hasClientSecret: Boolean(config.CLIENT_SECRET),
        SPOTIFY_REDIRECT_URI: config.SPOTIFY_REDIRECT_URI,
        hasRefreshToken: Boolean(config.SPOTIFY_REFRESH_TOKEN),
        hasHuggingFaceKey: Boolean(config.HUGGING_FACE_API_KEY),
      });
    }
  } catch (e) {
    logger.error(
      `[config] Failed to load Spotify secrets from Vault: ${e.message}`,
    );
  }
}

// Kick off Vault load at startup
config.ready = (async () => {
  await loadDatastaxFromVault();
  await loadSpotifyFromVault();
})();

module.exports = config;
