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
    // Secrets + DB
    await loadSpotifySecrets();
    const client = getClient();
    await client.connect();
    await ensureSchema();

    // Listen
    const server = http.createServer(app);
    server.listen(config.PORT, () => {
      logger.info(`Backend listening on http://localhost:${config.PORT}`);
    });
  } catch (e) {
    logger.error("Startup failure:", e?.message || e);
    process.exit(1);
  }
})();
