// server/config.js
// ─────────────────────────────────────────────────────────────────────────────
// Configuration loader for Tab Out.
//
// Reads settings from ~/.mission-control/config.json on your Mac.
// If that file exists, values from it override the defaults below.
// If the file doesn't exist or is malformed, defaults are used.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const os = require("os");

// The folder where all Tab Out data lives on your Mac.
const CONFIG_DIR = path.join(os.homedir(), ".mission-control");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

// Default values — used whenever a key is absent from the config file.
const DEFAULTS = {
  // Which local port the web server listens on.
  port: 3456,
};

// ─────────────────────────────────────────────────────────────────────────────
// Load config from disk and merge with defaults.
// ─────────────────────────────────────────────────────────────────────────────
function loadConfig() {
  let fileConfig = {};

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(CONFIG_FILE, "utf8");
      fileConfig = JSON.parse(raw);
    } catch (err) {
      console.warn(
        `[config] Warning: could not parse ${CONFIG_FILE}: ${err.message}`,
      );
      console.warn("[config] Falling back to defaults.");
    }
  } else {
    console.warn(
      `[config] No config file found at ${CONFIG_FILE}. Using defaults.`,
    );
  }

  return Object.assign({}, DEFAULTS, fileConfig);
}

const config = loadConfig();

config.CONFIG_DIR = CONFIG_DIR;
config.CONFIG_FILE = CONFIG_FILE;
config.DEFAULTS = DEFAULTS;

module.exports = config;
