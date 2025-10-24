// backend/config/index.js
require("dotenv").config();
const logger = require("./logger"); // <-- use your Winston logger
const fetch = global.fetch || require("node-fetch"); // Node 18+ has fetch built-in

// Swagger
const swaggerUi = require("swagger-ui-express");
const swaggerDocs = require("./swaggerOptions");

const {
  PORT = 3002,
  SESSION_SECRET = "dev",
  FRONTEND_ORIGIN = "http://localhost:8075",

  // Spotify
  SPOTIFY_REDIRECT_URI = "http://localhost:3002/auth/callback",
  CLIENT_ID = "",
  CLIENT_SECRET = "",

  // Vault (optional)
  VAULT_ADDR,
  VAULT_TOKEN,
  VAULT_KV_MOUNT = "kv",
  VAULT_SPOTIFY_PATH = "music",
  VAULT_DATASTAX_PATH = "datastax",

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

// ---- Minimal KV reader ----
async function readKvV2({ addr, token, mount, path }) {
  const url = `${addr}/v1/${mount}/data/${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: { "X-Vault-Token": token } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vault read failed ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json?.data?.data || {};
}

// ---- Config object ----
const config = {
  PORT: Number(PORT),
  SESSION_SECRET,
  FRONTEND_ORIGIN,

  SPOTIFY_REDIRECT_URI,
  CLIENT_ID,
  CLIENT_SECRET,

  VAULT_ADDR,
  VAULT_TOKEN,
  VAULT_KV_MOUNT,
  VAULT_SPOTIFY_PATH,
  VAULT_DATASTAX_PATH,

  PLAYLIST_LIMIT: Number(SYNC_PLAYLIST_PAGE_LIMIT),
  TRACK_LIMIT: Number(SYNC_TRACK_PAGE_LIMIT),
  MAX_PLAYLISTS_PER_RUN: Number(SYNC_MAX_PLAYLISTS_PER_RUN),
  MAX_TRACK_PAGES_PER_PLAYLIST: Number(SYNC_MAX_TRACK_PAGES_PER_PLAYLIST),
  TIME_BUDGET_MS: Number(SYNC_TIME_BUDGET_MS),

  // placeholders for Astra values
  APPLICATION_TOKEN: process.env.APPLICATION_TOKEN,
  ASTRA_DB_ID: process.env.ASTRA_DB_ID,
  ASTRA_DB_REGION: process.env.ASTRA_DB_REGION,
  ASTRA_DB_KEYSPACE: process.env.ASTRA_DB_KEYSPACE,
  ASTRA_SCB_PATH: process.env.ASTRA_SCB_PATH,

  // Extra configs
  loggerConfig: require("./logger"),
  swaggerOptions: require("./swaggerOptions"),
};

// ---- Load Datastax creds from Vault ----
async function loadDatastaxFromVault() {
  if (!config.VAULT_ADDR || !config.VAULT_TOKEN) {
    logger.warn(
      "[config] VAULT_ADDR/VAULT_TOKEN missing, skipping Vault secrets.",
    );
    return;
  }

  try {
    const data = await readKvV2({
      addr: config.VAULT_ADDR,
      token: config.VAULT_TOKEN,
      mount: config.VAULT_KV_MOUNT,
      path: config.VAULT_DATASTAX_PATH,
    });

    config.APPLICATION_TOKEN =
      data.APPLICATION_TOKEN ||
      data.ASTRA_DB_APPLICATION_TOKEN ||
      data.ASTRA_DB_TOKEN ||
      config.APPLICATION_TOKEN;

    config.ASTRA_DB_ID = data.ASTRA_DB_ID || config.ASTRA_DB_ID;
    config.ASTRA_DB_REGION = data.ASTRA_DB_REGION || config.ASTRA_DB_REGION;
    config.ASTRA_DB_KEYSPACE =
      data.ASTRA_DB_KEYSPACE || data.KEYSPACE_NAME || config.ASTRA_DB_KEYSPACE;
    config.ASTRA_SCB_PATH = data.ASTRA_SCB_PATH || config.ASTRA_SCB_PATH;

    // Debug log Vault-loaded values
    if (LOG_LEVEL === "debug" || DEBUG === "true") {
      logger.debug("[Vault] Loaded Astra DB KV values", {
        ASTRA_DB_ID: config.ASTRA_DB_ID,
        ASTRA_DB_REGION: config.ASTRA_DB_REGION,
        ASTRA_DB_KEYSPACE: config.ASTRA_DB_KEYSPACE,
        ASTRA_SCB_PATH: config.ASTRA_SCB_PATH,
        APPLICATION_TOKEN: config.APPLICATION_TOKEN
          ? config.APPLICATION_TOKEN.substring(0, 12) + "..."
          : null, // avoid dumping full token
      });
    }
  } catch (e) {
    logger.error(
      `[config] Failed to load Datastax secrets from Vault: ${e.message}`,
    );
  }
}

config.ready = (async () => {
  await loadDatastaxFromVault();
})();

module.exports = config;
