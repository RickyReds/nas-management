// Device status: TCP probe every minute for all devices (no login), QTS
// metrics every 15 minutes for QNAPs that are on (NASM_METRICS_MINUTES to
// change it), right away when one has just come up, and on request with
// "Refresh now". Everything in memory: keep history elsewhere if you need it.
const S = require("./store");
const D = require("./devices");
const Q = require("./qts");
const W = require("./wol");

const PROBE_EVERY = 60 * 1000;
const METRICS_EVERY = (Number(process.env.NASM_METRICS_MINUTES) || 15) * 60 * 1000;
const WAKE_WAIT = 5 * 60 * 1000;
const state = new Map();
let log = () => {};

function portsOf(d) {
  if (d.type === "qnap") return [8080, 445];
  const p = (d.detected && d.detected.open_ports) || [];
  return p.length ? p.slice(0, 3) : [445, 80, 443, 22];
}

async function probe(d) {
  const s = state.get(d.id) || { status: "unknown" };
  state.set(d.id, s);
  const addr = d.addresses[0];
  const open = (await Promise.all(portsOf(d).map(p => D.port(addr, p, 800).then(ok => (ok ? p : null))))).filter(Boolean);
  let now = open.length ? "on" : "off";
  // A booting QNAP has the network up but not QTS yet: is_booting says so, without login.
  if (d.type === "qnap" && open.length) {
    const q = open.includes(8080) ? await D.qnap(addr) : null;
    if (!q || q.booting) now = "booting";
  }
  const ts = new Date().toISOString();
  if (s.status !== now) {
    // The first check after startup does not know since when the device is like this.
    if (s.status !== "unknown") log(`status: ${d.name} ${s.status} -> ${now}`);
    s.since = s.status === "unknown" ? null : ts;
    if (now !== "on") Q.forget(d.id);
  }
  s.status = now;
  s.open_ports = open;
  s.checked = ts;

  if (s.wake && !s.wake.result) {
    if (now === "on") {
      s.wake.result = "up";
      s.wake.when = ts;
      log(`wol: ${d.name} came up after the magic packet`);
      if (d.wol !== "yes") {
        D.update(d.id, { wol: "yes" });
        log(`wol: ${d.name} marked as working (was: ${d.wol})`);
      }
    } else if (Date.now() - Date.parse(s.wake.requested) > WAKE_WAIT) {
      s.wake.result = "not_up";
      s.wake.when = ts;
      log(`wol: ${d.name} did not come up within 5 minutes`);
    }
  }
}

// Volumes and shares from the last read, on disk: the map shows them even
// when the NAS is off.
function saveStructure(d, m) {
  const everything = S.read("structure.json", {});
  everything[d.id] = {
    when: m.when,
    volumes: m.volumes.map(v => ({ name: v.name, type: v.type, total_bytes: v.total_bytes, free_bytes: v.free_bytes, shares: v.shares || [] })),
  };
  S.save("structure.json", everything);
}

async function metrics(d, force) {
  if (d.type !== "qnap") return;
  const s = state.get(d.id);
  if (!s || s.status !== "on" || s.reading) return;
  const age = s.metrics ? Date.now() - Date.parse(s.metrics.when) : Infinity;
  const lastTry = s.tried ? Date.now() - Date.parse(s.tried) : Infinity;
  if (!force && (age < METRICS_EVERY - 15000 || lastTry < METRICS_EVERY - 15000)) return;
  s.reading = true;
  s.tried = new Date().toISOString();
  try {
    s.metrics = await Q.read(d);
    s.metrics_error = null;
    saveStructure(d, s.metrics);
  } catch (e) {
    s.metrics_error = e.code && e.params ? { code: e.code, params: e.params } : e.message;
  } finally {
    s.reading = false;
  }
}

async function round() {
  const ds = D.all();
  for (const id of state.keys()) if (!ds.some(d => d.id === id)) { state.delete(id); Q.forget(id); }
  await Promise.all(ds.map(d => probe(d).catch(e => log(`probe ${d.name}: ${e.message}`))));
  await Promise.all(ds.map(d => metrics(d, false)));
}

function start(logger) {
  log = logger;
  if (S.DEMO) return; // the sample states come from src/demo.js
  Q.setLog(logger);
  const loop = async () => {
    try { await round(); } catch (e) { log(`ERROR monitor: ${e.stack || e}`); }
    setTimeout(loop, PROBE_EVERY).unref();
  };
  loop();
}

function list() {
  return D.all().map(d => {
    const s = S.DEMO ? require("./demo").deviceState(d.id) : state.get(d.id) || { status: "unknown" };
    const { reading, ...rest } = s;
    const c = d.type === "qnap" ? Q.credentialFor(d) : null;
    return {
      id: d.id, name: d.name, type: d.type, address: d.addresses[0], wol: d.wol, has_mac: d.mac.length > 0,
      metrics_account: c ? c.user : null, ...rest,
    };
  });
}

// No rate limit: if a read of the same NAS is already running, wait for it.
async function refreshNow(id) {
  const d = D.all().find(x => x.id === id);
  if (!d) throw S.error(404, "err.deviceNotFound");
  if (S.DEMO) return list().find(x => x.id === id);
  const s = state.get(d.id);
  if (s && s.reading) {
    while (s.reading) await new Promise(r => setTimeout(r, 300));
    return list().find(x => x.id === id);
  }
  await probe(d);
  await metrics(d, true);
  return list().find(x => x.id === id);
}

// force: try even on a device marked "not available" ("Try anyway" button
// on the Devices page): if it comes up, the mark corrects itself.
async function wake(id, force) {
  const d = D.all().find(x => x.id === id);
  if (!d) throw S.error(404, "err.deviceNotFound");
  if (S.DEMO) throw require("./demo").blocked();
  if (d.wol === "no" && !force) throw S.error(409, "err.noWol", { name: d.name });
  if (!d.mac.length) throw S.error(409, "err.noMac", { name: d.name });
  const s = state.get(d.id) || {};
  if (s.status === "on") throw S.error(409, "err.alreadyOn", { name: d.name });
  const broadcast = W.broadcastFor(d.addresses);
  await W.send(d.mac[0], broadcast);
  s.wake = { requested: new Date().toISOString(), result: null, mac: d.mac[0] };
  state.set(d.id, s);
  log(`wol: magic packet for ${d.name} (${d.mac[0]}) to ${broadcast}`);
  return { ok: true, mac: d.mac[0], broadcast };
}

module.exports = { start, list, refreshNow, wake };
