// Machines with the agent. A "machine" is a computer plus a Windows user,
// because network drives belong to the user's session.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const S = require("./store");
const CFG = require("./config");

const FILE = "machines.json";
const CODE_LIFETIME = 30 * 60 * 1000;
const codes = new Map();
const contacts = new Map(); // id -> last contact, in memory only

const all = () => S.read(FILE, []);
const hash = t => crypto.createHash("sha256").update(String(t)).digest("hex");
const b64u = s => String(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function publicKey(pk) {
  try {
    return crypto.createPublicKey({ key: { kty: "RSA", n: b64u(pk.n), e: b64u(pk.e) }, format: "jwk" });
  } catch {
    throw S.error(400, "err.publicKeyInvalid");
  }
}

// Current agent: version and fingerprint of the file served at
// /agent/agent.ps1. Agents compare it with their own and update if different.
let agentCache = { mtime: -1, info: null };
function agentInfo() {
  const f = path.join(S.ROOT, "agent", "agent.ps1");
  let st;
  try { st = fs.statSync(f); } catch { return null; }
  if (st.mtimeMs !== agentCache.mtime) {
    const b = fs.readFileSync(f);
    const v = b.toString("utf8").match(/^\$Version = '([^']+)'/m);
    agentCache = { mtime: st.mtimeMs, info: { version: v ? v[1] : "?", sha256: crypto.createHash("sha256").update(b).digest("hex") } };
  }
  return agentCache.info;
}

// Display name: the one chosen by the user, otherwise the Windows name.
const nameOf = m => (m && m.name) || (m && m.computer) || "";

const lastContact = m => contacts.get(m.id) || m.last_contact || null;
const isOnline = m => (t => Boolean(t && Date.now() - Date.parse(t) < 3 * 60 * 1000))(lastContact(m));

// Towards the pages "computer" is the display name; the real Windows name
// is in "windows_computer". Registration always uses the real one.
function publish(m) {
  const { token, public_key, _signature, ...rest } = m;
  const info = agentInfo();
  return {
    ...rest, computer: nameOf(m), windows_computer: m.computer, last_contact: lastContact(m),
    current_agent: info ? info.version : null,
  };
}

const list = () => all().map(publish);

function newCode() {
  const now = Date.now();
  for (const [c, expires] of codes) if (expires < now) codes.delete(c);
  const code = crypto.randomBytes(5).toString("hex").toUpperCase();
  codes.set(code, now + CODE_LIFETIME);
  return { code, expires: new Date(now + CODE_LIFETIME).toISOString() };
}

// Still valid, without using it up: needed to generate the installer.
function codeValid(code) {
  const expires = codes.get(String(code || "").trim().toUpperCase());
  return expires && expires > Date.now() ? new Date(expires) : null;
}

function register({ code, computer, user, public_key }) {
  const c = String(code || "").trim().toUpperCase();
  const expires = codes.get(c);
  if (!expires || expires < Date.now()) throw S.error(403, "err.registrationCodeInvalid");
  computer = String(computer || "").trim();
  user = String(user || "").trim();
  if (!/^[A-Za-z0-9._-]{1,63}$/.test(computer)) throw S.error(400, "err.computerNameInvalid");
  if (!/^[^\0\r\n]{1,200}$/.test(user)) throw S.error(400, "err.userInvalid");
  publicKey(public_key || {});
  codes.delete(c);

  const m = all();
  let x = m.find(v => v.computer.toLowerCase() === computer.toLowerCase() && v.user.toLowerCase() === user.toLowerCase());
  if (!x) {
    x = {
      id: S.freeId(S.slug(`${computer}-${user.split("\\").pop()}`), m.map(v => v.id)),
      computer, user, managed: true,
      protected_letters: CFG.protectedDriveLetters[computer.toUpperCase()] || [],
      preferred_addresses: {},
      registered: new Date().toISOString(),
      snapshot: null, windows_credentials: [],
    };
    m.push(x);
  }
  const token = crypto.randomBytes(32).toString("base64url");
  x.public_key = { n: public_key.n, e: public_key.e };
  x.token = hash(token);
  S.save(FILE, m);
  return { id: x.id, token };
}

function fromRequest(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  const t = hash(h.slice(7).trim());
  return all().find(v => v.token === t) || null;
}

const cleanIp = ip => String(ip || "").replace(/^::ffff:/, "");

// Names (not IPs) of the registered devices: the agent resolves them and reports.
function namesToResolve(devices) {
  const names = new Set();
  for (const d of devices) for (const a of d.addresses) if (!/^\d+\.\d+\.\d+\.\d+$/.test(a)) names.add(a);
  return [...names];
}

// { name: [ip, ...] } cleaned up: only valid names and IPv4.
function cleanResolutions(r) {
  if (!r || typeof r !== "object") return null;
  const out = {};
  for (const [n, ips] of Object.entries(r)) {
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(n)) continue;
    out[n.toLowerCase()] = (Array.isArray(ips) ? ips : [ips]).map(String).filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  }
  return out;
}

function touch(id) {
  contacts.set(id, new Date().toISOString());
}

// Saves the snapshot only when it changed; the contact time stays in memory.
// The address the agent calls from identifies "this PC" on the map.
function report(id, { drives, windows_credentials, version, resolutions }, ip) {
  touch(id);
  const clean = (Array.isArray(drives) ? drives : []).filter(u => u && /^[A-Z]$/.test(u.letter)).map(u => ({
    letter: u.letter, path: String(u.path || ""), status: u.status === "connected" ? "connected" : "disconnected",
  })).sort((a, b) => a.letter.localeCompare(b.letter));
  const cred = (Array.isArray(windows_credentials) ? windows_credentials : []).filter(c => c && c.target).map(c => ({
    target: String(c.target), user: String(c.user || ""),
  }));
  const m = all();
  const x = m.find(v => v.id === id);
  if (!x) return;
  const res = cleanResolutions(resolutions);
  const signature = JSON.stringify([clean, cred, version, cleanIp(ip), res]);
  if (x._signature === signature) return;
  x._signature = signature;
  if (ip) x.ip = cleanIp(ip);
  x.snapshot = { when: new Date().toISOString(), drives: clean };
  x.windows_credentials = cred;
  if (res) x.resolutions = res;
  x.agent_version = String(version || "");
  x.last_contact = contacts.get(id);
  S.save(FILE, m);
}

function encryptFor(machine, text) {
  const key = publicKey(machine.public_key);
  return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, Buffer.from(text, "utf8")).toString("base64");
}

function update(id, { managed, protected_letters, preferred_addresses, name }, devices) {
  const m = all();
  const x = m.find(v => v.id === id);
  if (!x) throw S.error(404, "err.machineNotFound");
  if (managed !== undefined) x.managed = Boolean(managed);
  if (name !== undefined) {
    const n = String(name || "").trim();
    if (n.length > 40) throw S.error(400, "err.nameTooLong", { max: 40 });
    if (/[\\<>]/.test(n)) throw S.error(400, "err.nameBadChars");
    if (n && n.toLowerCase() !== x.computer.toLowerCase()) x.name = n; else delete x.name;
  }
  if (protected_letters !== undefined) {
    if (!Array.isArray(protected_letters)) throw S.error(400, "err.needList", { field: "protected_letters" });
    const l = [...new Set(protected_letters.map(s => String(s).trim().toUpperCase().replace(/:$/, "")).filter(Boolean))];
    if (l.some(s => !/^[A-Z]$/.test(s))) throw S.error(400, "err.letterInvalid", { letter: l.find(s => !/^[A-Z]$/.test(s)) });
    x.protected_letters = l.sort();
  }
  if (preferred_addresses !== undefined) {
    const p = {};
    for (const [dev, addr] of Object.entries(preferred_addresses || {})) {
      if (!addr) continue;
      const d = devices.find(v => v.id === dev);
      if (!d) throw S.error(400, "err.deviceUnknown", { device: dev });
      if (!d.addresses.includes(addr)) throw S.error(400, "err.notAnAddressOf", { address: addr, device: d.name });
      p[dev] = addr;
    }
    x.preferred_addresses = p;
  }
  S.save(FILE, m);
  return publish(x);
}

function remove(id) {
  const m = all();
  const rest = m.filter(v => v.id !== id);
  if (rest.length === m.length) throw S.error(404, "err.machineNotFound");
  contacts.delete(id);
  S.save(FILE, rest);
}

module.exports = { namesToResolve, agentInfo, nameOf, isOnline, all, list, newCode, codeValid, register, fromRequest, touch, report, encryptFor, update, remove };
