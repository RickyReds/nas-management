// A credential rejected by a NAS is suspended on that NAS for EVERYONE:
// QNAP blocks the IP after a few failed logins, and four agents retrying
// in a loop would get there within a minute. Only unlocked by hand.
const S = require("./store");

const FILE = "suspensions.json";

const all = () => S.read(FILE, []);

function isSuspended(credential, device) {
  return all().some(s => s.credential === credential && s.device === device);
}

// message: plain text (from an agent) or { code, params }.
function suspend({ credential, device, machine, message }) {
  const s = all();
  if (s.some(x => x.credential === credential && x.device === device)) return;
  s.push({ credential, device, machine, message: typeof message === "string" ? message.slice(0, 500) : message, when: new Date().toISOString() });
  S.save(FILE, s);
}

function unlock(credential, device) {
  const s = all();
  const rest = s.filter(x => !(x.credential === credential && x.device === device));
  if (rest.length === s.length) throw S.error(404, "err.suspensionNotFound");
  S.save(FILE, rest);
}

module.exports = { all, isSuspended, suspend, unlock };
