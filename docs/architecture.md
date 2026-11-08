# Architecture

This page explains how NAS-Management is built and why. To install and use it, read the [README](../README.md) first.

## The pieces

```
 browser ──HTTP──►  service (Node, on the Windows server)  ──HTTP 8080──►  QNAP NAS (QTS, read-only)
                     │   data/  (JSON files, DPAPI vault)    ──TCP probe──►  any device
                     │                                       ──UDP──────►  Wake-on-LAN broadcast
                     ▲
                     │ HTTP, every minute
            agent (PowerShell, one per PC and Windows user)  ──net use──►  NAS shares
```

- **The service** (`src/`) is one Node process with no npm dependencies. It serves the pages and the API, probes the devices, reads the QNAP metrics and keeps all the data in `data/`.
- **The pages** (`web/`) are static HTML, CSS and plain JavaScript, with no build step. They call the JSON API and translate every text with `web/i18n/en.json` and `it.json`.
- **The agent** (`agent/agent.ps1`) is a Windows PowerShell 5.1 script running in each user's session. It reports the user's network drives and runs the jobs the service gives it.

### Why the service is native, not in Docker

Three things only work on Windows itself:

- **DPAPI**, which encrypts the vault for the service user;
- **the Windows SMB client**, used to list a NAS's shares and folders with the server's own credentials;
- **the Wake-on-LAN broadcast** on the physical network.

### Why an agent, and why in the user's session

Network drives in Windows belong to a **logon session**, not to the computer. A drive mounted by a remote command, or by an elevated process, does not show up in the user's File Explorer. The only reliable way is to mount it from inside the session itself. That is why there is one agent per PC **and per Windows user**, started at logon from `HKCU\...\Run`, never elevated.

Drives are mounted with `/persistent:yes`, so Windows reconnects them at the next logon on its own. If the agent stops, the drives stay where they are: you just cannot change them from the page.

## Source files

| File | Role |
|---|---|
| `src/server.js` | HTTP server: static files, login and sessions, the page API, the agent API, the double-click installer |
| `src/store.js` | reads and writes the JSON files in `data/`, always through a temporary file and a rename |
| `src/config.js` | `data/config.json` with defaults, read once at startup |
| `src/vault.js` | credentials and access key, DPAPI-encrypted through a PowerShell child process (data travels on stdin, never on the command line) |
| `src/devices.js` | the device registry; adding a device probes ports and reads the QTS login page **without logging in** |
| `src/monitor.js` | status every minute (TCP probe), QTS metrics every 15 minutes, Wake-on-LAN follow-up |
| `src/qts.js` | read-only QTS client: one session per NAS, reused; a rejected login suspends the credential |
| `src/wol.js` | magic packet, broadcast derived from the device's /24 |
| `src/agents.js` | registered machines: registration codes, tokens, snapshots, RSA public keys |
| `src/profiles.js` | profiles, previews, jobs for the agents, results and restore; changes made from the map |
| `src/map.js` | builds the map: NAS → volumes → shares, with a column of letters per machine and per profile |
| `src/suspensions.js` | credentials suspended after a rejected login |
| `src/diagnostics.js` | network diagnostics requested from the page and run by the agents |
| `src/i18n.js` | server-side translations, from the same dictionaries as the pages |
| `src/migrate.js` | one-time conversion of the data of the Italian versions (up to 0.5.x) |
| `src/demo.js` | demo mode with sample data (`NASM_DEMO=1`) |
| `src/transfer.js` | export and import of the configuration: preview, merge or replace, backup copy of `data/` before writing |
| `src/cli.js` | `node src/cli.js key`: creates, shows or replaces the access key |

## Data

Everything lives in `data/` as JSON. There is no database: the amounts are small (a few NAS units, a few PCs, a few hundred jobs). Each file is replaced in one step (temporary file plus rename), so a crash never leaves half a file behind.

| File | Content |
|---|---|
| `config.json` | installation settings |
| `vault.json` | credentials and access key, DPAPI-encrypted |
| `devices.json` | device registry: addresses, MAC, model, Wake-on-LAN state, notes |
| `structure.json` | volumes and shares from the last QTS read, so the map still shows a NAS that is off |
| `machines.json` | registered machines: last drive snapshot, Credential Manager targets, name resolutions, agent version |
| `profiles.json` | drive letter profiles |
| `jobs.json` | jobs for the agents, with the snapshot to restore (last 300) |
| `suspensions.json` | suspended credentials |
| `diagnostics.json` | last 10 diagnostics per machine |
| `sessions.json` | sha256 fingerprints of the open sessions |
| `service.log` | log |
| `backup-<time>-import/` | copy of the JSON files above, made before each configuration import |

Live status and metrics are kept **in memory** only. History belongs in a tool made for it, such as Home Assistant.

## Flows

### Status and metrics

1. Every minute the monitor opens a TCP connection to each device: ports 8080 and 445 for a QNAP, the ports found when the device was added for anything else. No ping, no login. A device that is off is a state, not an error.
2. A QNAP whose network is up but whose QTS is still starting answers `is_booting` on its login page: the status becomes *booting*.
3. Every 15 minutes (or on **Refresh now**) the service logs in to each QNAP that is on with the metrics account and reads four QTS endpoints: system info, health, disks, volumes. The session is reused; if it expires, the service logs in again **once**.
4. A rejected login suspends that credential on that NAS. A QNAP blocks an address after a few failed logins, so nothing retries until someone unlocks it on the page.

### Registering an agent

1. The page asks for a one-time code (valid 30 minutes) and offers a `.cmd` installer with server address and code inside.
2. The installer downloads `install-agent.ps1`, which creates `%LOCALAPPDATA%\NAS-Management`, downloads `agent.ps1`, generates an RSA key pair and registers with the code.
3. The service answers with a random token. It stores the token's sha256 and the agent's public key; the agent stores the token and the private key, both DPAPI-encrypted.

### The agent's round (every minute)

1. `POST /api/agent/checkin` with the snapshot of the drives (from the registry and `net use`, no WMI), the network targets of the Credential Manager (no passwords) and how the PC resolves the NAS names.
2. The answer can contain:
   - a **job**, a list of operations (remove, mount), with any needed password encrypted with the agent's public key;
   - **diagnostics** to run, each one just a host name or IP;
   - the **names** to resolve;
   - the **current agent's version and sha256**, for the self-update.
3. The agent runs the job and sends the results to `POST /api/agent/result`, with the new snapshot. Diagnostics go to `POST /api/agent/diagnostics`.

`net use` runs with closed input and a time limit. If Windows asks for a user and a password, the operation fails instead of hanging, and the credential is suspended.

### Jobs and the order of operations

A change, from a profile or from the map, becomes **one job per machine**. Every job saves the drive snapshot taken before it runs, so it can be restored from the page.

Inside a job, all removals come before all mounts, so letter swaps always work (`P:` → `Q:` and `Q:` → `P:` in the same job).

Windows allows **one user per server address** in a session (error 1219). Host name and IP count as two different servers. Before planning a mount, the service checks which address form the machine already uses for that NAS and which user the Credential Manager holds for it.

### Self-update of the agent

At every check-in the service announces the sha256 of `agent/agent.ps1`. When it differs from the agent's own file, and no job is running, the agent:

1. downloads the new file;
2. checks the fingerprint and the PowerShell syntax;
3. keeps the previous copy and restarts.

A failed attempt leaves the old agent running and is retried after an hour. The fingerprint comes from the same server as the file: it guards against a broken download, not against an attacker (see [SECURITY.md](../SECURITY.md)).

**A change to `agent/agent.ps1` reaches every PC within a minute.** If it breaks the round, the agents cannot download the fix and must be reinstalled by hand. Always test a change with a copy of the agent in a separate folder:

```powershell
install-agent.ps1 -Server http://127.0.0.1:18790 -Code <code> -Folder C:\Temp\agent-test -NoStart
agent.ps1 -Folder C:\Temp\agent-test -Once
install-agent.ps1 -Uninstall -Folder C:\Temp\agent-test
```

The agent's mutex and stop signal depend on its folder, so a test copy never disturbs the real one.

### Name resolution

Some routers answer `127.0.0.1` for any name they do not know. Then `\\nas01` points to the PC itself and Windows asks for a password that can never work. Each agent resolves the NAS names every 10 minutes and reports them. The map marks a name that resolves badly on that PC, and the network diagnostic shows the hosts file, the DNS cache and port 445.

## Languages

- The code, the API and the data are in English.
- The interface is in English and Italian. Every text is a key in `web/i18n/en.json` and `it.json`; `node scripts/check-i18n.js` checks that both dictionaries have the same keys.
- The server sends errors as `{ error, code, params }`, and the page shows `code` in the reader's language.
- The agent and the installer carry their own texts in both languages. Results that reach the page are codes too.

## Test server

Any number of servers can run side by side, each on its own data folder:

```powershell
$env:NASM_PORT = 18790; $env:NASM_HOST = '127.0.0.1'; $env:NASM_DATA = 'C:\Temp\nasm-test'; $env:NASM_NO_MONITOR = '1'
node src/server.js
```

| Variable | Effect |
|---|---|
| `NASM_PORT`, `NASM_HOST` | override `port` and `host` from `config.json` |
| `NASM_DATA` | data folder instead of `data/` |
| `NASM_NO_MONITOR=1` | no probes and no metrics |
| `NASM_METRICS_MINUTES` | metrics interval (default 15) |
| `NASM_DEMO=1` | demo mode, see the README |
