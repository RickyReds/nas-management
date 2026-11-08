// Server-side translations. The dictionaries are the same ones the pages use
// (web/i18n/<lang>.json). The server only needs them for English error text,
// for log lines and for the installer it generates in the user's language.
const fs = require("fs");
const path = require("path");
const S = require("./store");

const LANGS = ["en", "it"];
const cache = new Map();

function dictionary(lang) {
  if (!LANGS.includes(lang)) lang = "en";
  const f = path.join(S.ROOT, "web", "i18n", `${lang}.json`);
  const mtime = (() => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } })();
  const c = cache.get(lang);
  if (c && c.mtime === mtime) return c.dict;
  let dict = {};
  try { dict = JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")); } catch { }
  cache.set(lang, { mtime, dict });
  return dict;
}

function format(text, params) {
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (params && params[k] != null ? String(params[k]) : m));
}

function t(lang, code, params) {
  const d = dictionary(lang);
  const text = d[code] ?? dictionary("en")[code];
  return text == null ? code : format(text, params);
}

// A message is a plain string or { code, params }.
function msg(lang, m) {
  if (m == null) return "";
  if (typeof m === "string") return m;
  return t(lang, m.code, m.params);
}

const pickLang = v => (String(v || "").toLowerCase().startsWith("it") ? "it" : "en");

module.exports = { LANGS, t, msg, pickLang, dictionary };
