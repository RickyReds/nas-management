// Map: NAS -> volumes -> shares -> letters.
// Volumes and shares come from the last QTS read (structure.json); real
// letters from the agents' snapshots, planned ones from the profiles.
const os = require("os");
const S = require("./store");
const D = require("./devices");
const AG = require("./agents");
const P = require("./profiles");
const MON = require("./monitor");
const V = require("./vault");

const short = user => String(user || "").split("\\").pop();
const form = server => (/^\d+\.\d+\.\d+\.\d+$/.test(String(server || "")) ? "ip" : (server ? "name" : null));

// Addresses that count as "this PC" for whoever opens the page: its IP; if
// it is opened on the server itself (localhost), the server's addresses too.
function browserAddresses(ip) {
  const clean = String(ip || "").replace(/^::ffff:/, "");
  const set = new Set([clean]);
  if (clean === "127.0.0.1" || clean === "::1") {
    for (const nics of Object.values(os.networkInterfaces())) for (const i of nics || []) set.add(i.address);
  }
  return set;
}

function build(browserIp) {
  const here = browserAddresses(browserIp);
  const devices = D.all();
  const structure = S.read("structure.json", {});
  const states = MON.list();
  const machines = AG.all();
  const profiles = P.profiles();
  const vault = V.list();

  const tree = devices.filter(d => d.type === "qnap" || structure[d.id]).map(d => {
    const s = structure[d.id];
    const st = states.find(x => x.id === d.id) || {};
    return {
      id: d.id, name: d.name, model: d.model, address: d.addresses[0], addresses: d.addresses, status: st.status || "unknown",
      structure_read: s ? s.when : null,
      volumes: s ? s.volumes.map(v => ({ ...v, shares: v.shares.map(c => ({ ...c, letters: [] })) })) : [],
      others: [], // shares with letters but missing from the last read
    };
  });

  const attach = (devId, share, entry) => {
    const n = tree.find(x => x.id === devId);
    if (!n) return false;
    const name = share.toLowerCase();
    for (const v of n.volumes) {
      const c = v.shares.find(x => x.name.toLowerCase() === name);
      if (c) { c.letters.push(entry); return true; }
    }
    let c = n.others.find(x => x.name.toLowerCase() === name);
    if (!c) { c = { name: share, letters: [] }; n.others.push(c); }
    c.letters.push(entry);
    return true;
  };

  const outside = [];
  for (const m of machines) {
    for (const u of (m.snapshot && m.snapshot.drives) || []) {
      const p = P.split(u.path);
      const d = p && P.deviceOf(p.server, devices);
      // Windows does not say which NAS user a drive uses: it comes from the
      // machine's Credential Manager, entry by entry (one user per server).
      const cw = p && (m.windows_credentials || []).find(c => c.target.toLowerCase() === p.server.toLowerCase());
      const entry = {
        letter: u.letter, subfolder: p ? p.subfolder : "", kind: "real", column: `m:${m.id}`,
        where: `${AG.nameOf(m)} · ${short(m.user)}`, status: u.status, via: p ? p.server : "",
        user: cw ? short(cw.user) : null, form: form(p && p.server),
      };
      if (!d || !attach(d.id, p.share, entry)) outside.push({ ...entry, path: u.path });
    }
  }
  for (const pr of profiles) {
    for (const v of pr.entries) {
      const c = v.credential && vault.find(k => k.id === v.credential);
      attach(v.device, v.share, {
        letter: v.letter, subfolder: v.subfolder, kind: "planned", column: `p:${pr.id}`, where: pr.name,
        user: c ? c.user : null, form: null,
      });
    }
  }
  const sort = l => l.sort((a, b) => a.kind.localeCompare(b.kind) || a.letter.localeCompare(b.letter));
  for (const n of tree) {
    for (const v of n.volumes) for (const c of v.shares) sort(c.letters);
    for (const c of n.others) sort(c.letters);
  }
  // Grid columns: registered machines first, then profiles.
  // "occupied" feeds the letter picker; "addresses" and "manager" tell
  // whether a new drive needs a credential.
  const columns = [
    ...machines.map(m => ({
      id: `m:${m.id}`, type: "machine", title: AG.nameOf(m), subtitle: short(m.user), managed: m.managed,
      current: Boolean(m.ip && here.has(m.ip)),
      agent_version: m.agent_version || null,
      resolutions: m.resolutions || null,
      online: AG.isOnline(m),
      protected: m.protected_letters,
      occupied: Object.fromEntries(((m.snapshot && m.snapshot.drives) || []).map(u => [u.letter, u.path])),
      addresses: Object.fromEntries(devices.map(d => [d.id, P.addressInUse(m, d)])),
      manager: (m.windows_credentials || []).map(c => c.target.toLowerCase()),
      manager_users: Object.fromEntries((m.windows_credentials || []).map(c => [c.target.toLowerCase(), short(c.user)])),
    })),
    ...profiles.map(p => ({
      id: `p:${p.id}`, type: "profile", title: p.name, subtitle: null, protected: [],
      occupied: Object.fromEntries(p.entries.map(v => [v.letter, `${v.device}\\${v.share}${v.subfolder ? "\\" + v.subfolder : ""}`])),
    })),
  ];
  const credentials = vault.map(c => ({ id: c.id, user: c.user, role: c.role || "", devices: c.devices, has_password: c.has_password }));
  // NAS users in a fixed order: first the vault's, then those seen only in
  // the machines' Credential Manager. The order decides the colour.
  const users = [];
  const addUser = u => { if (u && !users.some(x => x.toLowerCase() === u.toLowerCase())) users.push(u); };
  vault.forEach(c => addUser(c.user));
  for (const n of tree) for (const v of n.volumes) for (const c of v.shares) c.letters.forEach(l => addUser(l.user));
  for (const n of tree) for (const c of n.others) c.letters.forEach(l => addUser(l.user));
  return { tree, outside, columns, credentials, users, machines: machines.length, current_agent: (AG.agentInfo() || {}).version || null };
}

module.exports = { build };
