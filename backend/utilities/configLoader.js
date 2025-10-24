const path = require("path");
const logger = require("../configurations/logger");

function loadConfig(modulePath) {
  try {
    const resolvedPath = require.resolve(modulePath);
    delete require.cache[resolvedPath];
    return require(modulePath);
  } catch (err) {
    logger.error(`❌ Failed to load config from ${modulePath}: ${err.message}`);
    return null;
  }
}

module.exports = { loadConfig };
