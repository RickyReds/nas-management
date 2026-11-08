// Installation settings: data/config.json, with defaults for anything
// missing. Example: config.example.json in the project root. NASM_PORT and
// NASM_HOST environment variables win over the file (used by test servers).
// Read once at startup.
const fs = require("fs");
const os = require("os");
const path = require("path");
const S = require("./store");

const DEFAULTS = {
  port: 8790,
  host: "0.0.0.0",
  // Address the other PCs use to reach this server: written into the agent
  // installers when the page is opened from localhost.
  // null = the first private IPv4 address of this machine.
  publicAddress: null,
  // Name of the scheduled task that starts the service (see
  // scripts/install-service.ps1): used by the restart button.
  taskName: "NAS-Management",
  // QTS user for metrics when a device does not choose one. Empty = no
  // metrics until one is chosen on the device. Prefer a read-only user.
  metricsUser: "",
  // Drive letters the app never touches, per computer name, assigned when
  // the agent registers. Example: { "SERVER01": ["V"] }.
  protectedDriveLetters: {},
};

function readFile() {
  const f = path.join(S.DATA, "config.json");
  if (!fs.existsSync(f)) return {};
  try {
    const c = JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("must be a JSON object");
    return c;
  } catch (e) {
    throw new Error(`data/config.json is not valid: ${e.message}`);
  }
}

function privateIp() {
  for (const nics of Object.values(os.networkInterfaces())) {
    for (const n of nics || []) {
      if (n.family === "IPv4" && !n.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address)) return n.address;
    }
  }
  return "127.0.0.1";
}

// Settings as a file would give them: defaults for what is missing, then the
// checks. Throws a plain Error with the reason. Also used to check a
// config.json arriving with an import (src/transfer.js), before writing it.
function normalize(raw, env) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config: must be a JSON object");
  const c = { ...DEFAULTS, ...raw };
  if (env) {
    if (process.env.NASM_PORT) c.port = Number(process.env.NASM_PORT);
    if (process.env.NASM_HOST) c.host = process.env.NASM_HOST;
    // The demo has a fixed, public access key: it never listens on the network.
    if (S.DEMO) c.host = "127.0.0.1";
  }

  c.port = Number(c.port);
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw new Error("config: port must be a number between 1 and 65535");
  c.taskName = String(c.taskName || "").trim();
  if (!c.taskName || /['"]/.test(c.taskName)) throw new Error("config: taskName cannot be empty or contain quotes");
  c.metricsUser = String(c.metricsUser || "").trim();
  c.publicAddress = c.publicAddress ? String(c.publicAddress).trim().replace(/\/+$/, "") : `http://${privateIp()}:${c.port}`;
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(c.publicAddress)) throw new Error("config: publicAddress must look like http://address:port");

  const letters = {};
  for (const [pc, l] of Object.entries(c.protectedDriveLetters || {})) {
    if (!Array.isArray(l) || l.some(x => !/^[A-Za-z]$/.test(String(x)))) throw new Error(`config: protectedDriveLetters.${pc} must be a list of letters`);
    letters[pc.toUpperCase()] = [...new Set(l.map(x => String(x).toUpperCase()))];
  }
  c.protectedDriveLetters = letters;
  c.host = String(c.host || "").trim();
  if (!c.host) throw new Error("config: host cannot be empty");
  return c;
}

function load() {
  const c = normalize(readFile(), true);
  // Not enumerable: the settings stay a plain list of values.
  Object.defineProperty(c, "normalize", { value: normalize });
  return Object.freeze(c);
}

module.exports = load();
