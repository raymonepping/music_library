// backend/server.js
require("dotenv").config();

const http = require("node:http");

const { loadSpotifySecrets } = require("./services/spotify");
const { getClient, ensureSchema } = require("./services/cassandra");
const { initAstraSecrets } = require("./services/astraSecrets");

const app = require("./app");

const config = require("./configurations");
const logger = require("./configurations/logger");

(async () => {
  try {
    logger.info(
      "Backend startup: loading Vault secrets, connecting Astra, ensuring schema, starting HTTP server",
    );

    // 1. Existing configuration bootstrap (legacy, still in use)
    if (config.ready && typeof config.ready.then === "function") {
      logger.info("Waiting for legacy config.ready to complete...");
      await config.ready;
      logger.info("Legacy config.ready completed");
    }

    // 2. Load Astra Vault secrets using Transit and inject into process.env
    logger.info("Initializing Astra secrets from Vault via Transit...");
    await initAstraSecrets();
    logger.info("Astra secrets successfully initialized");

    // 3. Load Spotify secrets (which might also use Vault)
    await loadSpotifySecrets();

    // 4. Connect to Cassandra and ensure schema
    const client = getClient();
    await client.connect();
    await ensureSchema();

    // 5. Start HTTP server
    const server = http.createServer(app);
    server.listen(config.PORT, () => {
      logger.info(`Backend listening on http://localhost:${config.PORT}`);
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("RAW startup error:", e);
    const details = e && e.stack ? e.stack : e;
    logger.error(`Startup failure: ${details}`);
    process.exit(1);
  }
})();
