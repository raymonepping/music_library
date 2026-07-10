// backend/services/astraSecrets.js
const { createVaultClient } = require("./vaultClient");
const logger = require("../configurations/logger");

let astraSecrets = null;
let initialized = false;

function requireEnv(name, optional) {
  const value = process.env[name];
  if (!value && !optional) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Initialize Astra secrets by reading ciphertext from KV v2
 * and decrypting via Transit.
 *
 * Environment variables used:
 *   VAULT_ADDR           (required)
 *   VAULT_TOKEN          (required, or injected via Vault Agent)
 *   VAULT_NAMESPACE      (optional)
 *   VAULT_KV_MOUNT       (optional, default "kv")
 *   VAULT_TRANSIT_KEY    (optional, default "astra-transit")
 *   VAULT_ASTRA_KV_PATH  (optional, default "astra")
 */
async function initAstraSecrets() {
  if (initialized && astraSecrets) {
    return astraSecrets;
  }

  const addr = requireEnv("VAULT_ADDR");
  const token = requireEnv("VAULT_TOKEN");
  const namespace = requireEnv("VAULT_NAMESPACE", true);
  const kvMount = process.env.VAULT_KV_MOUNT || "kv";
  const transitKey = process.env.VAULT_TRANSIT_KEY || "astra-transit";
  const kvPath = process.env.VAULT_ASTRA_KV_PATH || "astra";

  logger.info(
    `Loading Astra tokens from Vault: addr=${addr}, kvMount=${kvMount}, kvPath=${kvPath}, transitKey=${transitKey}`,
  );

  const client = createVaultClient({
    addr,
    token,
    namespace,
    kvMount,
    transitKey,
  });

  const { ASTRA_DB_APPLICATION_TOKEN, ASTRA_DB_TOKEN } =
    await client.getAstraTokens(kvPath);

  astraSecrets = {
    ASTRA_DB_APPLICATION_TOKEN,
    ASTRA_DB_TOKEN,
  };

  // Inject into env so existing Cassandra code that reads process.env keeps working
  if (!process.env.ASTRA_DB_APPLICATION_TOKEN) {
    process.env.ASTRA_DB_APPLICATION_TOKEN = ASTRA_DB_APPLICATION_TOKEN;
  }
  if (!process.env.ASTRA_DB_TOKEN) {
    process.env.ASTRA_DB_TOKEN = ASTRA_DB_TOKEN;
  }

  logger.info(
    `Astra tokens loaded from Vault via Transit. Token lengths: app=${ASTRA_DB_APPLICATION_TOKEN.length}, db=${ASTRA_DB_TOKEN.length}`,
  );


  initialized = true;
  return astraSecrets;
}

function getAstraSecrets() {
  if (!astraSecrets) {
    throw new Error("Astra secrets not initialized yet. Call initAstraSecrets() first.");
  }
  return astraSecrets;
}

module.exports = {
  initAstraSecrets,
  getAstraSecrets,
};
