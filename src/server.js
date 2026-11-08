// NAS-Management service: web pages and API. No npm dependencies.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const S = require("./store");

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(" ")}`;
  console.log(line);
  try { fs.mkdirSync(S.DATA, { recursive: true }); fs.appendFileSync(path.join(S.DATA, "service.log"), line + "\n"); } catch { }
}

// Data from the Italian versions is converted before anything reads it.
try {
  require("./migrate").run(log);
} catch (e) {
  log("FATAL ERROR: data migration failed, nothing was started.", e.stack || e.message);
  process.exit(1);
}
// Demo mode: sample data written before anything reads it (config.json included).
if (S.DEMO) {
  try {
    require("./demo").prepare(log);
  } catch (e) {
    log("FATAL ERROR: demo data could not be prepared.", e.stack || e.message);
    process.exit(1);
  }
}

const CFG = require("./config");
const I18N = require("./i18n");
const V = require("./vault");
const D = require("./devices");
const AG = require("./agents");
const P = require("./profiles");
const SU = require("./suspensions");
const MON = require("./monitor");
const DG = require("./diagnostics");

const PORT = CFG.port;
const HOST = CFG.host;
const WEB = path.join(S.ROOT, "web");
const SESSION_LIFETIME = 12 * 3600 * 1000;
// Sessions: only the sha256 fingerprint of the cookie goes to disk, so a
// restart logs nobody out. The renewal on each request stays in memory and
// is saved at most once a minute.
const fingerprint = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const sessions = new Map(Object.entries(S.read("sessions.json", {})).filter(([, expires]) => expires > Date.now()));
let lastSave = 0;
function saveSessions(now) {
  if (!now && Date.now() - lastSave < 60000) return;
  lastSave = Date.now();
  try { S.save("sessions.json", Object.fromEntries([...sessions].filter(([, expires]) => expires > Date.now()))); } catch { }
}
const STARTED = Date.now();
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(S.ROOT, "package.json"), "utf8")).version; } catch { return "?"; } })();

// Code in src/ newer than the start time: the page offers a restart.
function serviceStatus() {
  const dir = path.join(S.ROOT, "src");
  let modified = 0;
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".js")) modified = Math.max(modified, fs.statSync(path.join(dir, f)).mtimeMs);
  // The version is read once at startup: it is the one of the code actually running.
  return { version: VERSION, started: new Date(STARTED).toISOString(), code_modified: new Date(modified).toISOString(), needs_restart: modified > STARTED, agent: AG.agentInfo() };
}

// Restart: a separate PowerShell waits for this process to exit, then starts
// the scheduled task again; if Windows does not allow it, it starts node
// directly with no window. Then this process exits.
function restart() {
  if (S.DEMO) throw require("./demo").blocked();
  const node = process.execPath.replace(/'/g, "''");
  const server = path.join(S.ROOT, "src", "server.js").replace(/'/g, "''");
  const root = S.ROOT.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$port = ${PORT}`,
    "for ($i = 0; $i -lt 20; $i++) { if (-not (Get-NetTCPConnection -LocalPort $port -State Listen)) { break }; Start-Sleep -Milliseconds 500 }",
    `try { Start-ScheduledTask -TaskName '${CFG.taskName}' -ErrorAction Stop } catch { }`,
    "Start-Sleep -Seconds 6",
    `if (-not (Get-NetTCPConnection -LocalPort $port -State Listen)) { Start-Process -FilePath "$env:WINDIR\\System32\\conhost.exe" -ArgumentList @('--headless', '"${node}"', '"${server}"') -WorkingDirectory '${root}' -WindowStyle Hidden }`,
  ].join("\n");
  // The scheduled task keeps the service in a Windows "job": when the
  // service exits, Windows also closes the processes it started. So the
  // process that restarts the service is created by WMI
  // (Win32_Process.Create), outside the job.
  const inner = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  const launch = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${inner}' }; exit [int]$r.ReturnValue`;
  try {
    require("child_process").execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(launch, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 20000, stdio: "ignore" });
  } catch (e) {
    log("restart cancelled: cannot create the process that restarts the service:", e.message);
    return false;
  }
  log("restart requested from the page");
  setTimeout(() => { saveSessions(true); process.exit(0); }, 400);
  return true;
}
let failedLogins = [];

// Answers over 1 KB (the map, the jobs) travel compressed when the client
// asks for it; the agents (Invoke-RestMethod in Windows PowerShell) do not.
function send(res, status, data) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  let out = Buffer.from(JSON.stringify(data));
  if (out.length > 1024) {
    headers["Vary"] = "Accept-Encoding";
    if (/\bgzip\b/.test((res.req && res.req.headers["accept-encoding"]) || "")) {
      out = zlib.gzipSync(out);
      headers["Content-Encoding"] = "gzip";
    }
  }
  res.writeHead(status, headers);
  res.end(out);
}

function sendError(res, status, code, params) {
  send(res, status, { error: I18N.t("en", code, params), code, params: params || {} });
}

// max: 64 KB for everything, except an imported configuration file.
function body(req, max = 65536) {
  return new Promise((ok, ko) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", d => {
      s += d;
      if (s.length > max) { ko(S.error(413, "err.bodyTooLarge")); req.destroy(); }
    });
    req.on("end", () => {
      try { ok(s ? JSON.parse(s) : {}); } catch { ko(S.error(400, "err.invalidJson")); }
    });
  });
}

function sid(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)nasm=([A-Za-z0-9_-]+)/);
  return m && m[1];
}

function authenticated(req) {
  const s = sid(req);
  const k = s && fingerprint(s);
  const expires = k && sessions.get(k);
  if (!expires || expires < Date.now()) { if (k) { sessions.delete(k); saveSessions(true); } return false; }
  sessions.set(k, Date.now() + SESSION_LIFETIME);
  saveSessions(false);
  return true;
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
};
// Old page addresses (Italian versions): bookmarks keep working.
const OLD_PAGES = { "/stato.html": "/status.html", "/mappa.html": "/map.html", "/profili.html": "/drives.html" };

function staticFile(req, res, p) {
  if (OLD_PAGES[p]) { res.writeHead(301, { Location: OLD_PAGES[p] }); return res.end(); }
  if (p === "/") p = "/index.html";
  if (p === "/favicon.ico") p = "/icon.svg";
  let f;
  try { f = path.normalize(path.join(WEB, decodeURIComponent(p))); } catch { return sendError(res, 400, "err.notFound"); }
  const type = TYPES[path.extname(f)];
  if (!f.startsWith(WEB + path.sep) || !type || !fs.existsSync(f) || !fs.statSync(f).isFile()) return sendError(res, 404, "err.notFound");
  const headers = { "Content-Type": type, "Cache-Control": "no-cache", "Vary": "Accept-Encoding" };
  if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    res.writeHead(200, { ...headers, "Content-Encoding": "gzip" });
    fs.createReadStream(f).pipe(zlib.createGzip()).pipe(res);
  } else {
    res.writeHead(200, headers);
    fs.createReadStream(f).pipe(res);
  }
}

// Wrong keys: 5 per address in 10 minutes, so one PC typing wrong keys on
// purpose does not lock everybody else out; 50 in all, as a ceiling against
// many addresses at once.
const LOGIN_WINDOW = 10 * 60 * 1000;
const LOGIN_PER_ADDRESS = 5;
const LOGIN_TOTAL = 50;

async function login(req, res) {
  const now = Date.now();
  const from = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  failedLogins = failedLogins.filter(f => now - f.at < LOGIN_WINDOW);
  if (failedLogins.length >= LOGIN_TOTAL || failedLogins.filter(f => f.from === from).length >= LOGIN_PER_ADDRESS) {
    return sendError(res, 429, "err.tooManyAttempts");
  }
  if (!V.hasKey()) return sendError(res, 503, "err.noAccessKey");
  const { key } = await body(req);
  if (!V.checkKey(String(key || ""))) {
    failedLogins.push({ at: now, from });
    log("login rejected from", req.socket.remoteAddress);
    return sendError(res, 401, "err.wrongKey");
  }
  const s = crypto.randomBytes(24).toString("base64url");
  sessions.set(fingerprint(s), now + SESSION_LIFETIME);
  saveSessions(true);
  res.setHeader("Set-Cookie", `nasm=${s}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_LIFETIME / 1000}`);
  log("login from", req.socket.remoteAddress);
  return send(res, 200, { ok: true });
}

// The agent files are downloaded without login: they contain no secrets.
// Server address as seen by the machine that opened the page; from
// localhost the network address (publicAddress in config.json) is used,
// which the other machines can reach.
function serverAddress(req) {
  const host = String(req.headers.host || "");
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host) || /^(localhost|127\.)/i.test(host)) return CFG.publicAddress;
  return `http://${host}`;
}

// Double-click installer: a .cmd with server and code inside, which
// downloads install-agent.ps1 and runs it in the user's normal session.
// cmd.exe echoes text literally, except for a few characters: they are
// removed from the translated lines.
function installer(req, res, code, lang) {
  const expires = AG.codeValid(code);
  if (!expires) throw S.error(403, "err.codeExpired");
  const server = serverAddress(req);
  const t = (k, p) => I18N.t(lang, k, p).replace(/[%^&|<>"]/g, "");
  const time = expires.toLocaleTimeString(lang === "it" ? "it-IT" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  const lines = [
    "@echo off",
    `rem ${t("installer.comment1")}`,
    `rem ${t("installer.comment2", { time })}`,
    `rem ${t("installer.comment3")}`,
    "setlocal",
    "chcp 65001 >nul",
    `set "SERVER=${server}"`,
    `set "CODE=${String(code).toUpperCase()}"`,
    `set "LANG_NASM=${lang}"`,
    'set "PS1=%TEMP%\\install-agent-nasm.ps1"',
    `echo ${t("installer.installing")} %USERDOMAIN%\\%USERNAME%...`,
    "echo.",
    "powershell -NoProfile -ExecutionPolicy Bypass -Command \"Invoke-WebRequest -UseBasicParsing -Uri '%SERVER%/agent/install-agent.ps1' -OutFile $env:TEMP\\install-agent-nasm.ps1\"",
    "if errorlevel 1 goto failed",
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Server "%SERVER%" -Code "%CODE%" -Language "%LANG_NASM%"',
    "if errorlevel 1 goto failed",
    'del "%PS1%" >nul 2>&1',
    "echo.",
    `echo ${t("installer.done")}`,
    "pause",
    "exit /b 0",
    ":failed",
    'del "%PS1%" >nul 2>&1',
    "echo.",
    `echo ${t("installer.failed")}`,
    "pause",
    "exit /b 1",
  ];
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${t("installer.fileName")}.cmd"`,
    "Cache-Control": "no-store",
  });
  res.end(lines.join("\r\n") + "\r\n");
}

function agentFile(res, name) {
  const f = path.join(S.ROOT, "agent", name);
  if (!fs.existsSync(f)) return sendError(res, 404, "err.notFound");
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
  fs.createReadStream(f).pipe(res);
}

// The shares of a NAS: src/smb.js.
const shares = device => require("./smb").shares(device);

// Subfolders of a share, read by the server over SMB with its own Windows
// credentials. QNAP system folders are hidden.
async function folders(d, share, sub) {
  share = String(share || "");
  if (!share || /[\\/:*?"<>|]/.test(share)) throw S.error(400, "err.shareInvalid");
  const parts = String(sub || "").split(/[\\/]+/).filter(Boolean);
  if (parts.some(x => x === "." || x === ".." || /[:*?"<>|]/.test(x))) throw S.error(400, "err.pathNotValid");
  if (S.DEMO) return { path: parts.join("\\"), folders: [] };
  const addr = d.addresses[0];
  if (!(await D.port(addr, 445, 1500))) throw S.error(503, "err.deviceNotAnswering", { device: d.name });
  const base = `\\\\${addr}\\${share}${parts.length ? "\\" + parts.join("\\") : ""}`;
  let entries;
  try {
    entries = await Promise.race([
      fs.promises.readdir(base, { withFileTypes: true }),
      new Promise((_, ko) => setTimeout(() => ko(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), 20000)),
    ]);
  } catch (e) {
    const code = e.code === "ENOENT" ? "err.folderNotFound"
      : (e.code === "EPERM" || e.code === "EACCES") ? "err.folderAccessDenied"
      : e.code === "TIMEOUT" ? "err.folderTimeout"
      : e.code === "UNKNOWN" ? "err.folderUnreachable"
      : "err.folderError";
    throw S.error(502, code, { path: base, error: e.message });
  }
  return {
    path: parts.join("\\"),
    folders: entries.filter(v => v.isDirectory() && !/^[.@#$]/.test(v.name)).map(v => v.name)
      .sort((a, b) => a.localeCompare(b)).slice(0, 1000),
  };
}

async function agentApi(req, res, p) {
  if (p === "/api/agent/register") {
    if (S.DEMO) throw require("./demo").blocked();
    const r = AG.register(await body(req));
    log("agent registered:", r.id, "from", req.socket.remoteAddress);
    return send(res, 200, r);
  }
  const m = AG.fromRequest(req);
  if (!m) return sendError(res, 401, "err.agentTokenInvalid");
  const b = await body(req);
  if (p === "/api/agent/checkin") {
    AG.report(m.id, b, req.socket.remoteAddress);
    return send(res, 200, { job: m.managed ? P.forAgent(m) : null, interval: 60, agent: AG.agentInfo(), diagnostics: DG.toDeliver(m.id), names: AG.namesToResolve(D.all()) });
  }
  if (p === "/api/agent/diagnostics") {
    DG.report(m.id, b);
    log("diagnostic received from", m.id, "for", b.id);
    return send(res, 200, { ok: true });
  }
  if (p === "/api/agent/result") {
    P.result(m, b);
    if (b.snapshot) AG.report(m.id, b.snapshot, req.socket.remoteAddress);
    log("result from", m.id, "job", b.job, (b.results || []).map(e => `${e.n}:${e.result}`).join(" "));
    return send(res, 200, { ok: true });
  }
  return sendError(res, 404, "err.notFound");
}

async function api(req, res, p) {
  if (p.startsWith("/api/agent/") && req.method === "POST") return agentApi(req, res, p);
  return pageApi(req, res, p);
}

// A request that changes something must come from the pages of this very
// service. SameSite=Strict cookies also travel from another app on the same
// host (another port is the same "site"), and a plain form can post a JSON
// body as text/plain without any preflight. Browsers always send Origin with
// these methods; the agents do not use this API.
function sameOrigin(req) {
  if (req.method === "GET" || req.method === "HEAD") return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === String(req.headers.host || ""); } catch { return false; }
}

async function pageApi(req, res, p) {
  const M = req.method;
  if (!sameOrigin(req)) {
    log("request refused, foreign origin:", M, p, String(req.headers.origin).slice(0, 100));
    return sendError(res, 403, "err.foreignOrigin");
  }
  if (p === "/api/login" && M === "POST") return login(req, res);
  if (p === "/api/logout" && M === "POST") {
    if (sid(req)) sessions.delete(fingerprint(sid(req)));
    saveSessions(true);
    res.setHeader("Set-Cookie", "nasm=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    return send(res, 200, { ok: true });
  }
  // The login page asks this first: not being logged in is an answer, not an error.
  if (p === "/api/session" && M === "GET") return send(res, 200, { ok: authenticated(req) });
  if (!authenticated(req)) return sendError(res, 401, "err.loginRequired");

  if (p === "/api/service" && M === "GET") return send(res, 200, serviceStatus());
  if (p === "/api/service/restart" && M === "POST") {
    if (!restart()) throw S.error(500, "err.restartFailed");
    return send(res, 200, { ok: true });
  }

  if (p === "/api/devices") {
    if (M === "GET") return send(res, 200, D.all());
    if (M === "POST") return send(res, 201, await D.add(await body(req)));
  }
  let m = p.match(/^\/api\/devices\/([a-z0-9-]+)$/);
  if (m) {
    if (M === "PATCH") {
      const b = await body(req);
      if (b.metrics_credential) {
        const c = V.list().find(x => x.id === b.metrics_credential);
        if (!c || !c.devices.includes(m[1])) throw S.error(400, "err.metricsCredentialNotLinked");
      }
      return send(res, 200, D.update(m[1], b));
    }
    if (M === "DELETE") { D.remove(m[1]); V.removeDevice(m[1]); return send(res, 200, { ok: true }); }
  }

  if (p === "/api/credentials") {
    if (M === "GET") return send(res, 200, V.list());
    if (M === "POST") {
      const b = await body(req);
      const known = new Set(D.all().map(d => d.id));
      if (Array.isArray(b.devices) && b.devices.some(d => !known.has(d))) throw S.error(400, "err.deviceUnknown", { device: b.devices.find(d => !known.has(d)) });
      return send(res, 200, V.write(b));
    }
  }
  m = p.match(/^\/api\/credentials\/([a-z0-9-]+)$/);
  if (m && M === "DELETE") { V.remove(m[1]); return send(res, 200, { ok: true }); }

  // --- export and import of the configuration (src/transfer.js)
  if (p === "/api/config/export" && M === "GET") {
    const data = require("./transfer").exportFile();
    const day = data.exported.slice(0, 10);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="nas-management-${day}.json"`,
      "Cache-Control": "no-store",
    });
    log("configuration exported");
    return res.end(JSON.stringify(data, null, 2) + "\n");
  }
  if ((p === "/api/config/import/preview" || p === "/api/config/import") && M === "POST") {
    const { file, mode } = await body(req, 4 * 1024 * 1024);
    const T = require("./transfer");
    if (p.endsWith("/preview")) return send(res, 200, T.preview(file, mode));
    const r = T.apply(file, mode);
    log("configuration imported, mode", mode, r.backup ? `backup in ${r.backup}` : "(nothing to do)");
    return send(res, 200, r);
  }

  // --- status, metrics and wake-up
  if (p === "/api/status" && M === "GET") return send(res, 200, MON.list());
  if (p === "/api/map" && M === "GET") return send(res, 200, require("./map").build(req.socket.remoteAddress));
  if (p === "/api/map/plan" && M === "POST") return send(res, 200, P.mapPlan((await body(req)).changes));
  if (p === "/api/map/apply" && M === "POST") {
    const { changes } = await body(req);
    const r = P.mapApply(changes);
    log("changes from the map:", (changes || []).length, "cells ->", r.map(x => `${x.column} ${x.outcome.code}`).join("; "));
    return send(res, 200, r);
  }
  m = p.match(/^\/api\/devices\/([a-z0-9-]+)\/(wake|refresh)$/);
  if (m && M === "POST") {
    if (m[2] === "wake") return send(res, 200, await MON.wake(m[1], Boolean((await body(req)).force)));
    return send(res, 200, await MON.refreshNow(m[1]));
  }

  m = p.match(/^\/api\/devices\/([a-z0-9-]+)\/folders$/);
  if (m && M === "GET") {
    const d = D.all().find(x => x.id === m[1]);
    if (!d) throw S.error(404, "err.deviceNotFound");
    const q = new URL(req.url, "http://x").searchParams;
    return send(res, 200, await folders(d, q.get("share"), q.get("path")));
  }

  m = p.match(/^\/api\/devices\/([a-z0-9-]+)\/shares$/);
  if (m && M === "GET") {
    const d = D.all().find(x => x.id === m[1]);
    if (!d) throw S.error(404, "err.deviceNotFound");
    return send(res, 200, await shares(d));
  }

  // --- machines and agents
  if (p === "/api/machines" && M === "GET") return send(res, 200, AG.list());
  if (p === "/api/machines/code" && M === "POST") return send(res, 200, { ...AG.newCode(), server: serverAddress(req) });
  if (p === "/api/machines/installer.cmd" && M === "GET") {
    const q = new URL(req.url, "http://x").searchParams;
    return installer(req, res, q.get("code"), I18N.pickLang(q.get("lang")));
  }
  m = p.match(/^\/api\/machines\/([a-z0-9-]+)$/);
  if (m && M === "PATCH") return send(res, 200, AG.update(m[1], await body(req), D.all()));
  if (m && M === "DELETE") { AG.remove(m[1]); return send(res, 200, { ok: true }); }
  m = p.match(/^\/api\/machines\/([a-z0-9-]+)\/diagnostics$/);
  if (m) {
    if (!AG.all().some(x => x.id === m[1])) throw S.error(404, "err.machineNotFound");
    if (M === "GET") return send(res, 200, DG.status(m[1]));
    if (M === "POST") { const r = DG.request(m[1], (await body(req)).server); log("diagnostic requested from", m[1], "for", r.server); return send(res, 200, r); }
  }

  // --- profiles
  if (p === "/api/profiles") {
    if (M === "GET") return send(res, 200, P.profiles());
    if (M === "POST") return send(res, 201, P.create(await body(req)));
  }
  if (p === "/api/profiles/from-snapshot" && M === "POST") return send(res, 201, P.fromSnapshot(await body(req)));
  m = p.match(/^\/api\/profiles\/([a-z0-9-]+)$/);
  if (m && M === "PUT") return send(res, 200, P.update(m[1], await body(req)));
  if (m && M === "DELETE") { P.remove(m[1]); return send(res, 200, { ok: true }); }
  if (p === "/api/preview" && M === "POST") return send(res, 200, P.preview(await body(req)));
  if (p === "/api/apply" && M === "POST") {
    const b = await body(req);
    const r = P.apply(b);
    log("apply profile", b.profile, "mode", b.mode, "to", (b.machines || []).join(","));
    return send(res, 200, r);
  }
  if (p === "/api/apply-choice" && M === "POST") {
    const b = await body(req);
    const r = P.applyChoice(b);
    if (!b.dryRun) log("apply by choice, profile", b.profile, "to", (b.machines || []).map(x => x.machine).join(","));
    return send(res, 200, r);
  }

  // --- jobs and suspensions
  if (p === "/api/jobs" && M === "GET") return send(res, 200, P.jobList());
  m = p.match(/^\/api\/jobs\/([a-z0-9-]+)\/(restore|cancel)$/);
  if (m && M === "POST") {
    if (m[2] === "cancel") { P.cancel(m[1]); return send(res, 200, { ok: true }); }
    return send(res, 200, P.restore(m[1]));
  }
  if (p === "/api/suspensions" && M === "GET") return send(res, 200, SU.all());
  if (p === "/api/suspensions/unlock" && M === "POST") {
    const { credential, device } = await body(req);
    SU.unlock(credential, device);
    const n = P.resumeSuspended(credential, device);
    log("unlock", credential, "on", device, "operations resumed:", n);
    return send(res, 200, { ok: true, resumed: n });
  }

  return sendError(res, 404, "err.notFound");
}

const server = http.createServer(async (req, res) => {
  let p;
  try { p = new URL(req.url, "http://x").pathname; } catch { return sendError(res, 400, "err.notFound"); }
  try {
    if (p.startsWith("/api/")) return await api(req, res, p);
    if (req.method !== "GET") return sendError(res, 405, "err.methodNotAllowed");
    if (p === "/agent/agent.ps1" || p === "/agent/install-agent.ps1") return agentFile(res, p.slice(7));
    return staticFile(req, res, p);
  } catch (e) {
    const status = Number.isInteger(e.status) ? e.status : 500;
    if (status === 500) log("ERROR", req.method, p, e.stack || e);
    if (!res.headersSent) {
      if (status === 500) sendError(res, 500, "err.internal");
      else sendError(res, status, e.code || "err.internal", e.params);
    }
  }
});

process.on("uncaughtException", e => { log("FATAL ERROR", e.stack || e); process.exit(1); });

try {
  V.load();
  D.all();
} catch (e) {
  log("FATAL ERROR at startup: vault or device registry unreadable.", e.message);
  process.exit(1);
}
if (!V.hasKey()) log("No access key: run node src/cli.js key");

server.on("error", e => { log("FATAL ERROR", e.code === "EADDRINUSE" ? `port ${PORT} already in use` : e.message); process.exit(1); });
server.listen(PORT, HOST, () => {
  log(`NAS-Management ${VERSION} listening on ${HOST}:${PORT}`);
  if (S.DEMO) require("./demo").start();
  else if (process.env.NASM_NO_MONITOR !== "1") MON.start((...p) => log(...p));
});
