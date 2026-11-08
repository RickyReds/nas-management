// Checks the translation dictionaries against the code: every key used in
// src/, web/ and agent/ must exist in web/i18n/en.json and it.json, with the
// same {placeholders}. Unused keys are listed too.
//   node scripts/check-i18n.js          report
//   node scripts/check-i18n.js --keys   only print the keys used (one per line)
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PREFIXES = ["title", "meta", "nav", "settings", "common", "login", "devices", "cred", "wol", "time", "service", "status", "state", "map", "drives",
  "diag", "browse", "wizard", "preview", "action", "opStatus", "jobStatus", "mode", "jobs", "err", "warn", "msg", "result", "change", "installer", "agent"];
// Keys built at run time from a value: prefix -> possible values.
const DYNAMIC = {
  state: ["on", "off", "booting", "unknown"],
  wol: ["yes", "no", "untested"],
  preview: ["new", "same", "conflict", "to_remove"],
  action: ["mount", "replace", "remove"],
  opStatus: ["queued", "waiting", "ok", "error", "suspended", "cancelled"],
  jobStatus: ["queued", "running", "completed", "completed_with_errors", "cancelled"],
  mode: ["add", "align", "choice"],
};

function files(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "i18n") out.push(...files(f, ext)); }
    else if (ext.includes(path.extname(e.name))) out.push(f);
  }
  return out;
}

const used = new Set();
const re = new RegExp(`["'\`](?:${PREFIXES.join("|")})\\.[A-Za-z][A-Za-z0-9]*(?:\\.[A-Za-z0-9]+)*["'\`]`, "g");
const sources = [...files(path.join(ROOT, "src"), [".js"]), ...files(path.join(ROOT, "web"), [".js", ".html"])];
if (fs.existsSync(path.join(ROOT, "agent"))) sources.push(...files(path.join(ROOT, "agent"), [".ps1"]));
for (const f of sources) {
  const text = fs.readFileSync(f, "utf8");
  for (const m of text.match(re) || []) {
    const k = m.slice(1, -1);
    if (!/\.(js|json|ps1|log|html|css|svg|cmd)$/.test(k)) used.add(k);
  }
}
for (const [p, values] of Object.entries(DYNAMIC)) for (const v of values) used.add(`${p}.${v}`);

if (process.argv.includes("--keys")) {
  console.log([...used].sort().join("\n"));
  process.exit(0);
}

const holes = text => [...String(text).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(",");
let problems = 0;
const dicts = {};
for (const lang of ["en", "it"]) {
  const f = path.join(ROOT, "web", "i18n", `${lang}.json`);
  dicts[lang] = JSON.parse(fs.readFileSync(f, "utf8"));
  const missing = [...used].filter(k => !(k in dicts[lang])).sort();
  if (missing.length) { problems += missing.length; console.log(`${lang}: missing ${missing.length}\n  ${missing.join("\n  ")}`); }
}
for (const k of Object.keys(dicts.en)) {
  if (k in dicts.it && holes(dicts.en[k]) !== holes(dicts.it[k])) { problems++; console.log(`placeholders differ: ${k}  en {${holes(dicts.en[k])}}  it {${holes(dicts.it[k])}}`); }
}
const unused = Object.keys(dicts.en).filter(k => !used.has(k));
if (unused.length) console.log(`unused in en.json (${unused.length}): ${unused.join(", ")}`);
const onlyIt = Object.keys(dicts.it).filter(k => !(k in dicts.en));
if (onlyIt.length) { problems += onlyIt.length; console.log(`only in it.json: ${onlyIt.join(", ")}`); }
console.log(problems ? `${problems} problems` : `ok: ${used.size} keys`);
process.exitCode = problems ? 1 : 0;
