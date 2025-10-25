const path = require("path");
const express = require("express");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const compression = require("compression"); // ← ADD
const config = require("./configurations");
const logger = require("./configurations/logger");
const corsDev = require("./middleware/corsDev");
const routes = require("./routes");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./configurations/swaggerOptions");

const app = express();

// ────────────────────────────────
// Core middleware
// ────────────────────────────────
app.disable("x-powered-by");
app.set("etag", "strong"); // enable ETag generation
app.use(compression()); // gzip/deflate for faster responses
app.use(cookieParser());
app.use(corsDev);

app.use(
  session({
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
    },
  }),
);

// ────────────────────────────────
// Simple cache headers for hot endpoints
// ────────────────────────────────
function shortCache(req, res, next) {
  // Cache 30s, allow stale for 60s while revalidating
  res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
  next();
}

// Apply to catalog endpoints only
app.use("/artists", shortCache);
app.use("/albums", shortCache);

// ────────────────────────────────
// Swagger
// ────────────────────────────────
app.use(
  "/swagger-custom.css",
  express.static(path.join(__dirname, "configurations", "swagger-custom.css")),
);

app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customCssUrl: "/swagger-custom.css",
  }),
);
logger.info("Swagger UI available at /api-docs");

// ────────────────────────────────
// Main routes
// ────────────────────────────────
app.use(routes);

module.exports = app;
