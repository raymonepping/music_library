// backend/middleware/corsDev.js
const config = require("../configurations");

const explicitAllowedOrigins = [
  "http://localhost:3002",
  "http://localhost:8075",
  "http://0.0.0.0:8075",
  "http://0.0.0.0:8095",
  "http://localhost:8095",
];

// Build a set so we can avoid duplicates and include FRONTEND_ORIGIN if set
const allowedOrigins = new Set(
  [
    ...explicitAllowedOrigins,
    config.FRONTEND_ORIGIN, // from .env, e.g. http://localhost:8075
  ].filter(Boolean),
);

module.exports = (req, res, next) => {
  const origin = req.headers.origin;

  // Debug once while testing
  // console.log("[CORS] origin =", origin, "allowed =", Array.from(allowedOrigins));

  if (origin && allowedOrigins.has(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }

  res.header("Access-Control-Allow-Credentials", "true");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With",
  );
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");

  if (req.method === "OPTIONS") return res.sendStatus(204);

  next();
};
