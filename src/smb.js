// Shares of a NAS (or any SMB server), read by the server with its own
// Windows credentials through "net view". Works with any SMB server, QNAP or
// not; used by "Browse..." on the pages and, for generic devices, by the
// monitor to build the map (src/monitor.js).
const { execFile } = require("child_process");
const S = require("./store");

function shares(device) {
  // Demo: the shares of the sample structure, without asking anybody.
  if (S.DEMO) {
    const s = S.read("structure.json", {})[device.id];
    return Promise.resolve(s ? s.volumes.flatMap(v => v.shares.map(c => c.name)) : []);
  }
  return new Promise((ok, ko) => {
    const addr = device.addresses[0];
    execFile("net", ["view", `\\\\${addr}`, "/all"], { windowsHide: true, timeout: 15000, encoding: "latin1" }, (e, out) => {
      if (e) return ko(S.error(502, "err.sharesUnreadable", { device: device.name, error: String(out || e.message).trim().split(/\r?\n/).pop() || "-" }));
      const names = [];
      let inside = false;
      for (const line of String(out).split(/\r?\n/)) {
        if (/^-{10,}/.test(line)) { inside = true; continue; }
        const m = inside && line.match(/^(.+?)\s{2,}(Disco|Disk|Datentr|Disque)\S*\b/);
        if (m) names.push(m[1].trim());
      }
      ok(names);
    });
  });
}

module.exports = { shares };
