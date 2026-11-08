// Export and import of the configuration (spec 015): devices, profiles,
// config.json and the list of credentials WITHOUT passwords, in one JSON file.
//
// - Not exported: the vault's passwords (DPAPI: they only work on this server
//   for this user), the machines with their agent tokens (agents register
//   again), jobs, diagnostics, structure, sessions.
// - Two import modes:
//   merge    adds and updates by id, removes nothing;
//   replace  devices, profiles, credentials and config.json become exactly
//            those of the file.
// - A credential keeps its password only if it already exists with the same
//   id and the same user; otherwise it arrives as "password to enter", and
//   whatever uses it stays idle until the password is entered: nothing ever
//   logs in with an incomplete credential.
// - A profile that names a device or a credential missing after the import is
//   skipped, and the preview says why.
// - Before writing, every JSON file of data/ is copied to data/backup-<time>-import/.
const fs = require("fs");
const path = require("path");
const S = require("./store");
const CFG = require("./config");
const D = require("./devices");
const V = require("./vault");
const P = require("./profiles");

const FORMAT = "nas-management-export";
const VERSION = 1;
const MODES = ["merge", "replace"];
const ID = /^[a-z0-9-]{1,60}$/;

const appVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(S.ROOT, "package.json"), "utf8")).version; } catch { return "?"; } };
const credentialOut = c => ({ id: c.id, user: c.user, role: c.role || "", devices: c.devices || [], source: c.source || "" });
const profileOut = p => ({ id: p.id, name: p.name, entries: p.entries, updated: p.updated || null });

// Same content, whatever the key order.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

function exportFile() {
  return {
    format: FORMAT,
    version: VERSION,
    exported: new Date().toISOString(),
    app_version: appVersion(),
    devices: D.all(),
    profiles: P.profiles().map(profileOut),
    config: S.read("config.json", {}),
    credentials: V.list().map(credentialOut),
  };
}

function checkCredential(x, n) {
  const bad = field => S.error(400, "err.importCredentialInvalid", { n, field });
  if (!x || typeof x !== "object") throw bad("-");
  if (!ID.test(String(x.id || ""))) throw bad("id");
  const user = typeof x.user === "string" ? x.user.trim() : "";
  if (!user || user.length > 200) throw bad("user");
  for (const k of ["role", "source"]) if (x[k] != null && (typeof x[k] !== "string" || x[k].length > 500)) throw bad(k);
  if (x.devices != null && (!Array.isArray(x.devices) || x.devices.some(d => typeof d !== "string"))) throw bad("devices");
  return { id: x.id, user, role: x.role || "", devices: [...new Set(x.devices || [])], source: x.source || "" };
}

function noDuplicates(list, kind) {
  const seen = new Set();
  for (const x of list) {
    if (seen.has(x.id)) throw S.error(400, "err.importDuplicateId", { kind, id: x.id });
    seen.add(x.id);
  }
}

// Lists by id: what is added, updated, left as it is and (replace) removed.
function diff(current, incoming, mode, name) {
  const cur = new Map(current.map(x => [x.id, x]));
  const inc = new Map(incoming.map(x => [x.id, x]));
  const out = { add: [], update: [], same: [], remove: [] };
  for (const x of incoming) {
    const c = cur.get(x.id);
    if (!c) out.add.push(name(x));
    else if (stable(c) === stable(x)) out.same.push(name(x));
    else out.update.push(name(x));
  }
  if (mode === "replace") for (const c of current) if (!inc.has(c.id)) out.remove.push(name(c));
  return out;
}

// Everything the import would do, without writing anything.
function plan(file, mode) {
  if (!MODES.includes(mode)) throw S.error(400, "err.importModeInvalid");
  if (!file || typeof file !== "object" || file.format !== FORMAT) throw S.error(400, "err.importNotExport");
  if (!Number.isInteger(file.version) || file.version < 1) throw S.error(400, "err.importNotExport");
  if (file.version > VERSION) throw S.error(400, "err.importNewerVersion", { version: file.version });
  for (const k of ["devices", "profiles", "credentials"]) if (!Array.isArray(file[k])) throw S.error(400, "err.importNotExport");
  if (!file.config || typeof file.config !== "object" || Array.isArray(file.config)) throw S.error(400, "err.importNotExport");

  const warnings = [];

  // Devices
  const inDevices = file.devices.map((x, i) => D.checkImported(x, i + 1));
  noDuplicates(inDevices, "device");
  // The saved devices in the same clean form as the incoming ones, so that
  // equal content compares equal (a null metrics_credential, for example).
  const curDevices = D.all().map(d => { try { return D.checkImported(d, 0); } catch { return d; } });
  const finalDevices = mode === "replace" ? inDevices
    : [...curDevices.filter(c => !inDevices.some(x => x.id === c.id)), ...inDevices];
  const deviceIds = new Set(finalDevices.map(d => d.id));

  // Credentials: links to devices that will not exist are dropped.
  const inCreds = file.credentials.map((x, i) => checkCredential(x, i + 1));
  noDuplicates(inCreds, "credential");
  for (const c of inCreds) {
    const missing = c.devices.filter(d => !deviceIds.has(d));
    if (missing.length) {
      warnings.push({ code: "warn.importCredentialDeviceDropped", params: { user: c.user, devices: missing.join(", ") } });
      c.devices = c.devices.filter(d => deviceIds.has(d));
    }
  }
  const curCreds = V.list();
  const finalCreds = mode === "replace" ? inCreds
    : [...curCreds.filter(c => !inCreds.some(x => x.id === c.id)).map(credentialOut), ...inCreds];
  const curById = new Map(curCreds.map(c => [c.id, c]));
  const noPassword = finalCreds.filter(c => {
    const old = curById.get(c.id);
    return !(old && old.has_password && old.user.toLowerCase() === c.user.toLowerCase());
  }).map(c => c.user);

  // A device's metrics credential must exist and be linked to it.
  for (const d of finalDevices) {
    if (!d.metrics_credential) continue;
    const c = finalCreds.find(x => x.id === d.metrics_credential);
    if (!c || !c.devices.includes(d.id)) {
      warnings.push({ code: "warn.importMetricsCredentialDropped", params: { device: d.name } });
      delete d.metrics_credential;
    }
  }
  // Two devices answering to the same address confuse the map and the agents.
  const owner = new Map();
  for (const d of finalDevices) for (const a of d.addresses) {
    const k = a.toLowerCase();
    if (owner.has(k) && owner.get(k) !== d.id) warnings.push({ code: "warn.importSharedAddress", params: { address: a } });
    owner.set(k, d.id);
  }

  // Profiles: checked against the final devices and credentials.
  const inProfiles = [];
  const skipped = [];
  file.profiles.forEach((x, i) => {
    const label = (x && typeof x.name === "string" && x.name.trim()) || `#${i + 1}`;
    try {
      if (!x || !ID.test(String(x.id || ""))) throw S.error(400, "err.importProfileInvalid", { n: i + 1 });
      const v = P.validate(x, finalDevices, finalCreds);
      inProfiles.push({ id: x.id, ...v, updated: typeof x.updated === "string" ? x.updated : null });
    } catch (e) {
      skipped.push({ id: x && typeof x.id === "string" ? x.id : null, name: label, reason: { code: e.code || "err.internal", params: e.params || {} } });
    }
  });
  noDuplicates(inProfiles, "profile");
  const curProfiles = P.profiles().map(profileOut);
  const finalProfiles = mode === "replace" ? inProfiles
    : [...curProfiles.filter(c => !inProfiles.some(x => x.id === c.id)), ...inProfiles];

  // config.json: checked as the service would read it at startup.
  const curConfig = S.read("config.json", {});
  const finalConfig = mode === "replace" ? { ...file.config } : { ...curConfig, ...file.config };
  let before, after;
  try {
    before = CFG.normalize(curConfig);
    after = CFG.normalize(finalConfig);
  } catch (e) {
    throw S.error(400, "err.importConfigInvalid", { error: e.message });
  }
  const changed = Object.keys({ ...before, ...after }).filter(k => stable(before[k]) !== stable(after[k]));

  const same = (a, b) => stable(a.map(profileOut)) === stable(b);
  // A skipped profile is listed once: among the skipped, saying whether the
  // one already here goes away too (replace mode), not also among the removed.
  const profileDiff = diff(curProfiles, inProfiles, mode, p => p.name);
  const skippedNames = new Set();
  for (const s of skipped) {
    const existing = s.id && curProfiles.find(c => c.id === s.id);
    s.replaces_existing = Boolean(mode === "replace" && existing);
    if (s.replaces_existing) skippedNames.add(existing.name);
  }
  profileDiff.remove = profileDiff.remove.filter(n => !skippedNames.has(n));
  return {
    mode,
    file: { exported: typeof file.exported === "string" ? file.exported : null, app_version: typeof file.app_version === "string" ? file.app_version : null },
    devices: diff(curDevices, inDevices, mode, d => d.name),
    credentials: { ...diff(curCreds.map(credentialOut), inCreds, mode, c => c.user), no_password: noPassword },
    profiles: { ...profileDiff, skipped },
    config: {
      changed,
      needs_restart: changed.length > 0,
      needs_install_service: changed.includes("port") || changed.includes("taskName"),
      public_address_changed: changed.includes("publicAddress"),
    },
    warnings,
    nothing_to_do: stable(curDevices) === stable(finalDevices) && stable(curCreds.map(credentialOut)) === stable(finalCreds)
      && same(P.profiles(), finalProfiles) && stable(curConfig) === stable(finalConfig),
    _write: { devices: finalDevices, credentials: finalCreds, profiles: finalProfiles, config: finalConfig },
  };
}

function preview(file, mode) {
  const { _write, ...p } = plan(file, mode);
  return p;
}

// Copy of every JSON file of data/, before anything is written.
function backup() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const dir = path.join(S.DATA, `backup-${stamp}-import`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(S.DATA)) {
    if (f.endsWith(".json") && fs.statSync(path.join(S.DATA, f)).isFile()) fs.copyFileSync(path.join(S.DATA, f), path.join(dir, f));
  }
  return path.basename(dir);
}

function apply(file, mode) {
  const { _write, ...p } = plan(file, mode);
  if (p.nothing_to_do) return { ...p, backup: null };
  const folder = backup();
  // Order: what others refer to comes first.
  S.save("config.json", _write.config);
  S.save("devices.json", _write.devices);
  V.replaceCredentials(_write.credentials);
  S.save("profiles.json", _write.profiles);
  return { ...p, backup: folder };
}

module.exports = { exportFile, preview, apply };
