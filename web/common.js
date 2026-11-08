// Functions shared by the pages: DOM helper, API calls, translations,
// service restart and language switch.
const $ = s => document.querySelector(s);

// ------------------------------------------------------------ translations
// The language is the one chosen in the header (remembered in this browser),
// otherwise the browser's. Dictionaries: /i18n/<lang>.json. Static text in
// the HTML carries data-i18n (text), data-i18n-placeholder, data-i18n-title,
// data-i18n-aria-label or data-i18n-content (meta) attributes.
const LANGS = ["en", "it"];
const LANG = (() => {
  let l = null;
  try { l = localStorage.getItem("nasm.lang"); } catch { }
  if (!LANGS.includes(l)) l = String(navigator.language || "").toLowerCase().startsWith("it") ? "it" : "en";
  return l;
})();
const LOCALE = LANG === "it" ? "it-IT" : "en-GB";
let DICT = {};
const i18nReady = fetch(`/i18n/${LANG}.json`).then(r => r.json()).then(d => { DICT = d; }).catch(() => { });

function t(key, params) {
  const text = DICT[key];
  if (text == null) return key;
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (params && params[k] != null ? String(params[k]) : m));
}

// A message from the server: plain text or { code, params }.
function msg(m) {
  if (m == null || m === "") return "";
  if (typeof m === "string") return m;
  if (m.code && DICT[m.code] != null) return t(m.code, m.params);
  return m.text || m.code || "";
}

function applyI18n(root = document) {
  for (const e of root.querySelectorAll("[data-i18n]")) e.textContent = t(e.dataset.i18n);
  for (const [attr, name] of [["i18nPlaceholder", "placeholder"], ["i18nTitle", "title"], ["i18nAriaLabel", "aria-label"], ["i18nContent", "content"]]) {
    for (const e of root.querySelectorAll(`[data-${name === "aria-label" ? "i18n-aria-label" : "i18n-" + name}]`)) e.setAttribute(name, t(e.dataset[attr]));
  }
  document.documentElement.lang = LANG;
}

function setLanguage(l) {
  try { localStorage.setItem("nasm.lang", l); } catch { }
  location.reload();
}

const fmtNumber = (n, digits) => Number(n).toLocaleString(LOCALE, { maximumFractionDigits: digits ?? 1 });
const fmtTime = iso => new Date(iso).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
const fmtDateTime = (iso, seconds) => new Date(iso).toLocaleString(LOCALE, { dateStyle: "short", timeStyle: seconds ? "medium" : "short" });

// ---------------------------------------------------------------- DOM, API

function el(tag, attributes, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attributes || {})) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "value") e.value = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}

function message(text, cls) {
  const m = $("#message");
  m.textContent = text || "";
  m.className = cls || "";
}

// The page decides what to do when the session is gone.
let onLoggedOut = () => { location.href = "/"; };

async function call(method, url, data) {
  await i18nReady;
  const r = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== "/api/login") { onLoggedOut(); throw new Error(t("common.sessionExpired")); }
  if (!r.ok) throw new Error(j.code ? msg(j) : (j.error || t("common.httpError", { status: r.status })));
  return j;
}

function ago(iso) {
  if (!iso) return t("time.never");
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return t("time.now");
  if (s < 3600) return t("time.minutesAgo", { n: Math.round(s / 60) });
  if (s < 86400) return t("time.hoursAgo", { n: Math.round(s / 3600) });
  return fmtDateTime(iso);
}

// Duration in words: "since 3 h" style, from seconds.
function duration(s) {
  if (s == null) return "—";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? t("time.daysHours", { d, h }) : (h ? t("time.hoursMinutes", { h, m }) : t("time.minutes", { m }));
}

function bytes(n, digits) {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${fmtNumber(n, digits ?? (n < 10 ? 2 : 1))} ${u[i]}`;
}

const isOnline = iso => Boolean(iso && Date.now() - Date.parse(iso) < 3 * 60 * 1000);
const isIp = a => /^\d+\.\d+\.\d+\.\d+$/.test(String(a || ""));

document.addEventListener("click", ev => {
  const b = ev.target.closest("[data-close]");
  if (b) b.closest("dialog").close();
});

// ----------------------------------------------------- language switch
// In every page header, next to the logout button.

function languageSwitch() {
  const header = document.querySelector("header");
  if (!header || document.getElementById("language")) return;
  const s = el("select", { id: "language", "aria-label": t("common.language"), onchange: ev => setLanguage(ev.target.value) },
    el("option", { value: "en", selected: LANG === "en" }, "English"),
    el("option", { value: "it", selected: LANG === "it" }, "Italiano"));
  const last = header.querySelector(":scope > button:last-of-type");
  header.insertBefore(s, last || null);
}

// ------------------------------------------------------------ theme switch
// System (no data-theme, follows prefers-color-scheme), light or dark. The
// choice is remembered in this browser and applied in <head> by theme.js;
// changing it here takes effect at once, without reloading.

function themeSwitch() {
  const header = document.querySelector("header");
  if (!header || document.getElementById("theme")) return;
  const now = document.documentElement.dataset.theme || "system";
  const s = el("select", { id: "theme", "aria-label": t("common.theme"), onchange: ev => setTheme(ev.target.value) },
    ...["system", "light", "dark"].map(v => el("option", { value: v, selected: v === now }, t("theme." + v))));
  header.insertBefore(s, document.getElementById("language") || header.querySelector(":scope > button:last-of-type") || null);
}

function setTheme(v) {
  if (v === "light" || v === "dark") document.documentElement.dataset.theme = v;
  else delete document.documentElement.dataset.theme;
  try { if (v === "light" || v === "dark") localStorage.setItem("nasm.theme", v); else localStorage.removeItem("nasm.theme"); } catch { }
}

// -------------------------------------------------------- service restart
// In every page, after login: "Restart service" button in the header and a
// banner when the code on disk is newer than the running service.

async function serviceStatus() {
  try {
    const r = await fetch("/api/service");
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function checkService() {
  await i18nReady;
  const s = await serviceStatus();
  const header = document.querySelector("header");
  if (!s || !header) return;
  let b = document.getElementById("restart-service");
  if (!b) {
    b = el("button", { type: "button", id: "restart-service", title: t("service.restartTitle"), onclick: restartService }, t("service.restart"));
    const next = document.getElementById("theme") || document.getElementById("language");
    header.insertBefore(b, next || header.querySelector(":scope > button:last-of-type") || null);
  }
  b.classList.toggle("primary", s.needs_restart);
  // Version in small print under the title: service, start time and current agent.
  const h1 = header.querySelector("h1");
  if (h1) {
    let v = document.getElementById("app-version");
    if (!v) { v = el("span", { id: "app-version", class: "app-version" }); h1.append(v); }
    v.textContent = t(s.agent ? "service.versionLineAgent" : "service.versionLine", { version: s.version || "?", time: fmtTime(s.started), agent: s.agent && s.agent.version });
    v.title = t("service.startedAt", { when: fmtDateTime(s.started) });
  }
  let f = document.getElementById("restart-banner");
  if (s.needs_restart && !f) {
    f = el("div", { id: "restart-banner", class: "banner", role: "status" },
      t("service.codeChanged") + " ",
      el("button", { type: "button", class: "primary", onclick: restartService }, t("service.restartNow")));
    header.after(f);
  }
  if (!s.needs_restart && f) f.remove();
}

async function restartService() {
  if (!confirm(t("service.confirmRestart"))) return;
  const before = await serviceStatus();
  try { await fetch("/api/service/restart", { method: "POST" }); } catch { }
  message(t("service.restarting"));
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const r = await fetch("/api/service");
      if (r.status === 401) { location.reload(); return; }
      if (r.ok && (await r.json()).started !== (before && before.started)) { location.reload(); return; }
    } catch { }
  }
  message(t("service.notBack"), "error");
}

// Before login /api/service answers 401 and nothing is shown.
const headerReady = new Promise(ok => document.addEventListener("DOMContentLoaded", async () => {
  await i18nReady;
  applyI18n();
  languageSwitch();
  themeSwitch();
  await checkService().catch(() => {});
  ok();
}));

// The page stays blank (main[aria-busy], see style.css) until the header and
// the first data are in place, then appears in one go: content arriving piece
// by piece pushes down what the user is already reading. `then` runs right
// after, in the same frame, for adjustments that need the content visible.
// A call that hangs does not keep the page blank: after 3 seconds it appears anyway.
async function reveal(first, then) {
  await Promise.race([Promise.allSettled([first, headerReady]), new Promise(ok => setTimeout(ok, 3000))]);
  const m = document.querySelector("main");
  if (m) m.removeAttribute("aria-busy");
  if (then) then();
}
setInterval(() => { if (!document.hidden && document.getElementById("restart-service")) checkService(); }, 60000);

async function logout() {
  await call("POST", "/api/logout").catch(() => {});
  location.href = "/";
}
