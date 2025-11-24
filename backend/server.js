// backend/server.js
require("dotenv").config();

const http = require("node:http");

const { loadSpotifySecrets } = require("./services/spotify");
const { getClient, ensureSchema } = require("./services/cassandra");

const app = require("./app");

const config = require("./configurations");
const logger = require("./configurations/logger");

(async () => {
  try {
    logger.info(
      "Backend startup: loading Vault secrets, connecting Astra, ensuring schema, starting HTTP server",
    );

    // Make sure Vault based config (Astra) is loaded first
    if (config.ready && typeof config.ready.then === "function") {
      await config.ready;
    }

    // Now load Spotify secrets (which might also hit Vault)
    await loadSpotifySecrets();

    const client = getClient();
    await client.connect();
    await ensureSchema();

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
