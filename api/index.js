const path = require("node:path");

const { createApp } = require("../server");

module.exports = createApp({
  staticDir: path.join(__dirname, "..")
});
