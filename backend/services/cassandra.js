// backend/services/cassandra.js
const cassandra = require("cassandra-driver");
const path = require("path");
const config = require("../configurations"); // central config (Vault + .env)
const logger = require("../configurations/logger");

let client;

/**
 * Returns a singleton Cassandra client using Astra DB SCB + token
 */
function getClient() {
  if (client) return client;

  if (!config.ASTRA_SCB_PATH) {
    throw new Error(
      "[cassandra] Missing ASTRA_SCB_PATH in config (path to Secure Connect Bundle)",
    );
  }
  if (!config.ASTRA_DB_TOKEN) {
    throw new Error(
      "[cassandra] Missing ASTRA_DB_TOKEN in config (AstraCS:...)",
    );
  }

  client = new cassandra.Client({
    cloud: { secureConnectBundle: path.resolve(config.ASTRA_SCB_PATH) },
    authProvider: new cassandra.auth.PlainTextAuthProvider(
      "token",
      config.ASTRA_DB_TOKEN,
    ),
    pooling: {
      coreConnectionsPerHost: {
        [cassandra.types.distance.local]: 1,
        [cassandra.types.distance.remote]: 1,
      },
    },
  });

  logger.debug(
    "[Cassandra] Client created with Vault backed config",
    {
      keyspace: config.ASTRA_DB_KEYSPACE,
      scbPath: config.ASTRA_SCB_PATH,
      endpoint: config.ASTRA_DB_ENDPOINT,
    },
  );

  return client;
}

/**
 * Ensures required tables exist in Astra DB
 */
async function ensureSchema() {
  const c = getClient();

  const ks = config.ASTRA_DB_KEYSPACE;

  const statements = [
    `
    CREATE TABLE IF NOT EXISTS ${ks}.users (
      user_id      text PRIMARY KEY,
      display_name text,
      external_urls text,
      followers    int,
      images       text,
      updated_at   timestamp
    )`,
    `
    CREATE TABLE IF NOT EXISTS ${ks}.playlists (
      playlist_id  text PRIMARY KEY,
      user_id      text,
      name         text,
      description  text,
      public       boolean,
      snapshot_id  text,
      track_count  int,
      images       text,
      updated_at   timestamp
    )`,
    `
    CREATE TABLE IF NOT EXISTS ${ks}.tracks (
      track_id     text PRIMARY KEY,
      title        text,
      duration_ms  int,
      explicit     boolean,
      popularity   int,
      isrc         text,
      album_id     text,
      album_name   text,
      artists      text,
      updated_at   timestamp
    )`,
    `
    CREATE TABLE IF NOT EXISTS ${ks}.playlist_tracks (
      playlist_id  text,
      position     int,
      track_id     text,
      added_at     timestamp,
      added_by     text,
      updated_at   timestamp,
      PRIMARY KEY ((playlist_id), position)
    )`,
  ];

  for (const cql of statements) {
    await c.execute(cql);
  }

  logger.debug(`[Cassandra] Schema ensured in keyspace=${ks}`);
}

module.exports = {
  getClient,
  ensureSchema,
  KEYSPACE: () => config.ASTRA_DB_KEYSPACE,
};
