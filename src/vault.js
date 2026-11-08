// Credentials encrypted with DPAPI (CurrentUser scope): the file is only
// readable by this Windows user on this machine. Passwords never leave this
// module towards the page: list() only says whether a password is set.
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const S = require("./store");

const FILE = "vault.json";

// Data goes through stdin, never on the command line.
const PS = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "Add-Type -AssemblyName System.Security",
  "$in = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$s = [Security.Cryptography.DataProtectionScope]::CurrentUser",
  "$out = @(foreach ($x in $in.items) {",
  "  $b = [Convert]::FromBase64String($x)",
  "  if ($in.mode -eq 'protect') { $r = [Security.Cryptography.ProtectedData]::Protect($b, $null, $s) }",
  "  else { $r = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, $s) }",
  "  [Convert]::ToBase64String($r)",
  "})",
  "[Console]::Out.Write((ConvertTo-Json -InputObject $out -Compress))",
].join("\n");
const PS_ENCODED = Buffer.from(PS, "utf16le").toString("base64");

function dpapi(mode, items) {
  if (!items.length) return [];
  let out;
  try {
    out = execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", PS_ENCODED],
      { input: JSON.stringify({ mode, items }), encoding: "utf8", windowsHide: true, timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    // PowerShell stderr is CLIXML: keep only the readable text.
    const text = String(e.stderr || "").replace(/<[^>]+>/g, " ").replace(/_x000D__x000A_/g, " ").replace(/\s+/g, " ").trim();
    throw new Error(`DPAPI ${mode} failed: ${text.slice(0, 300) || e.message}`);
  }
  const r = JSON.parse(out.trim());
  return Array.isArray(r) ? r : [r];
}

const protect = texts => dpapi("protect", texts.map(t => Buffer.from(t, "utf8").toString("base64")));
const unprotect = blobs => dpapi("unprotect", blobs).map(b => Buffer.from(b, "base64").toString("utf8"));

let state = null;
let readAt = -1;
let clear = new Map();
let accessKey = null;

// Reads the file again only if it changed (for example after a cli.js command).
function load() {
  const m = S.mtime(FILE);
  if (state && m === readAt) return;
  const s = S.read(FILE, { version: 1, access: null, credentials: [] });
  const blobs = s.credentials.filter(c => c.blob).map(c => c.blob);
  if (s.access) blobs.push(s.access);
  const v = unprotect(blobs);
  const map = new Map();
  let i = 0;
  for (const c of s.credentials) if (c.blob) map.set(c.id, v[i++]);
  accessKey = s.access ? v[i++] : null;
  clear = map;
  state = s;
  readAt = m;
}

function saveState() {
  S.save(FILE, state);
  readAt = S.mtime(FILE);
}

function list() {
  load();
  return state.credentials.map(({ blob, ...c }) => ({ ...c, has_password: Boolean(blob) }));
}

// Internal use only: the clear-text password, or null.
function password(id) {
  load();
  return clear.get(id) ?? null;
}

function write({ id, isNew, user, password: pwd, role, devices, source }) {
  load();
  user = String(user || "").trim();
  if (!user) throw S.error(400, "err.credentialNoUser");
  const ids = state.credentials.map(c => c.id);
  if (isNew || !id) id = S.freeId(S.slug(id || user), ids);
  let c = state.credentials.find(x => x.id === id);
  if (!c) {
    c = { id, user, role: "", devices: [], source: "", blob: null };
    state.credentials.push(c);
  }
  c.user = user;
  if (role !== undefined) c.role = String(role);
  if (source !== undefined) c.source = String(source);
  if (Array.isArray(devices)) c.devices = [...new Set(devices.map(String))];
  if (typeof pwd === "string" && pwd.length) {
    c.blob = protect([pwd])[0];
    clear.set(id, pwd);
  }
  saveState();
  return list().find(x => x.id === id);
}

function remove(id) {
  load();
  const n = state.credentials.length;
  state.credentials = state.credentials.filter(c => c.id !== id);
  if (state.credentials.length === n) throw S.error(404, "err.credentialNotFound");
  clear.delete(id);
  saveState();
}

function removeDevice(deviceId) {
  load();
  let changed = false;
  for (const c of state.credentials) {
    const before = c.devices.length;
    c.devices = c.devices.filter(d => d !== deviceId);
    if (c.devices.length !== before) changed = true;
  }
  if (changed) saveState();
}

// Import (src/transfer.js): the whole list of credentials becomes `list`
// ({ id, user, role, devices, source }). A credential keeps its password only
// if it already existed with the same id and the same user; every other one
// arrives without a password. No encryption is needed: no new passwords.
function replaceCredentials(list) {
  load();
  const before = new Map(state.credentials.map(c => [c.id, c]));
  state.credentials = list.map(c => {
    const old = before.get(c.id);
    const keep = Boolean(old && old.blob && old.user.toLowerCase() === c.user.toLowerCase());
    if (!keep) clear.delete(c.id);
    return { id: c.id, user: c.user, role: c.role, devices: c.devices, source: c.source, blob: keep ? old.blob : null };
  });
  for (const id of [...clear.keys()]) if (!list.some(c => c.id === id)) clear.delete(id);
  saveState();
}

function hasKey() {
  load();
  return Boolean(accessKey);
}

function checkKey(attempt) {
  load();
  if (!accessKey) return false;
  const h = s => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(h(attempt), h(accessKey));
}

// Only for cli.js, on the server and as the service user.
function readKey() {
  load();
  return accessKey;
}

function setKey(newKey) {
  load();
  state.access = protect([newKey])[0];
  accessKey = newKey;
  saveState();
}

module.exports = { load, list, password, write, remove, removeDevice, replaceCredentials, hasKey, checkKey, readKey, setKey };
