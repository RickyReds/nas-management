// JSON files in data/: always written to a temporary file, then renamed over
// the original, so a failure never leaves a half-written file behind.
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
// Demo mode (NASM_DEMO=1, see src/demo.js) always works in its own folder
// under the system temp directory, ignoring NASM_DATA: it overwrites the
// data it finds there, so it must never point at a real installation.
const DEMO = process.env.NASM_DEMO === "1";
const DATA = DEMO ? path.join(os.tmpdir(), "nas-management-demo")
  : process.env.NASM_DATA || path.join(ROOT, "data");

function read(name, fallback) {
  const f = path.join(DATA, name);
  if (!fs.existsSync(f)) return fallback;
  return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
}

function save(name, data) {
  fs.mkdirSync(DATA, { recursive: true });
  const f = path.join(DATA, name);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, f);
}

function mtime(name) {
  try { return fs.statSync(path.join(DATA, name)).mtimeMs; } catch { return 0; }
}

// Error with an HTTP status and a message code (see web/i18n/*.json). The
// server sends it as { error, code, params }; the page translates the code.
function error(status, code, params) {
  const e = new Error(code);
  e.status = status;
  e.code = code;
  e.params = params || {};
  return e;
}

// Characters Windows does not allow in share and folder names. They are
// refused before reaching an agent: a quote in a path would add options of
// its own to the agent's net use command line.
const badName = s => /["<>|*?:\x00-\x1f]/.test(String(s));
// Host name or IPv4: the only form an address can take.
const validAddress = s => /^[A-Za-z0-9.-]{1,253}$/.test(String(s));

function slug(text) {
  return String(text).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

function freeId(base, existing) {
  const used = new Set(existing);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

module.exports = { ROOT, DATA, DEMO, read, save, mtime, error, slug, freeId, badName, validAddress };
