// configurations/swaggerOptions.js
const swaggerJsDoc = require("swagger-jsdoc");
const path = require("path");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Backend Service API",
      version: "1.0.0",
      description: "API Documentation for Backend Service",
    },
    servers: [{ url: "http://localhost:3002" }],
  },
  // Adjust glob to your routes dir; path.resolve ensures it works from anywhere
  apis: [path.resolve(__dirname, "../routes/*.js")],
};

const swaggerSpec = swaggerJsDoc(options);
module.exports = swaggerSpec;
