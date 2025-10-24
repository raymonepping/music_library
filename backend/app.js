// backend/app.js (NEW file)
const path = require("path");
const express = require("express");
const session = require("express-session");
const cookieParser = require("cookie-parser");

const config = require("./configurations");
const logger = require("./configurations/logger");

const corsDev = require("./middleware/corsDev");

// routes
const routes = require("./routes");

// swagger
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./configurations/swaggerOptions");

const app = express();

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

// static for custom Swagger CSS
app.use(
  "/swagger-custom.css",
  express.static(path.join(__dirname, "configurations", "swagger-custom.css")),
);

// Swagger UI
app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customCssUrl: "/swagger-custom.css",
  }),
);
logger.info("Swagger UI available at /api-docs");

app.use(routes);

module.exports = app;
