// Network drive profiles, preview, jobs for the agents, and restore.
// Warnings and outcomes are messages { code, params }: the page translates them.
const crypto = require("crypto");
const S = require("./store");
const D = require("./devices");
const V = require("./vault");
const M = require("./agents");
const SU = require("./suspensions");

const F_PROFILES = "profiles.json";
const F_JOBS = "jobs.json";
const MAX_JOBS = 300;
const LETTERS = "DEFGHIJKLMNOPQRSTUVWXYZ".split("");
const FINISHED = ["ok", "error", "suspended", "cancelled"];
const OPEN = ["queued", "running"];

const msg = (code, params) => ({ code, params: params || {} });
const profiles = () => S.read(F_PROFILES, []);
const jobs = () => S.read(F_JOBS, []);
const saveJobs = l => S.save(F_JOBS, l.slice(-MAX_JOBS));
const newId = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + crypto.randomBytes(3).toString("hex");
const drivesOf = m => (m.snapshot && m.snapshot.drives) || [];

// ---------------------------------------------------------------- paths

function split(p) {
  const m = String(p || "").match(/^\\\\([^\\]+)\\([^\\]+)(?:\\(.+?))?\\?$/);
  return m ? { server: m[1], share: m[2], subfolder: m[3] || "" } : null;
}

function deviceOf(server, devices) {
  const s = String(server).toLowerCase();
  return devices.find(d => d.addresses.some(a => a.toLowerCase() === s)) || null;
}

// For a new drive from the map: the address form (name or IP) the machine
// already uses for that NAS, so the Credential Manager has the credential
// and no second session opens; otherwise the preferred address.
function addressInUse(machine, device) {
  for (const u of drivesOf(machine)) {
    const p = split(u.path);
    if (p && device.addresses.some(a => a.toLowerCase() === p.server.toLowerCase())) return p.server;
  }
  return addressFor(machine, device);
}

function addressFor(machine, device) {
  return (machine.preferred_addresses || {})[device.id] || device.addresses[0];
}

function pathOf(entry, machine, devices) {
  const d = devices.find(x => x.id === entry.device);
  return `\\\\${addressFor(machine, d)}\\${entry.share}${entry.subfolder ? "\\" + entry.subfolder : ""}`;
}

// Same share on the same device, even if by name instead of by IP.
function samePath(a, b, devices) {
  const x = split(a), y = split(b);
  if (!x || !y) return String(a).toLowerCase() === String(b).toLowerCase();
  const dx = deviceOf(x.server, devices), dy = deviceOf(y.server, devices);
  const sameServer = dx && dy ? dx.id === dy.id : x.server.toLowerCase() === y.server.toLowerCase();
  return sameServer && x.share.toLowerCase() === y.share.toLowerCase()
    && x.subfolder.toLowerCase() === y.subfolder.toLowerCase();
}

// ------------------------------------------------------------- profiles

// devices and credentials: the registry to check against. An import checks
// its profiles against the devices and credentials it is about to write.
function validate({ name, entries }, devices = D.all(), credentials = V.list()) {
  name = String(name || "").trim();
  if (!name) throw S.error(400, "err.profileNeedsName");
  if (!Array.isArray(entries)) throw S.error(400, "err.needList", { field: "entries" });
  const seen = new Set();
  const credPerDevice = {};
  const clean = entries.map((v, i) => {
    const letter = String(v.letter || "").toUpperCase().replace(/:$/, "");
    if (!LETTERS.includes(letter)) throw S.error(400, "err.entryLetterInvalid", { n: i + 1 });
    if (seen.has(letter)) throw S.error(400, "err.letterUsedTwice", { letter });
    seen.add(letter);
    const d = devices.find(x => x.id === v.device);
    if (!d) throw S.error(400, "err.letterDeviceUnknown", { letter });
    const share = String(v.share || "").trim();
    if (!share || /[\\/]/.test(share) || S.badName(share)) throw S.error(400, "err.letterShareInvalid", { letter });
    const subfolder = String(v.subfolder || "").trim().replace(/\//g, "\\").replace(/^\\+|\\+$/g, "");
    if (subfolder.split("\\").some(p => p === "..") || S.badName(subfolder)) throw S.error(400, "err.letterSubfolderInvalid", { letter });
    const credential = v.credential || null;
    if (credential) {
      const c = credentials.find(x => x.id === credential);
      if (!c) throw S.error(400, "err.letterCredentialUnknown", { letter });
      if (!c.devices.includes(d.id)) throw S.error(400, "err.credentialNotLinked", { letter, user: c.user, device: d.name });
    }
    // Error 1219: one user per server in the same session.
    const k = credential || "(manager)";
    if (credPerDevice[d.id] && credPerDevice[d.id] !== k) throw S.error(400, "err.twoCredentialsProfile", { device: d.name });
    credPerDevice[d.id] = k;
    return { letter, device: d.id, share, subfolder, credential, write: Boolean(v.write) };
  }).sort((a, b) => a.letter.localeCompare(b.letter));
  return { name, entries: clean };
}

function create(data) {
  const p = profiles();
  const v = validate(data);
  const created = { id: S.freeId(S.slug(v.name), p.map(x => x.id)), ...v, updated: new Date().toISOString() };
  p.push(created);
  S.save(F_PROFILES, p);
  return created;
}

function update(id, data) {
  const p = profiles();
  const x = p.find(v => v.id === id);
  if (!x) throw S.error(404, "err.profileNotFound");
  Object.assign(x, validate(data), { updated: new Date().toISOString() });
  S.save(F_PROFILES, p);
  return x;
}

function remove(id) {
  const p = profiles();
  const rest = p.filter(v => v.id !== id);
  if (rest.length === p.length) throw S.error(404, "err.profileNotFound");
  S.save(F_PROFILES, rest);
}

// From a machine's snapshot: drives on registered devices become entries;
// the credential is inferred from the Windows Credential Manager.
function fromSnapshot({ machine, name }) {
  const m = M.all().find(x => x.id === machine);
  if (!m) throw S.error(404, "err.machineNotFound");
  if (!m.snapshot) throw S.error(409, "err.noSnapshotYet");
  const devices = D.all();
  const credentials = V.list();
  const entries = [], skipped = [];
  const used = {};
  for (const u of m.snapshot.drives) {
    const p = split(u.path);
    const d = p && deviceOf(p.server, devices);
    if (!d) { skipped.push(`${u.letter}: ${u.path}`); continue; }
    const cw = (m.windows_credentials || []).find(c => c.target.toLowerCase() === p.server.toLowerCase());
    const user = cw ? cw.user.split("\\").pop().toLowerCase() : null;
    const c = user && credentials.find(x => x.user.toLowerCase() === user && x.devices.includes(d.id));
    entries.push({ letter: u.letter, device: d.id, share: p.share, subfolder: p.subfolder, credential: c ? c.id : null, write: false });
    (used[d.id] ??= new Set()).add(p.server);
  }
  // Two credentials on the same NAS do not pass validation: leave it to the Credential Manager.
  const perDevice = {};
  for (const v of entries) (perDevice[v.device] ??= new Set()).add(v.credential || "");
  for (const v of entries) if (perDevice[v.device].size > 1) v.credential = null;

  const profile = create({ name: name || `${M.nameOf(m)} (${m.user})`, entries });
  return { profile, skipped, addresses: Object.fromEntries(Object.entries(used).map(([k, s]) => [k, [...s]])) };
}

// -------------------------------------------------------------- preview

// Warnings valid for every apply: agent, snapshot, Credential Manager
// (error 1219) and jobs already queued. `entries` are the ones to mount.
function commonWarnings(entries, m, devices) {
  const warnings = [];
  const add = w => { if (!warnings.some(x => JSON.stringify(x) === JSON.stringify(w))) warnings.push(w); };
  if (!m.snapshot) add(msg("warn.noSnapshot"));
  if (!M.isOnline(m)) add(msg("warn.agentOffline"));
  if (!m.managed) add(msg("warn.notManaged"));
  const credentials = V.list();
  for (const v of entries.filter(x => x.credential)) {
    const c = credentials.find(x => x.id === v.credential);
    const d = devices.find(x => x.id === v.device);
    const server = addressFor(m, d);
    const cw = (m.windows_credentials || []).find(x => x.target.toLowerCase() === server.toLowerCase());
    if (cw && c && cw.user.split("\\").pop().toLowerCase() !== c.user.toLowerCase()) {
      add(msg("warn.managerOtherUser", { server, manager: cw.user, user: c.user }));
    }
  }
  if (jobs().some(l => l.machine === m.id && OPEN.includes(l.status))) add(msg("warn.jobWillBeReplaced"));
  return warnings;
}

function previewMachine(profile, m, mode, devices) {
  const drives = drivesOf(m);
  const rows = [];
  for (const v of profile.entries) {
    const p = pathOf(v, m, devices);
    const now = drives.find(u => u.letter === v.letter);
    let status = "new";
    if (now) status = samePath(now.path, p, devices) ? "same" : "conflict";
    rows.push({ letter: v.letter, status, path: p, current: now ? now.path : null, protected: m.protected_letters.includes(v.letter) });
  }
  if (mode === "align") {
    for (const u of drives) {
      if (!profile.entries.some(v => v.letter === u.letter)) {
        rows.push({ letter: u.letter, status: "to_remove", path: null, current: u.path, protected: m.protected_letters.includes(u.letter) });
      }
    }
  }
  rows.sort((a, b) => a.letter.localeCompare(b.letter));

  const warnings = commonWarnings(profile.entries, m, devices);
  if (rows.some(r => r.protected && (r.status === "conflict" || r.status === "to_remove"))) {
    warnings.push(msg("warn.touchesProtected", { letters: m.protected_letters.join(", ") }));
  }
  return { machine: m.id, computer: M.nameOf(m), user: m.user, online: M.isOnline(m), rows, warnings };
}

function preview({ profile, machines, mode }) {
  const p = profiles().find(x => x.id === profile);
  if (!p) throw S.error(404, "err.profileNotFound");
  if (!["add", "align"].includes(mode)) throw S.error(400, "err.modeInvalid");
  if (!Array.isArray(machines) || !machines.length) throw S.error(400, "err.chooseMachine");
  const everyone = M.all();
  const devices = D.all();
  return machines.map(id => {
    const m = everyone.find(x => x.id === id);
    if (!m) throw S.error(404, "err.machineUnknown", { machine: id });
    return previewMachine(p, m, mode, devices);
  });
}

// ----------------------------------------------------------------- jobs

function enqueue(job) {
  const l = jobs();
  for (const x of l) {
    if (x.machine === job.machine && OPEN.includes(x.status)) {
      x.status = "cancelled";
      for (const op of x.operations) if (!FINISHED.includes(op.status)) op.status = "cancelled";
    }
  }
  l.push(job);
  saveJobs(l);
  return job;
}

const queuedOutcome = (machine, job, n) => ({ machine, outcome: msg("result.queued", { n }), job });

// Conflicting, protected or to-remove letters are only touched if the user
// ticked them in the preview (choices[machine] = ["F", ...]).
function apply({ profile, machines, mode, choices }) {
  const pre = preview({ profile, machines, mode });
  const p = profiles().find(x => x.id === profile);
  const everyone = M.all();
  const out = [];
  for (const a of pre) {
    const m = everyone.find(x => x.id === a.machine);
    if (!m.managed) { out.push({ machine: m.id, outcome: msg("result.notManagedSkipped") }); continue; }
    const ticked = new Set(((choices || {})[m.id] || []).map(s => String(s).toUpperCase()));
    const operations = [];
    for (const r of a.rows) {
      const v = p.entries.find(x => x.letter === r.letter);
      const base = { letter: r.letter, status: "queued", message: "" };
      if (r.status === "new" && (!r.protected || ticked.has(r.letter))) {
        operations.push({ ...base, action: "mount", path: r.path, old: null, device: v.device, credential: v.credential, write: v.write });
      } else if (r.status === "conflict" && ticked.has(r.letter)) {
        operations.push({ ...base, action: "replace", path: r.path, old: r.current, device: v.device, credential: v.credential, write: v.write });
      } else if (r.status === "to_remove" && ticked.has(r.letter)) {
        operations.push({ ...base, action: "remove", path: null, old: r.current, device: null, credential: null, write: false });
      }
    }
    if (!operations.length) { out.push({ machine: m.id, outcome: msg("result.nothingToDo") }); continue; }
    operations.forEach((op, i) => { op.n = i + 1; });
    const j = enqueue({
      id: newId(), type: "profile", machine: m.id, profile: p.id, profile_name: p.name, mode,
      created: new Date().toISOString(), status: "queued",
      restore: m.snapshot ? m.snapshot.drives : null,
      operations,
    });
    out.push(queuedOutcome(m.id, j.id, operations.length));
  }
  return out;
}

// Wizard: for each machine the user picks the drives to remove (even outside
// the profile) and the profile entries to mount, each on a letter that may
// differ from the profile's. The profile does not change.
//   machines: [{ machine, remove: ["S", ...], entries: [{ entry: "W", letter: "X" }] }]
// With `dryRun` it returns operations and warnings without queueing anything.
function choicePlan(p, m, { remove: toRemoveIn, entries }, devices) {
  const who = { machine: `${M.nameOf(m)} · ${m.user}` };
  const drives = drivesOf(m);
  const toRemove = new Set();
  for (const s of Array.isArray(toRemoveIn) ? toRemoveIn : []) {
    const l = String(s).toUpperCase().replace(/:$/, "");
    if (!drives.some(u => u.letter === l)) throw S.error(409, "err.notMountedReload", { ...who, letter: l });
    toRemove.add(l);
  }
  const taken = new Set();
  const mounts = [];
  for (const x of Array.isArray(entries) ? entries : []) {
    const v = p.entries.find(y => y.letter === String(x.entry || "").toUpperCase());
    if (!v) throw S.error(400, "err.entryNotInProfile", { ...who, entry: x.entry });
    const letter = String(x.letter || "").toUpperCase().replace(/:$/, "");
    if (!LETTERS.includes(letter)) throw S.error(400, "err.machineLetterInvalid", { ...who, letter: x.letter });
    if (taken.has(letter)) throw S.error(400, "err.letterAssignedTwice", { ...who, letter });
    taken.add(letter);
    mounts.push({ v, letter });
  }

  const operations = [];
  const mounted = [];
  for (const { v, letter } of mounts) {
    const p2 = pathOf(v, m, devices);
    const now = drives.find(u => u.letter === letter);
    const base = { letter, status: "queued", message: "", path: p2, device: v.device, credential: v.credential, write: v.write };
    if (now && samePath(now.path, p2, devices)) {
      toRemove.delete(letter); // already like this: no unmount just to mount it again
      continue;
    }
    if (now && !toRemove.has(letter)) throw S.error(400, "err.letterOccupied", { ...who, letter, path: now.path });
    if (now) {
      toRemove.delete(letter);
      operations.push({ ...base, action: "replace", old: now.path });
    } else {
      operations.push({ ...base, action: "mount", old: null });
    }
    mounted.push(v);
  }
  // Remove first, then mount: the agent runs them in order.
  const removals = [...toRemove].sort().map(l => ({
    letter: l, status: "queued", message: "", action: "remove", path: null,
    old: drives.find(u => u.letter === l).path, device: null, credential: null, write: false,
  }));
  const ops = [...removals, ...operations.sort((a, b) => a.letter.localeCompare(b.letter))];
  ops.forEach((op, i) => { op.n = i + 1; });

  const warnings = commonWarnings(mounted, m, devices);
  const prot = ops.filter(op => op.action !== "mount" && m.protected_letters.includes(op.letter)).map(op => op.letter);
  if (prot.length) warnings.push(msg("warn.touchesProtected", { letters: prot.join(", ") }));
  return { operations: ops, warnings };
}

function applyChoice({ profile, machines, dryRun }) {
  const p = profiles().find(x => x.id === profile);
  if (!p) throw S.error(404, "err.profileNotFound");
  if (!Array.isArray(machines) || !machines.length) throw S.error(400, "err.chooseMachine");
  const everyone = M.all();
  const devices = D.all();
  const plans = machines.map(s => {
    const m = everyone.find(x => x.id === s.machine);
    if (!m) throw S.error(404, "err.machineUnknown", { machine: s.machine });
    return { m, ...choicePlan(p, m, s, devices) };
  });
  if (dryRun) {
    return plans.map(({ m, operations, warnings }) => ({
      machine: m.id, computer: M.nameOf(m), user: m.user, online: M.isOnline(m), managed: m.managed,
      operations: operations.map(op => ({ letter: op.letter, action: op.action, path: op.path, old: op.old })),
      warnings,
    }));
  }
  return plans.map(({ m, operations }) => {
    if (!m.managed) return { machine: m.id, outcome: msg("result.notManagedSkipped") };
    if (!operations.length) return { machine: m.id, outcome: msg("result.nothingToDo") };
    const j = enqueue({
      id: newId(), type: "profile", machine: m.id, profile: p.id, profile_name: p.name, mode: "choice",
      created: new Date().toISOString(), status: "queued",
      restore: m.snapshot ? m.snapshot.drives : null,
      operations,
    });
    return queuedOutcome(m.id, j.id, operations.length);
  });
}

// Puts the machine back to the snapshot taken before a job. Drives are
// mounted again without a credential: the Credential Manager already had it.
function restore(id) {
  const l = jobs().find(x => x.id === id);
  if (!l) throw S.error(404, "err.jobNotFound");
  if (!l.restore) throw S.error(409, "err.noRestoreSnapshot");
  const m = M.all().find(x => x.id === l.machine);
  if (!m) throw S.error(404, "err.machineGone");
  const devices = D.all();
  const now = drivesOf(m);
  const operations = [];
  for (const u of now) {
    if (!l.restore.some(r => r.letter === u.letter)) operations.push({ letter: u.letter, action: "remove", path: null, old: u.path });
  }
  for (const r of l.restore) {
    const u = now.find(x => x.letter === r.letter);
    if (!u) operations.push({ letter: r.letter, action: "mount", path: r.path, old: null });
    else if (!samePath(u.path, r.path, devices)) operations.push({ letter: r.letter, action: "replace", path: r.path, old: u.path });
  }
  if (!operations.length) return { outcome: msg("result.alreadyRestored") };
  operations.sort((a, b) => a.letter.localeCompare(b.letter)).forEach((op, i) => {
    const p = op.path && split(op.path);
    const d = p && deviceOf(p.server, devices);
    Object.assign(op, { n: i + 1, status: "queued", message: "", device: d ? d.id : null, credential: null, write: false });
  });
  const j = enqueue({
    id: newId(), type: "restore", machine: m.id, profile: null, profile_name: null, restored_from: l.id, mode: null,
    created: new Date().toISOString(), status: "queued", restore: now, operations,
  });
  return { outcome: msg("result.queued", { n: operations.length }), job: j.id };
}

function cancel(id) {
  const l = jobs();
  const x = l.find(v => v.id === id);
  if (!x) throw S.error(404, "err.jobNotFound");
  if (!OPEN.includes(x.status)) throw S.error(409, "err.jobClosed");
  x.status = "cancelled";
  for (const op of x.operations) if (!FINISHED.includes(op.status)) op.status = "cancelled";
  saveJobs(l);
}

function closeIfDone(x) {
  if (!x.operations.every(op => FINISHED.includes(op.status))) return;
  x.status = x.operations.every(op => op.status === "ok") ? "completed" : "completed_with_errors";
  x.closed = new Date().toISOString();
}

// The job to hand to the agent, with the passwords encrypted for it.
function forAgent(m) {
  const l = jobs();
  const x = l.find(v => v.machine === m.id && OPEN.includes(v.status));
  if (!x) return null;
  const credentials = {};
  const todo = [];
  for (const op of x.operations) {
    if (!["queued", "waiting"].includes(op.status)) continue;
    if (op.credential && op.device && SU.isSuspended(op.credential, op.device)) {
      op.status = "suspended";
      op.message = msg("msg.credentialSuspended");
      continue;
    }
    if (op.credential && !credentials[op.credential]) {
      const pwd = V.password(op.credential);
      const c = V.list().find(v => v.id === op.credential);
      if (!pwd || !c) { op.status = "error"; op.message = msg("msg.noPasswordInVault"); continue; }
      credentials[op.credential] = { user: c.user, password: M.encryptFor(m, pwd) };
    }
    todo.push({ n: op.n, action: op.action, letter: op.letter, path: op.path, old: op.old, credential: op.credential, write: op.write });
  }
  closeIfDone(x);
  if (x.status === "queued" && todo.length) { x.status = "running"; x.delivered = new Date().toISOString(); }
  saveJobs(l);
  return todo.length ? { id: x.id, operations: todo, credentials } : null;
}

// What the agent says about an operation: its text, or a code it knows the
// page can translate (the agent's own messages, see agent/agent.ps1).
function agentMessage(e) {
  if (e.code && typeof e.code === "string" && /^agent\.[A-Za-z0-9]+$/.test(e.code)) {
    const params = {};
    for (const [k, v] of Object.entries(e.params || {})) if (/^\w{1,30}$/.test(k)) params[k] = String(v).slice(0, 300);
    return { code: e.code, params, text: String(e.message || "").slice(0, 500) };
  }
  return String(e.message || "").slice(0, 500);
}

function result(m, { job, results }) {
  const l = jobs();
  const x = l.find(v => v.id === job && v.machine === m.id);
  if (!x) throw S.error(404, "err.jobNotFound");
  if (x.status === "cancelled") return;
  for (const e of Array.isArray(results) ? results : []) {
    const op = x.operations.find(o => o.n === Number(e.n));
    if (!op || FINISHED.includes(op.status)) continue;
    const value = ["ok", "waiting", "error", "credential_error"].includes(e.result) ? e.result : "error";
    op.message = agentMessage(e);
    op.when = new Date().toISOString();
    if (value === "credential_error") {
      op.status = "suspended";
      if (op.credential && op.device) SU.suspend({ credential: op.credential, device: op.device, machine: m.id, message: op.message });
    } else {
      op.status = value;
    }
  }
  closeIfDone(x);
  saveJobs(l);
}

// After an unlock, the operations suspended for that pair are queued again.
// Only the latest job of each machine: an older one is already superseded.
function resumeSuspended(credential, device) {
  const l = jobs();
  const latest = {};
  for (const x of l) latest[x.machine] = x.id;
  let n = 0;
  for (const x of l) {
    if (latest[x.machine] !== x.id) continue;
    if (![...OPEN, "completed_with_errors"].includes(x.status)) continue;
    for (const op of x.operations) {
      if (op.status === "suspended" && op.credential === credential && op.device === device) {
        op.status = "queued"; op.message = msg("msg.resumedAfterUnlock"); n++;
        x.status = "running"; delete x.closed;
      }
    }
  }
  if (n) saveJobs(l);
  return n;
}

const jobList = () => jobs().slice(-60).reverse();

// -------------------------------------------------- changes from the map
//
// Each change is a cell: { column: "m:<machine>" | "p:<profile>",
// device, share, subfolder, old, new, address, credential, rewrite }.
// On a machine all old letters are removed first, then the new ones are
// mounted: this way swapping two shares works.

function cleanChange(x, devices) {
  const column = String(x.column || "");
  if (!/^[mp]:[a-z0-9-]+$/.test(column)) throw S.error(400, "err.columnInvalid");
  const d = devices.find(v => v.id === x.device);
  if (!d) throw S.error(400, "err.deviceUnknown", { device: x.device });
  const share = String(x.share || "").trim();
  if (!share || /[\\/]/.test(share) || S.badName(share)) throw S.error(400, "err.shareInvalid");
  const subfolder = String(x.subfolder || "").replace(/\//g, "\\").replace(/^\\+|\\+$/g, "");
  if (subfolder.split("\\").some(p => p === "..") || S.badName(subfolder)) throw S.error(400, "err.subfolderInvalid");
  const letter = v => {
    if (v == null || v === "") return null;
    const l = String(v).toUpperCase().replace(/:$/, "");
    if (!LETTERS.includes(l)) throw S.error(400, "err.letterInvalid", { letter: v });
    return l;
  };
  const oldL = letter(x.old), newL = letter(x.new);
  if (!oldL && !newL) throw S.error(400, "err.emptyChange");
  // Address chosen in the cell (name or IP): must be one of the registered ones.
  let address = null;
  if (x.address) {
    address = d.addresses.find(a => a.toLowerCase() === String(x.address).toLowerCase());
    if (!address) throw S.error(400, "err.notAnAddressOf", { address: x.address, device: d.name });
  }
  return { column, type: column[0] === "m" ? "machine" : "profile", id: column.slice(2), d, share, subfolder, old: oldL, new: newL, address, credential: x.credential || null };
}

function machinePlan(m, mods, credentials) {
  const drives = new Map(drivesOf(m).map(u => [u.letter, u.path]));
  const operations = [], warnings = [];
  const who = M.nameOf(m);
  // The existing path is kept, with its address (name or IP).
  for (const x of mods) if (x.old) {
    x.path = drives.get(x.old) || null;
    if (!x.path) warnings.push(msg("warn.letterGone", { letter: x.old }));
  }

  // Changing user on an address: Windows keeps one user per server, so all
  // the other letters going through that address on this machine are
  // mounted again with the new user too.
  const original = new Map(drives);
  const managerUser = s => {
    const c = (m.windows_credentials || []).find(k => k.target.toLowerCase() === s.toLowerCase());
    return c ? c.user.split("\\").pop() : null;
  };
  const changedServers = new Set();
  for (const x of [...mods]) {
    if (!x.credential || !x.new) continue;
    const k = credentials.find(v => v.id === x.credential);
    if (!k) continue;
    const tail = `${x.share}${x.subfolder ? "\\" + x.subfolder : ""}`;
    const sc = split(x.address ? `\\\\${x.address}\\${tail}` : (x.path || `\\\\${addressInUse(m, x.d)}\\${tail}`));
    if (!sc || changedServers.has(sc.server.toLowerCase())) continue;
    const current = managerUser(sc.server);
    if (!current || current.toLowerCase() === k.user.toLowerCase()) continue;
    changedServers.add(sc.server.toLowerCase());
    const others = [];
    for (const [L, p] of original) {
      const q = split(p);
      if (!q || q.server.toLowerCase() !== sc.server.toLowerCase()) continue;
      if (mods.some(y => y.old === L)) continue;
      mods.push({ ...x, old: L, new: L, path: p, address: null, share: q.share, subfolder: q.subfolder, d: deviceOf(q.server, D.all()) || x.d });
      others.push(`${L}:`);
    }
    warnings.push(others.length
      ? msg("warn.userChangesRemount", { server: sc.server, from: current, to: k.user, letters: others.join(", ") })
      : msg("warn.userChanges", { server: sc.server, from: current, to: k.user }));
  }

  for (const x of mods) if (x.old) {
    // user_before / user are only for the summary: the agent does not use them.
    const so = x.path && split(x.path);
    operations.push({ action: "remove", letter: x.old, path: null, old: x.path, device: null, credential: null, write: false,
      user_before: so ? managerUser(so.server) : null });
    if (m.protected_letters.includes(x.old)) warnings.push(msg("warn.letterProtected", { letter: x.old }));
    drives.delete(x.old);
  }
  const credPerServer = {};
  for (const x of mods) if (x.new) {
    const tail = `${x.share}${x.subfolder ? "\\" + x.subfolder : ""}`;
    const p = x.address ? `\\\\${x.address}\\${tail}` : (x.path || `\\\\${addressInUse(m, x.d)}\\${tail}`);
    const parts = split(p);
    if (!parts) throw S.error(400, "err.pathInvalid", { letter: x.new, path: p });
    const server = parts.server;
    const inManager = (m.windows_credentials || []).some(c => c.target.toLowerCase() === server.toLowerCase());
    if (x.credential) {
      const c = credentials.find(v => v.id === x.credential);
      if (!c || !c.devices.includes(x.d.id)) throw S.error(400, "err.credentialNotLinkedTo", { letter: x.new, device: x.d.name });
    } else if (!inManager) {
      throw S.error(400, "err.needCredential", { machine: who, letter: x.new, server });
    }
    const k = server.toLowerCase();
    if (x.credential) {
      if (credPerServer[k] && credPerServer[k] !== x.credential) throw S.error(400, "err.twoCredentialsServer", { machine: who, server });
      credPerServer[k] = x.credential;
    }
    const occupied = drives.get(x.new) || null;
    if (occupied) warnings.push(msg("warn.willBeReplaced", { letter: x.new, path: occupied }));
    if (occupied && m.protected_letters.includes(x.new)) warnings.push(msg("warn.letterProtected", { letter: x.new }));
    const so = occupied && split(occupied);
    const kNew = x.credential && credentials.find(v => v.id === x.credential);
    operations.push({ action: occupied ? "replace" : "mount", letter: x.new, path: p, old: occupied, device: x.d.id, credential: x.credential, write: false,
      user: kNew ? kNew.user : managerUser(server), user_before: so ? managerUser(so.server) : null });
    drives.set(x.new, p);
  }
  if (!m.managed) warnings.push(msg("warn.machineNotManaged"));
  else if (!M.isOnline(m)) warnings.push(msg("warn.agentOfflineQueued"));
  return { column: `m:${m.id}`, type: "machine", title: `${who} · ${m.user.split("\\").pop()}`, machine: m.id, managed: m.managed, operations, warnings };
}

function profilePlan(p, mods) {
  let entries = p.entries.map(v => ({ ...v }));
  const changes = [], warnings = [];
  const removed = [];
  for (const x of mods) if (x.old) {
    const i = entries.findIndex(v => v.letter === x.old && v.device === x.d.id && v.share.toLowerCase() === x.share.toLowerCase());
    if (i >= 0) { removed.push({ x, entry: entries[i] }); entries.splice(i, 1); }
    if (!x.new) changes.push(msg("change.removes", { letter: x.old, device: x.d.name, share: x.share }));
  }
  for (const x of mods) if (x.new) {
    const other = entries.find(v => v.letter === x.new);
    if (other) {
      entries = entries.filter(v => v !== other);
      warnings.push(msg("warn.profileLetterReplaced", { letter: x.new, device: other.device, share: other.share }));
    }
    const before = removed.find(t => t.x === x);
    const sameNas = entries.find(v => v.device === x.d.id);
    const base = before ? before.entry : {
      device: x.d.id, share: x.share, subfolder: x.subfolder,
      credential: sameNas ? sameNas.credential : null, write: false,
    };
    entries.push({ ...base, letter: x.new });
    changes.push(x.old
      ? msg("change.moves", { from: x.old, to: x.new, device: x.d.name, share: x.share })
      : msg("change.adds", { letter: x.new, device: x.d.name, share: x.share }));
  }
  const v = validate({ name: p.name, entries });
  return { column: `p:${p.id}`, type: "profile", title: p.name, profile: p.id, changes, warnings, entries: v.entries };
}

function mapPlan(changes) {
  if (!Array.isArray(changes) || !changes.length) throw S.error(400, "err.noChanges");
  const devices = D.all();
  const credentials = V.list();
  const groups = new Map();
  for (const x of changes.map(v => cleanChange(v, devices))) {
    if (!groups.has(x.column)) groups.set(x.column, []);
    groups.get(x.column).push(x);
  }
  const machines = M.all(), profs = profiles();
  return [...groups.entries()].map(([column, mods]) => {
    if (column[0] === "m") {
      const m = machines.find(v => v.id === column.slice(2));
      if (!m) throw S.error(404, "err.machineNotFound");
      return machinePlan(m, mods, credentials);
    }
    const p = profs.find(v => v.id === column.slice(2));
    if (!p) throw S.error(404, "err.profileNotFound");
    return profilePlan(p, mods);
  });
}

function mapApply(changes) {
  const plans = mapPlan(changes);
  const machines = M.all();
  return plans.map(pl => {
    if (pl.type === "profile") {
      update(pl.profile, { name: pl.title, entries: pl.entries });
      return { column: pl.column, outcome: msg("result.profileUpdated", { name: pl.title }) };
    }
    if (!pl.managed) return { column: pl.column, outcome: msg("result.notManagedSkipped") };
    if (!pl.operations.length) return { column: pl.column, outcome: msg("result.nothingToDo") };
    const m = machines.find(v => v.id === pl.machine);
    const operations = pl.operations.map((op, i) => ({ ...op, n: i + 1, status: "queued", message: "" }));
    const j = enqueue({
      id: newId(), type: "map", machine: m.id, profile: null, profile_name: null, mode: null,
      created: new Date().toISOString(), status: "queued", restore: m.snapshot ? m.snapshot.drives : null, operations,
    });
    return { column: pl.column, outcome: msg("result.queued", { n: operations.length }), job: j.id };
  });
}

module.exports = {
  profiles, validate, create, update, remove, fromSnapshot, preview, apply, applyChoice, restore, cancel,
  forAgent, result, resumeSuspended, jobList, split, deviceOf, addressFor, addressInUse, mapPlan, mapApply,
};
