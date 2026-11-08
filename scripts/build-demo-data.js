// Writes the invented sample data of the demo (NASM_DEMO=1, see src/demo.js)
// into examples/demo/. Every name, address and number here is made up.
// Usage: node scripts/build-demo-data.js
// The RSA keys of the sample machines are new at every run.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const OUT = path.join(__dirname, "..", "examples", "demo");
fs.mkdirSync(OUT, { recursive: true });
const write = (name, data) => {
  const f = path.join(OUT, name);
  fs.writeFileSync(f + ".tmp", JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(f + ".tmp", f);
};

const ANCHOR = Date.parse("2026-06-15T10:00:00.000Z");
const at = minutesAgo => new Date(ANCHOR - minutesAgo * 60000).toISOString();
const TB = 1e12, GB = 1e9;
const B = "\\";
const unc = (server, share, sub) => `${B}${B}${server}${B}${share}${sub ? B + sub : ""}`;

// ---------------------------------------------------------------- config
write("config.json", {
  port: 8799,
  host: "127.0.0.1",
  publicAddress: "http://127.0.0.1:8799",
  taskName: "NAS-Management",
  metricsUser: "monitor",
  protectedDriveLetters: {},
});

// ---------------------------------------------------------------- devices
const devices = [
  {
    id: "nas01", name: "nas01", type: "qnap", addresses: ["192.168.10.21", "nas01"], mac: ["02:00:5E:10:00:21"],
    model: "TS-464", firmware: "QTS 5.2.1 build 2930", wol: "yes",
    notes: "Main storage. RAID 5 on 4 × 8 TB, plus one SSD volume for media.",
  },
  {
    id: "nas02", name: "nas02", type: "qnap", addresses: ["192.168.10.22", "nas02"], mac: ["02:00:5E:10:00:22"],
    model: "TS-233", firmware: "QTS 5.1.8 build 2823", wol: "no",
    notes: "Nightly backup target. No Wake-on-LAN: power button only.",
  },
  {
    id: "nas03", name: "nas03", type: "qnap", addresses: ["192.168.10.23", "nas03"], mac: ["02:00:5E:10:00:23"],
    model: "TS-873A", firmware: "QTS 5.2.1 build 2930", wol: "untested",
    notes: "Archive. Switched on once a week.",
  },
  {
    id: "printer", name: "printer", type: "generic", addresses: ["192.168.10.30"], mac: [],
    model: "", firmware: "", wol: "untested", notes: "Office printer.",
    detected: { when: at(60 * 24 * 30), open_ports: [80, 443], booting: false },
  },
];
write("devices.json", devices);

// ---------------------------------------------------------------- credentials (no passwords: demo.js adds a dummy one)
write("credentials.json", [
  { id: "anna", user: "anna", role: "office", devices: ["nas01", "nas02"], source: "" },
  { id: "marco", user: "marco", role: "office", devices: ["nas01"], source: "" },
  { id: "media", user: "media", role: "read-only, living room", devices: ["nas01", "nas03"], source: "" },
  { id: "monitor", user: "monitor", role: "metrics, read-only", devices: ["nas01", "nas02", "nas03"], source: "" },
]);

// ---------------------------------------------------------------- structure (last QTS read)
const share = (name, used) => ({ name, used_bytes: used });
const structure = {
  nas01: {
    when: at(4),
    volumes: [
      { name: "DataVol1", type: "Ready", total_bytes: 21.4 * TB, free_bytes: 7.9 * TB, shares: [
        share("Documents", 410 * GB), share("Photos", 2.6 * TB), share("Music", 380 * GB),
        share("Projects", 1.9 * TB), share("Public", 95 * GB), share("PC-Backup", 6.1 * TB)] },
      { name: "MediaSSD", type: "Ready", total_bytes: 3.6 * TB, free_bytes: 1.1 * TB, shares: [
        share("Films", 1.7 * TB), share("Series", 640 * GB), share("Kids", 180 * GB)] },
    ],
  },
  nas02: {
    when: at(4),
    volumes: [
      { name: "Backup", type: "Ready", total_bytes: 7.2 * TB, free_bytes: 0.85 * TB, shares: [
        share("Nightly", 5.4 * TB), share("Archive", 0.9 * TB)] },
    ],
  },
  nas03: {
    when: at(60 * 24 * 3),
    volumes: [
      { name: "ArchiveVol", type: "Ready", total_bytes: 43.6 * TB, free_bytes: 29.0 * TB, shares: [
        share("Video-Archive", 11.2 * TB), share("Scans", 1.4 * TB), share("Old-PCs", 2.0 * TB)] },
    ],
  },
};
write("structure.json", structure);

// ---------------------------------------------------------------- machines
const publicKey = () => {
  const { publicKey: k } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const j = k.export({ format: "jwk" });
  const b64 = s => Buffer.from(s, "base64url").toString("base64");
  return { n: b64(j.n), e: b64(j.e) };
};
const drive = (letter, path, status = "connected") => ({ letter, path, status });
const machines = [
  {
    id: "office-pc-anna", computer: "OFFICE-PC", user: "OFFICE-PC\\anna", name: "Office", managed: true,
    protected_letters: [], preferred_addresses: {}, registered: at(60 * 24 * 40),
    snapshot: { when: at(2), drives: [
      drive("M", unc("nas01", "Music")),
      drive("P", unc("nas01", "Projects")),
      drive("S", unc("nas01", "Documents", "Anna")),
      drive("X", unc("192.168.10.22", "Nightly")),
    ] },
    windows_credentials: [{ target: "nas01", user: "anna" }, { target: "192.168.10.22", user: "anna" }],
    public_key: publicKey(), agent_version: "0.6.0", last_contact: at(1), ip: "192.168.10.51",
    resolutions: { nas01: ["192.168.10.21"], nas02: ["192.168.10.22"], nas03: ["192.168.10.23"] },
  },
  {
    id: "laptop-marco-marco", computer: "LAPTOP-MARCO", user: "LAPTOP-MARCO\\marco", name: "Laptop", managed: true,
    protected_letters: ["Z"], preferred_addresses: {}, registered: at(60 * 24 * 38),
    snapshot: { when: at(3), drives: [
      drive("M", unc("nas01", "Music")),
      drive("P", unc("nas01", "Projects")),
      drive("V", unc("nas01", "Films")),
      drive("Z", unc("nas01", "Public")),
    ] },
    windows_credentials: [{ target: "nas01", user: "marco" }],
    public_key: publicKey(), agent_version: "0.6.0", last_contact: at(1), ip: "192.168.10.52",
    resolutions: { nas01: ["192.168.10.21"], nas02: ["127.0.0.1"], nas03: ["192.168.10.23"] },
  },
  {
    id: "livingroom-family", computer: "LIVINGROOM", user: "LIVINGROOM\\family", name: "Living room", managed: true,
    protected_letters: [], preferred_addresses: { nas01: "192.168.10.21" }, registered: at(60 * 24 * 35),
    snapshot: { when: at(60 * 26), drives: [
      drive("K", unc("192.168.10.21", "Kids")),
      drive("V", unc("192.168.10.21", "Films")),
      drive("W", unc("192.168.10.21", "Series")),
      drive("Y", unc("192.168.10.23", "Video-Archive"), "disconnected"),
    ] },
    windows_credentials: [{ target: "192.168.10.21", user: "media" }, { target: "192.168.10.23", user: "media" }],
    public_key: publicKey(), agent_version: "0.5.2", last_contact: at(60 * 26), ip: "192.168.10.60",
    resolutions: { nas01: ["192.168.10.21"], nas02: ["192.168.10.22"], nas03: ["192.168.10.23"] },
  },
];
write("machines.json", machines);

// ---------------------------------------------------------------- profiles
const entry = (letter, device, share, credential, subfolder = "", write = false) => ({ letter, device, share, subfolder, credential, write });
write("profiles.json", [
  { id: "office", name: "Office", entries: [
    entry("M", "nas01", "Music", null),
    entry("P", "nas01", "Projects", null, "", true),
    entry("S", "nas01", "Documents", null, "", true),
    entry("T", "nas01", "Public", null, "", true),
  ] },
  { id: "media", name: "Media", entries: [
    entry("K", "nas01", "Kids", "media"),
    entry("V", "nas01", "Films", "media"),
    entry("W", "nas01", "Series", "media"),
    entry("Y", "nas03", "Video-Archive", "media"),
  ] },
]);

// ---------------------------------------------------------------- jobs
write("jobs.json", [
  {
    id: "20260614183012-a1b2c3", type: "profile", machine: "livingroom-family", profile: "media", profile_name: "Media",
    mode: "add", created: at(60 * 15.5), status: "completed",
    restore: [drive("K", unc("192.168.10.21", "Kids")), drive("V", unc("192.168.10.21", "Films"))],
    operations: [
      { letter: "W", status: "ok", message: "mounted", action: "mount", path: unc("192.168.10.21", "Series"), old: null, device: "nas01", credential: "media", write: false, n: 1, when: at(60 * 15.4) },
      { letter: "Y", status: "ok", message: "mounted", action: "mount", path: unc("192.168.10.23", "Video-Archive"), old: null, device: "nas03", credential: "media", write: false, n: 2, when: at(60 * 15.4) },
    ],
    delivered: at(60 * 15.45), closed: at(60 * 15.4),
  },
  {
    id: "20260615092840-d4e5f6", type: "map", machine: "laptop-marco-marco",
    created: at(32), status: "completed",
    restore: [drive("M", unc("nas01", "Music")), drive("P", unc("nas01", "Projects")), drive("Z", unc("nas01", "Public"))],
    operations: [
      { letter: "V", status: "ok", message: "mounted", action: "mount", path: unc("nas01", "Films"), old: null, device: "nas01", credential: null, write: false, n: 1, when: at(31) },
    ],
    delivered: at(31.5), closed: at(31),
  },
]);

// ---------------------------------------------------------------- diagnostics
write("diagnostics.json", {
  "laptop-marco-marco": [
    {
      id: "5f3a9c01", server: "nas02", requested: at(50), arrived: at(49),
      text: [
        "Diagnostic of nas02 from LAPTOP-MARCO (LAPTOP-MARCO\\marco), agent 0.6.0",
        "",
        "== Name resolution",
        "  127.0.0.1   <-- loopback: the DNS server answers 127.0.0.1 for unknown names",
        "",
        "== Hosts file",
        "  (no lines)",
        "",
        "== Port 445",
        "  nas02: no answer",
        "  192.168.10.22: answers",
      ].join("\n"),
    },
  ],
});

// ---------------------------------------------------------------- status (what the monitor would know)
const disk = (number, model, capacity, temperature, health = "Good") => ({
  slot: `0:${number}`, name: null, number: String(number), model, health, temperature, temperature_threshold: 60, capacity, serial: "",
});
write("status.json", {
  anchor: new Date(ANCHOR).toISOString(),
  offline_machines: ["livingroom-family"],
  devices: {
    nas01: {
      status: "on", since: at(60 * 24 * 12), open_ports: [8080, 445],
      metrics: {
        when: at(4), account: "monitor", model: "TS-464", firmware: "QTS 5.2.1.2930 build 20250103", serial: "",
        cpu: 7, memory: { total_mb: 16384, free_mb: 10650 },
        temperatures: { system: 38, cpu: 46, system_threshold: 70 },
        uptime_s: 12 * 86400 + 5 * 3600 + 17 * 60,
        fans: [{ rpm: 1120, failed: false }],
        network: [
          { name: "Adapter 1", connected: true, speed: 2500, ip: "192.168.10.21", mac: "02:00:5E:10:00:21" },
          { name: "Adapter 2", connected: false, speed: null, ip: "", mac: "02:00:5E:10:01:21" },
        ],
        health: { status: "ok", events: [] },
        disks: [
          disk(1, "WD Red Plus", "8.00 TB", 36), disk(2, "WD Red Plus", "8.00 TB", 37),
          disk(3, "WD Red Plus", "8.00 TB", 37), disk(4, "WD Red Plus", "8.00 TB", 36),
        ],
        volumes: structure.nas01.volumes.map(v => ({ ...v, free_gb: Math.round(v.free_bytes / GB) })),
      },
    },
    nas02: {
      status: "on", since: at(60 * 24 * 4), open_ports: [8080, 445],
      metrics: {
        when: at(4), account: "monitor", model: "TS-233", firmware: "QTS 5.1.8.2823 build 20240712", serial: "",
        cpu: 18, memory: { total_mb: 2048, free_mb: 610 },
        temperatures: { system: 44, cpu: 52, system_threshold: 70 },
        uptime_s: 4 * 86400 + 2 * 3600,
        fans: [{ rpm: 860, failed: false }],
        network: [{ name: "Adapter 1", connected: true, speed: 1000, ip: "192.168.10.22", mac: "02:00:5E:10:00:22" }],
        health: { status: "warning", events: [{ type: "warning", code: "VOL_USAGE", on: { kind: "volume", name: "Backup", status: "ready" } }] },
        disks: [disk(1, "Seagate IronWolf", "8.00 TB", 41), disk(2, "Seagate IronWolf", "8.00 TB", 43)],
        volumes: structure.nas02.volumes.map(v => ({ ...v, free_gb: Math.round(v.free_bytes / GB) })),
      },
    },
    nas03: { status: "off", since: at(60 * 24 * 3), open_ports: [] },
    printer: { status: "on", since: at(60 * 5), open_ports: [80, 443] },
  },
});

console.log("written to", OUT);
