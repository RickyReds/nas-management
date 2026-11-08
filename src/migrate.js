// One-time conversion of the data written by the Italian versions (up to
// 0.5.x): files and keys in Italian become English.
//
// - Default layout: dati/ is read and data/ is written. dati/ is left
//   untouched, so going back to an old version still finds its data.
// - With NASM_DATA set, the conversion happens in that folder: the old files
//   are first copied to backup-<timestamp>/ inside it, then removed.
// Nothing happens if the new files already exist or there is nothing old.
const fs = require("fs");
const path = require("path");
const S = require("./store");

const OLD_NAMES = {
  "cassaforte.json": "vault.json",
  "dispositivi.json": "devices.json",
  "macchine.json": "machines.json",
  "profili.json": "profiles.json",
  "lavori.json": "jobs.json",
  "sospensioni.json": "suspensions.json",
  "struttura.json": "structure.json",
  "diagnosi.json": "diagnostics.json",
  "sessioni.json": "sessions.json",
};

// Renames keys; keys not in the map stay as they are.
function rename(o, map) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) out[map[k] || k] = v;
  return out;
}
const value = (v, map) => (v in map ? map[v] : v);

const drives = l => (Array.isArray(l) ? l.map(u => {
  const x = rename(u, { lettera: "letter", percorso: "path", stato: "status" });
  x.status = value(x.status, { connessa: "connected", disconnessa: "disconnected" });
  return x;
}) : l);

const CONVERT = {
  "vault.json": v => {
    const x = rename(v, { versione: "version", accesso: "access", credenziali: "credentials" });
    x.credentials = (x.credentials || []).map(c => rename(c, { utente: "user", ruolo: "role", dispositivi: "devices", fonte: "source" }));
    return x;
  },
  "devices.json": l => l.map(d => {
    const x = rename(d, { nome: "name", tipo: "type", indirizzi: "addresses", modello: "model", note: "notes", credenziale_metriche: "metrics_credential", rilevato: "detected" });
    x.type = value(x.type, { generico: "generic" });
    x.wol = value(x.wol, { si: "yes", non_provato: "untested" });
    if (x.detected) x.detected = rename(x.detected, { quando: "when", porte_aperte: "open_ports", in_avvio: "booting" });
    return x;
  }),
  "machines.json": l => l.map(m => {
    const x = rename(m, {
      utente: "user", gestita: "managed", lettere_protette: "protected_letters", indirizzi_preferiti: "preferred_addresses",
      registrata: "registered", fotografia: "snapshot", credenziali_windows: "windows_credentials", chiave_pubblica: "public_key",
      versione_agente: "agent_version", ultimo_contatto: "last_contact", nome: "name", risoluzioni: "resolutions",
    });
    delete x._firma; // the next check-in saves the snapshot again
    if (x.snapshot) {
      x.snapshot = rename(x.snapshot, { quando: "when", unita: "drives" });
      x.snapshot.drives = drives(x.snapshot.drives);
    }
    x.windows_credentials = (x.windows_credentials || []).map(c => rename(c, { utente: "user" }));
    return x;
  }),
  "profiles.json": l => l.map(p => {
    const x = rename(p, { nome: "name", voci: "entries", aggiornato: "updated" });
    x.entries = (x.entries || []).map(v => rename(v, { lettera: "letter", dispositivo: "device", condivisione: "share", sottocartella: "subfolder", credenziale: "credential", scrittura: "write" }));
    return x;
  }),
  "jobs.json": l => l.map(j => {
    const x = rename(j, {
      tipo: "type", macchina: "machine", profilo: "profile", profilo_nome: "profile_name", modo: "mode", creato: "created",
      stato: "status", ripristino: "restore", operazioni: "operations", consegnato: "delivered", chiuso: "closed",
    });
    x.type = value(x.type, { profilo: "profile", ripristino: "restore", mappa: "map" });
    if (x.type === "restore") {
      const m = String(x.profile_name || "").match(/(\S+)$/);
      x.restored_from = m ? m[1] : null;
      x.profile_name = null;
    }
    if (x.type === "map") x.profile_name = null;
    x.mode = value(x.mode, { aggiungi: "add", allinea: "align", scelta: "choice" });
    x.status = value(x.status, { in_coda: "queued", in_corso: "running", completato: "completed", completato_con_errori: "completed_with_errors", annullato: "cancelled" });
    x.restore = drives(x.restore);
    x.operations = (x.operations || []).map(o => {
      const y = rename(o, {
        lettera: "letter", stato: "status", messaggio: "message", azione: "action", percorso: "path", vecchio: "old",
        dispositivo: "device", credenziale: "credential", scrittura: "write", quando: "when", utente: "user", utente_prima: "user_before",
      });
      y.status = value(y.status, { in_coda: "queued", in_attesa: "waiting", errore: "error", sospesa: "suspended", annullata: "cancelled" });
      y.action = value(y.action, { monta: "mount", sostituisci: "replace", togli: "remove" });
      return y;
    });
    return x;
  }),
  "suspensions.json": l => l.map(s => {
    const x = rename(s, { credenziale: "credential", dispositivo: "device", macchina: "machine", messaggio: "message", quando: "when" });
    if (/^server/.test(String(x.machine))) x.machine = "server";
    return x;
  }),
  "structure.json": o => Object.fromEntries(Object.entries(o).map(([id, s]) => {
    const x = rename(s, { quando: "when", volumi: "volumes" });
    x.volumes = (x.volumes || []).map(v => {
      const y = rename(v, { nome: "name", tipo: "type", totale_byte: "total_bytes", libero_byte: "free_bytes", condivisioni: "shares" });
      y.shares = (y.shares || []).map(c => rename(c, { nome: "name", usato_byte: "used_bytes" }));
      return y;
    });
    return [id, x];
  })),
  "diagnostics.json": o => Object.fromEntries(Object.entries(o).map(([id, l]) => [id, (l || []).map(r => rename(r, { chiesta: "requested", arrivata: "arrived", testo: "text" }))])),
  "sessions.json": o => o,
};

function writeAtomic(f, text) {
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, f);
}

function run(log = () => {}) {
  // The demo has its own sample data: an old dati/ next to the code is not its business.
  if (S.DEMO) return;
  const target = S.DATA;
  const inPlace = Boolean(process.env.NASM_DATA);
  const source = inPlace ? target : path.join(S.ROOT, "dati");
  if (!fs.existsSync(source)) return false;
  const old = Object.keys(OLD_NAMES).filter(f => fs.existsSync(path.join(source, f)));
  if (!old.length) return false;
  if (Object.values(OLD_NAMES).some(f => fs.existsSync(path.join(target, f)))) return false;

  fs.mkdirSync(target, { recursive: true });
  let backup = null;
  if (inPlace) {
    backup = path.join(target, `backup-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`);
    fs.mkdirSync(backup);
    for (const f of [...old, "servizio.log"].filter(f => fs.existsSync(path.join(source, f)))) {
      fs.copyFileSync(path.join(source, f), path.join(backup, f));
      if (fs.statSync(path.join(backup, f)).size !== fs.statSync(path.join(source, f)).size) throw new Error(`migration: backup copy of ${f} differs, stopping`);
    }
  }
  // Convert everything in memory first: a malformed file stops the migration
  // before anything is written.
  const converted = old.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(source, f), "utf8").replace(/^﻿/, ""));
    return [OLD_NAMES[f], CONVERT[OLD_NAMES[f]](data)];
  });
  for (const [name, data] of converted) writeAtomic(path.join(target, name), JSON.stringify(data, null, 2) + "\n");
  if (!inPlace) {
    for (const f of ["config.json"]) {
      if (fs.existsSync(path.join(source, f)) && !fs.existsSync(path.join(target, f))) fs.copyFileSync(path.join(source, f), path.join(target, f));
    }
    if (fs.existsSync(path.join(source, "servizio.log")) && !fs.existsSync(path.join(target, "service.log"))) {
      fs.copyFileSync(path.join(source, "servizio.log"), path.join(target, "service.log"));
    }
  } else {
    if (fs.existsSync(path.join(source, "servizio.log"))) fs.renameSync(path.join(source, "servizio.log"), path.join(target, "service.log"));
    for (const f of old) fs.unlinkSync(path.join(source, f));
  }
  log(`migration: converted ${old.join(", ")} from ${source} to ${target}${backup ? `, backup in ${backup}` : ""}`);
  return true;
}

module.exports = { run };
