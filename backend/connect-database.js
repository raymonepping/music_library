// connect-database.js
const cassandra = require("cassandra-driver");
const path = require("path");
const logger = require("../configurations/logger");

// ABSOLUTE path to your SCB (adjust to your real path)
const SCB_PATH = path.resolve(
  "/Users/raymon.epping/Documents/VSC/MacOS_Environment/music_library/backend/secure-connect-intergallactic-db.zip",
);

// Use token auth: username MUST be "token", password is the full AstraCS token
const client = new cassandra.Client({
  cloud: { secureConnectBundle: SCB_PATH },
  authProvider: new cassandra.auth.PlainTextAuthProvider(
    "token",
    process.env.APPLICATION_TOKEN,
  ),
  // optional: keyspace: 'planetary',
});

async function run() {
  try {
    await client.connect();
    const rs = await client.execute("SELECT * FROM system.local");
    logger.info(`Your cluster returned ${rs.rowLength} row(s)`);
  } finally {
    await client.shutdown();
  }
}

run().catch((err) => {
  logger.error("Connection failed:", err);
  process.exit(1);
});
