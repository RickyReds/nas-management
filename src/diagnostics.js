// Network diagnostics run by the agents. The diagnostic is fixed and
// read-only, written inside the agent: the server only sends the name or IP
// to check, never a command.
const crypto = require("crypto");
const S = require("./store");

const FILE = "diagnostics.json";
const MAX_PER_MACHINE = 10;
const pending = new Map(); // machine id -> [{ id, server, requested, delivered }]

function request(machine, server) {
  server = String(server || "").trim();
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(server)) throw S.error(400, "err.serverInvalid");
  const r = { id: crypto.randomBytes(4).toString("hex"), server, requested: new Date().toISOString(), delivered: null };
  const queue = pending.get(machine) || [];
  queue.push(r);
  pending.set(machine, queue);
  return r;
}

// The ones to hand to the agent in this check-in.
function toDeliver(machine) {
  const queue = pending.get(machine) || [];
  const now = Date.now();
  const out = queue.filter(r => !r.delivered || now - Date.parse(r.delivered) > 3 * 60 * 1000);
  for (const r of out) r.delivered = new Date().toISOString();
  return out.map(r => ({ id: r.id, server: r.server }));
}

function report(machine, { id, text }) {
  const queue = pending.get(machine) || [];
  const r = queue.find(x => x.id === id);
  if (!r) throw S.error(404, "err.diagnosticNotRequested");
  pending.set(machine, queue.filter(x => x !== r));
  const everything = S.read(FILE, {});
  const list = everything[machine] || [];
  list.push({ id, server: r.server, requested: r.requested, arrived: new Date().toISOString(), text: String(text || "").slice(0, 60000) });
  everything[machine] = list.slice(-MAX_PER_MACHINE);
  S.save(FILE, everything);
}

function status(machine) {
  return {
    pending: (pending.get(machine) || []).map(({ id, server, requested, delivered }) => ({ id, server, requested, delivered })),
    results: (S.read(FILE, {})[machine] || []).slice().reverse(),
  };
}

module.exports = { request, toDeliver, report, status };
