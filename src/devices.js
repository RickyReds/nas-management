// Device registry. Adding a device NEVER logs in: QNAP blocks the IP after
// a few failed attempts.
const net = require("net");
const http = require("http");
const dns = require("dns").promises;
const { execFile } = require("child_process");
const S = require("./store");

const FILE = "devices.json";
const PORTS = [22, 80, 443, 445, 5000, 8080];
const WOL = ["yes", "no", "untested"];
const TYPES = ["qnap", "generic"];

// The registry starts empty: devices are added from the page.
function all() {
  return S.read(FILE, []);
}

function port(host, number, ms = 700) {
  return new Promise(resolve => {
    const s = net.connect({ host, port: number });
    const done = v => { s.destroy(); resolve(v); };
    s.setTimeout(ms, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

// QTS login page read WITHOUT credentials. QTS 4.3.6 gives model and
// firmware, QTS 5.2 only the host name.
function qnap(host) {
  return new Promise(resolve => {
    const q = http.get({ host, port: 8080, path: "/cgi-bin/authLogin.cgi", timeout: 4000 }, res => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", d => { if (s.length < 200000) s += d; });
      res.on("end", () => {
        if (!/<QDocRoot/.test(s)) return resolve(null);
        const field = t => {
          const m = s.match(new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([^<\\]]*)`));
          return (m && m[1].trim()) || null;
        };
        resolve({
          hostname: field("hostname"),
          model: field("displayModelName") || field("modelName"),
          version: field("version"), number: field("number"), build: field("build"),
          booting: field("is_booting") === "1",
        });
      });
    });
    q.on("timeout", () => { q.destroy(); resolve(null); });
    q.on("error", () => resolve(null));
  });
}

// MAC from the ARP table: only present for devices on the same network.
function mac(ip) {
  return new Promise(resolve => {
    execFile("arp", ["-a", ip], { windowsHide: true, timeout: 5000 }, (e, out) => {
      const m = !e && String(out).match(/([0-9a-f]{2}(?:-[0-9a-f]{2}){5})/i);
      resolve(m ? m[1].toUpperCase().replace(/-/g, ":") : null);
    });
  });
}

function existing(d, keys) {
  const wanted = new Set(keys.filter(Boolean).map(s => s.toLowerCase()));
  return d.find(x => x.addresses.some(a => wanted.has(a.toLowerCase())));
}

async function add({ address, name }) {
  address = String(address || "").trim();
  if (!S.validAddress(address)) throw S.error(400, "err.addressInvalid");
  let ip;
  try { ip = (await dns.lookup(address, { family: 4 })).address; }
  catch { throw S.error(404, "err.nameNotResolved", { address }); }
  if (ip.startsWith("127.")) throw S.error(400, "err.nameResolvesLoopback", { address, ip });

  let found = existing(all(), [address, ip]);
  if (found) throw S.error(409, "err.deviceExists", { name: found.name });

  const open = (await Promise.all(PORTS.map(p => port(ip, p).then(ok => (ok ? p : null))))).filter(Boolean);
  const q = open.includes(8080) ? await qnap(ip) : null;
  const m = await mac(ip);

  const d = all();
  found = existing(d, [address, ip, q && q.hostname]);
  if (found) throw S.error(409, "err.deviceExists", { name: found.name });

  const finalName = String(name || "").trim() || (q && q.hostname) || address;
  const dev = {
    id: S.freeId(S.slug(finalName), d.map(x => x.id)),
    name: finalName,
    type: q ? "qnap" : "generic",
    addresses: [...new Set([ip, address, q && q.hostname].filter(Boolean))],
    mac: m ? [m] : [],
    model: (q && q.model) || "",
    firmware: q && q.version ? `QTS ${q.version}${q.number ? "." + q.number : ""}${q.build ? " build " + q.build : ""}` : "",
    wol: "untested",
    notes: "",
    detected: { when: new Date().toISOString(), open_ports: open, booting: Boolean(q && q.booting) },
  };
  d.push(dev);
  S.save(FILE, d);
  return dev;
}

function textList(v, field) {
  if (!Array.isArray(v) || v.some(x => typeof x !== "string")) throw S.error(400, "err.needTextList", { field });
  return [...new Set(v.map(x => x.trim()).filter(Boolean))];
}

function update(id, fields) {
  const d = all();
  const x = d.find(v => v.id === id);
  if (!x) throw S.error(404, "err.deviceNotFound");
  for (const k of ["name", "model", "firmware", "notes"]) {
    if (fields[k] !== undefined) x[k] = String(fields[k]).trim();
  }
  if (!x.name) throw S.error(400, "err.nameEmpty");
  if (fields.type !== undefined) {
    if (!TYPES.includes(fields.type)) throw S.error(400, "err.oneOf", { field: "type", values: TYPES.join(", ") });
    x.type = fields.type;
  }
  if (fields.wol !== undefined) {
    if (!WOL.includes(fields.wol)) throw S.error(400, "err.oneOf", { field: "wol", values: WOL.join(", ") });
    x.wol = fields.wol;
  }
  if (fields.metrics_credential !== undefined) {
    x.metrics_credential = fields.metrics_credential ? String(fields.metrics_credential) : null;
  }
  if (fields.addresses !== undefined) {
    x.addresses = textList(fields.addresses, "addresses");
    if (!x.addresses.length) throw S.error(400, "err.needAddress");
    // Same rule as when adding: the server and the agents use these in UNC paths.
    if (x.addresses.some(a => !S.validAddress(a))) throw S.error(400, "err.addressInvalid");
  }
  if (fields.mac !== undefined) {
    x.mac = textList(fields.mac, "mac").map(s => s.toUpperCase().replace(/-/g, ":"));
    if (x.mac.some(s => !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(s))) throw S.error(400, "err.macInvalid");
  }
  S.save(FILE, d);
  return x;
}

// A device arriving with an import (src/transfer.js): only known fields, each
// checked as the page would. Throws a message code that names what is wrong.
function checkImported(x, n) {
  const bad = field => S.error(400, "err.importDeviceInvalid", { n, field });
  if (!x || typeof x !== "object") throw bad("-");
  const str = (v, max) => (v == null ? "" : typeof v === "string" && v.length <= max ? v.trim() : null);
  const id = String(x.id || "");
  if (!/^[a-z0-9-]{1,60}$/.test(id)) throw bad("id");
  const name = str(x.name, 100);
  if (!name) throw bad("name");
  if (!TYPES.includes(x.type)) throw bad("type");
  if (!Array.isArray(x.addresses) || !x.addresses.length || x.addresses.some(a => typeof a !== "string" || !S.validAddress(a))) throw bad("addresses");
  if (!Array.isArray(x.mac || [])) throw bad("mac");
  const mac = (x.mac || []).map(s => String(s).toUpperCase().replace(/-/g, ":"));
  if (mac.some(s => !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(s))) throw bad("mac");
  const wol = x.wol == null ? "untested" : x.wol;
  if (!WOL.includes(wol)) throw bad("wol");
  const model = str(x.model, 200), firmware = str(x.firmware, 200), notes = str(x.notes, 4000);
  if (model == null) throw bad("model");
  if (firmware == null) throw bad("firmware");
  if (notes == null) throw bad("notes");
  const dev = { id, name, type: x.type, addresses: [...new Set(x.addresses)], mac: [...new Set(mac)], model, firmware, wol, notes };
  if (x.metrics_credential != null) {
    if (typeof x.metrics_credential !== "string" || !/^[a-z0-9-]{1,60}$/.test(x.metrics_credential)) throw bad("metrics_credential");
    dev.metrics_credential = x.metrics_credential;
  }
  const det = x.detected;
  if (det && typeof det === "object" && Array.isArray(det.open_ports) && det.open_ports.every(p => Number.isInteger(p) && p > 0 && p < 65536)) {
    dev.detected = { when: typeof det.when === "string" ? det.when : null, open_ports: det.open_ports, booting: Boolean(det.booting) };
  }
  return dev;
}

function remove(id) {
  const d = all();
  const rest = d.filter(v => v.id !== id);
  if (rest.length === d.length) throw S.error(404, "err.deviceNotFound");
  S.save(FILE, rest);
}

module.exports = { all, add, update, remove, port, qnap, checkImported };
