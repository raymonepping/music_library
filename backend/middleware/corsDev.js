// backend/middleware/corsDev.js (NEW file)
const config = require("../configurations");

module.exports = (req, res, next) => {
  res.header("Access-Control-Allow-Origin", config.FRONTEND_ORIGIN);
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
};
