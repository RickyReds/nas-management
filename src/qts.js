// Read-only QTS client for metrics.
// - Account: the credential chosen on the device, otherwise the one whose
//   user is metricsUser in config.json (preferably a read-only user). Never
//   an administrator as a fallback.
// - The session (sid) is kept and reused; if it expires, log in again ONCE.
// - A rejected login suspends the credential on that NAS (suspensions.js):
//   QNAP blocks the IP after a few failed attempts.
// Endpoints measured on QTS 5.2.10 and QTS 4.3.6.
const http = require("http");
const V = require("./vault");
const SU = require("./suspensions");
const CFG = require("./config");

const sessions = new Map(); // device id -> { sid, credential, address }
let log = () => {};

// Errors here end up on the status page: { code, params } like any message.
const fail = (code, params) => Object.assign(new Error(code), { code, params: params || {} });

function get(host, path, ms = 40000) {
  return new Promise((ok, ko) => {
    const q = http.get({ host, port: 8080, path, timeout: ms }, r => {
      let s = "";
      r.setEncoding("utf8");
      r.on("data", d => { if (s.length < 2000000) s += d; });
      r.on("end", () => ok(s));
    });
    q.on("timeout", () => { q.destroy(); ko(fail("err.qtsNoAnswer", { host })); });
    q.on("error", e => ko(fail("err.qtsConnection", { host, error: e.code || e.message })));
  });
}

// Almost all QTS fields are in CDATA.
function field(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[([^\\]]*)\\]\\]>|([^<]*))</${tag}>`));
  return m ? (m[1] ?? m[2] ?? "").trim() : null;
}

function leaves(xml) {
  const out = [];
  const re = /<([A-Za-z_][\w.-]*)>(?:<!\[CDATA\[([^\]]*)\]\]>|([^<]*))<\/\1>/g;
  let m;
  while ((m = re.exec(xml))) out.push([m[1], (m[2] ?? m[3] ?? "").trim()]);
  return out;
}

const num = v => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// Records repeated in a flat sequence: a repeated field starts a new record.
function toRecords(pairs) {
  const out = [];
  let r = null;
  for (const [k, v] of pairs) {
    if (!r || k in r) { r = {}; out.push(r); }
    r[k] = v;
  }
  return out;
}

function credentialFor(d) {
  const valid = V.list().filter(c => c.devices.includes(d.id) && c.has_password);
  if (d.metrics_credential) return valid.find(c => c.id === d.metrics_credential) || null;
  if (!CFG.metricsUser) return null;
  return valid.find(c => c.user.toLowerCase() === CFG.metricsUser.toLowerCase()) || null;
}

async function login(d, address, c) {
  const pwd = Buffer.from(V.password(c.id) || "", "utf8").toString("base64");
  const xml = await get(address, `/cgi-bin/authLogin.cgi?user=${encodeURIComponent(c.user)}&pwd=${encodeURIComponent(pwd)}&serviceKey=1`, 20000);
  const sid = field(xml, "authSid");
  if (!sid) {
    if (/<QDocRoot/.test(xml) && field(xml, "authPassed") === "0") {
      SU.suspend({ credential: c.id, device: d.id, machine: "server", message: { code: "msg.qtsLoginRejected", params: { user: c.user } } });
      log(`metrics: login of ${c.user} on ${d.name} REJECTED, credential suspended`);
      throw fail("err.qtsLoginRejected", { user: c.user });
    }
    throw fail("err.qtsUnexpectedLogin");
  }
  log(`metrics: login of ${c.user} on ${d.name}`);
  const s = { sid, credential: c.id, address };
  sessions.set(d.id, s);
  return s;
}

async function request(d, c, address, path) {
  let s = sessions.get(d.id);
  if (!s || s.credential !== c.id || s.address !== address) s = await login(d, address, c);
  let xml = await get(address, `${path}&sid=${encodeURIComponent(s.sid)}`);
  if (field(xml, "authPassed") === "0") {
    sessions.delete(d.id);
    s = await login(d, address, c);
    xml = await get(address, `${path}&sid=${encodeURIComponent(s.sid)}`);
    if (field(xml, "authPassed") === "0") throw fail("err.qtsSessionRejected");
  }
  return xml;
}

function readSysinfo(x) {
  const fans = [];
  for (let i = 1; i <= (num(field(x, "sysfan_count")) || 0); i++) {
    fans.push({ rpm: num(field(x, `sysfan${i}`)), failed: field(x, `sysfan_fail${i}`) === "1" });
  }
  const network = [];
  for (let i = 1; i <= (num(field(x, "nic_cnt")) || 0); i++) {
    network.push({
      name: field(x, `ifname${i}`), connected: field(x, `eth_status${i}`) === "1",
      speed: num(field(x, `eth_max_speed${i}`)), ip: field(x, `eth_ip${i}`), mac: (field(x, `eth_mac${i}`) || "").toUpperCase(),
    });
  }
  const temp = t => { const v = num(field(x, t)); return v == null || v < 0 ? null : v; };
  const days = num(field(x, "uptime_day")), hours = num(field(x, "uptime_hour")), minutes = num(field(x, "uptime_min"));
  const version = field(x, "version");
  return {
    model: field(x, "displayModelName"),
    firmware: version ? `QTS ${version}.${field(x, "number")} build ${field(x, "build")}` : null,
    serial: field(x, "serial_number"),
    cpu: num(field(x, "cpu_usage")),
    memory: { total_mb: num(field(x, "total_memory")), free_mb: num(field(x, "free_memory")) },
    temperatures: { system: temp("sys_tempc"), cpu: temp("cpu_tempc"), system_threshold: num(field(x, "SysTempWarnT")) },
    uptime_s: days == null ? null : ((days * 24 + (hours || 0)) * 60 + (minutes || 0)) * 60,
    fans, network,
  };
}

function readHealth(x) {
  const pairs = leaves(x);
  const i = pairs.findIndex(([k]) => k === "status");
  const status = i >= 0 ? pairs[i][1] : null;
  const events = i >= 0 ? toRecords(pairs.slice(i + 1)).map(r => {
    let on = null;
    if (r.volumeValue) on = { kind: "volume", name: r.volumeValue.split(":")[0], status: r.volumeStat || null };
    else if (r.hddNO) on = { kind: "disk", name: r.hddNO };
    return { type: r.type || "", code: r.eventID || "", on };
  }) : [];
  return { status, events };
}

function readDisks(x) {
  const pairs = leaves(x);
  const i = pairs.findIndex(([k]) => k === "SSDTempErrT");
  const threshold = num(field(x, "HDTempWarnT"));
  return toRecords(pairs.slice(i + 1)).filter(r => r.HDNo).map(r => ({
    slot: r.HDNo, name: r.Disk_Alias || null, number: r.HDNo.split(":").pop(),
    model: r.Model || r.Vendor || "", health: r.Health || "", temperature: num(r.oC),
    temperature_threshold: threshold, capacity: r.Capacity || "", serial: r.Serial || "",
  }));
}

// volumeList gives name and free space in GB; the usage section gives total
// and free in bytes. On QTS 4.3.6 the capacity is only in the usage section.
function readVolumes(x) {
  const pairs = leaves(x);
  const usage = {};
  let usageStart = pairs.length;
  pairs.forEach(([k, v], i) => {
    if (k === "volumeValue" && pairs[i + 1] && pairs[i + 1][0] === "total_size") {
      usageStart = Math.min(usageStart, i);
      const free = pairs.slice(i, i + 4).find(([kk]) => kk === "free_size");
      usage[v] = { total: num(pairs[i + 1][1]), free: free ? num(free[1]) : null };
    }
  });
  // In the usage section, after total and free, each share of the volume is
  // a sharename/used_size pair; "System Reserved" carries type=system.
  const starts = [];
  pairs.forEach(([k], i) => { if (k === "volumeValue" && pairs[i + 1] && pairs[i + 1][0] === "total_size") starts.push(i); });
  starts.forEach((i, n) => {
    const end = n + 1 < starts.length ? starts[n + 1] : pairs.length;
    const shares = [];
    for (let j = i; j < end; j++) {
      if (pairs[j][0] !== "sharename") continue;
      const used = pairs[j + 1] && pairs[j + 1][0] === "used_size" ? num(pairs[j + 1][1]) : null;
      const system = pairs.slice(j + 1, j + 3).some(([k, v]) => k === "type" && v === "system");
      if (!system) shares.push({ name: pairs[j][1], used_bytes: used });
    }
    usage[pairs[i][1]].shares = shares;
  });
  const volumes = [];
  let r = null;
  for (const [k, v] of pairs.slice(0, usageStart)) {
    if (k === "volumeStat") { r = {}; volumes.push(r); }
    if (r) r[k] = v;
  }
  return volumes.filter(v => v.volumeLabel).map(v => {
    const u = usage[v.volumeValue] || {};
    return {
      name: v.volumeLabel, type: v.volumeStat || "", free_gb: num(v.freeSize),
      total_bytes: u.total ?? null, free_bytes: u.free ?? null, shares: u.shares || [],
    };
  });
}

const ENDPOINT = {
  sysinfo: "/cgi-bin/management/manaRequest.cgi?subfunc=sysinfo&hd=no&multicpu=1",
  health: "/cgi-bin/management/manaRequest.cgi?subfunc=sysinfo&sysHealth=1",
  disks: "/cgi-bin/disk/qsmart.cgi?func=all_hd_data",
  volumes: "/cgi-bin/management/chartReq.cgi?chart_func=disk_usage&disk_select=all&include=all",
};

async function read(d) {
  const c = credentialFor(d);
  if (!c) throw fail("err.noMetricsCredential", { user: CFG.metricsUser || "—" });
  if (SU.isSuspended(c.id, d.id)) throw fail("err.metricsCredentialSuspended", { user: c.user });
  const address = d.addresses[0];
  const sys = readSysinfo(await request(d, c, address, ENDPOINT.sysinfo));
  const health = readHealth(await request(d, c, address, ENDPOINT.health));
  const disks = readDisks(await request(d, c, address, ENDPOINT.disks));
  const volumes = readVolumes(await request(d, c, address, ENDPOINT.volumes));
  return { when: new Date().toISOString(), account: c.user, ...sys, health, disks, volumes };
}

const forget = id => sessions.delete(id);
const setLog = f => { log = f; };

module.exports = { read, forget, setLog, credentialFor, _test: { readSysinfo, readHealth, readDisks, readVolumes } };
