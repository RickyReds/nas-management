// Demo mode: NASM_DEMO=1 node src/server.js
//
// Starts the service on invented sample data (examples/demo/), for trying the
// pages and taking screenshots without a NAS or an agent:
// - the data folder is <system temp>/nas-management-demo, filled again from
//   examples/demo/ at every start, so every start shows the same demo;
// - the dates in the sample data are moved so that they look recent;
// - the access key is "demo" and the sample credentials get a dummy password;
// - the status page shows the sample metrics: nothing is probed and nobody
//   logs in to anything;
// - whatever would reach out of the server (Wake-on-LAN, agent registration,
//   service restart, reading folders on a NAS) answers "not available in the
//   demo". Jobs can be created, but no agent will ever pick them up.
const fs = require("fs");
const path = require("path");
const S = require("./store");

const SEED = path.join(S.ROOT, "examples", "demo");
const KEY = "demo";
const DUMMY_PASSWORD = "demo-password";
// Files copied as they are, after moving the dates.
const FILES = ["config.json", "devices.json", "machines.json", "profiles.json", "jobs.json", "structure.json", "diagnostics.json"];
// Files of a previous demo run that would get in the way.
const STALE = ["suspensions.json", "sessions.json"];

let seed = null; // status.json, with the dates already moved
let offset = 0;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Every ISO date in the sample data moves by the same amount: the sample
// "now" (anchor in status.json) becomes the real now.
function shift(v) {
  if (typeof v === "string") return ISO.test(v) ? new Date(Date.parse(v) + offset).toISOString() : v;
  if (Array.isArray(v)) return v.map(shift);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shift(x)]));
  return v;
}

const readSeed = name => JSON.parse(fs.readFileSync(path.join(SEED, name), "utf8").replace(/^﻿/, ""));

// Before config.js is loaded: config.json is one of the sample files.
function prepare(log) {
  const status = readSeed("status.json");
  offset = Date.now() - Date.parse(status.anchor);
  seed = shift(status);
  for (const f of FILES) S.save(f, shift(readSeed(f)));
  for (const f of STALE) {
    try { fs.unlinkSync(path.join(S.DATA, f)); } catch { }
  }
  // The vault is DPAPI-encrypted for the user running the demo, so it cannot
  // ship with the samples: key and credentials are written here.
  const V = require("./vault");
  if (V.readKey() !== KEY) V.setKey(KEY);
  const existing = new Set(V.list().map(c => c.id));
  for (const c of readSeed("credentials.json")) {
    if (!existing.has(c.id)) V.write({ ...c, password: DUMMY_PASSWORD });
  }
  log(`DEMO MODE: sample data in ${S.DATA}, access key: ${KEY}`);
}

// Sample machines look connected, except the ones marked offline.
function start() {
  const AG = require("./agents");
  const touch = () => {
    for (const m of AG.all()) if (!seed.offline_machines.includes(m.id)) AG.touch(m.id);
  };
  touch();
  setInterval(touch, 60 * 1000).unref();
}

// What the monitor would know about a device: the sample state, if any.
function deviceState(id) {
  const s = seed && seed.devices[id];
  if (!s) return { status: "unknown" };
  return { ...s, checked: new Date(Date.now() - 20 * 1000).toISOString() };
}

const blocked = () => S.error(409, "err.notInDemo");

module.exports = { prepare, start, deviceState, blocked };
