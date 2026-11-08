# Security

NAS-Management is meant for a **small, trusted local network**: a home or a small office, with one Windows server and a few Windows PCs. It is not designed to be exposed to the internet. Read this page before installing it, so you know what it protects and what it does not.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting**: open the repository's **Security** tab and choose **Report a vulnerability**. The report stays private between you and the maintainer until a fix is out.

Please do not open a public issue for a security problem.

This is a spare-time project. Reports are read, but there is no guaranteed response time. Only the latest release gets fixes.

## What it protects

### The web page

- The page asks for an **access key**, created on the server with `node src/cli.js key`. Only someone logged on to the server as the service user can read it again.
- After a login the browser gets a random session cookie (`HttpOnly`, `SameSite=Strict`) that lasts 12 hours. Only the sha256 fingerprint of each session is saved on disk, never the cookie itself.
- After 5 wrong keys from the same address in 10 minutes, that address cannot log in for a while; after 50 wrong keys in all, nobody can.
- Requests that change something are refused when the browser says they come from another origin, such as another web app on the same server. This, and the `SameSite=Strict` cookie, protect against cross-site request forgery.
- The page never receives a password. It only learns whether a credential has one.

### Passwords on the server

- NAS passwords and the access key are encrypted with **Windows DPAPI**, user scope, in `data/vault.json`.
- The file can only be decrypted by the same Windows user on the same machine. A copy of it is useless anywhere else, and that includes your own backup: see [Backups](#backups).

### Passwords on their way to a PC

- At installation each agent creates an **RSA key pair**. The private key stays on the PC, DPAPI-encrypted; the server keeps the public key.
- When a job needs a password, the server encrypts it with that PC's public key (RSA-OAEP). Only that agent can read it, and only to write it into the user's Windows Credential Manager.

### The agents

- An agent registers with a **one-time code** generated on the page, valid for 30 minutes.
- Registration gives the agent a random token. The server keeps only its sha256 fingerprint; the agent keeps it DPAPI-encrypted.
- The agent runs **without administrator rights**, in the user's own session.
- The server can only ask an agent for a fixed list of things: mount and remove drives, report its drives, resolve the NAS names and run a network diagnostic. **It cannot send commands to run.** The diagnostic is written inside the agent and is read-only: the server sends just a host name or IP, checked on both sides.
- Drive letters and network paths are checked by the server when you save them, and again by the agent before they reach `net use`: a letter A–Z, and `\\server\share` paths without quotes or characters Windows does not allow in names.
- The agent reports only the network entries of the Credential Manager (target and user name), never passwords and never the other entries.

### The NAS units

- Metrics are read with a QTS account you choose, preferably a **read-only** one. The app never falls back to an administrator account.
- A QNAP blocks an address after a few failed logins. So when a NAS rejects a credential, the credential is **suspended** on that NAS for everyone, and nobody retries it until you unlock it on the page.

## What it does not protect

- **Plain HTTP.** Traffic between browsers, agents and the server is not encrypted. Anyone who can watch your local network can read the session cookie, the agent tokens and the drive snapshots. Passwords sent to agents are encrypted with RSA, but everything else travels in clear text. Use it only on a network you trust.
- **The metrics password on its way to the NAS.** QTS takes the login over HTTP on port 8080, with the password only base64-encoded in the address. That is how the QTS login works. Another reason to use a read-only account for the metrics.
- **Agent self-update.** Every minute each agent compares the sha256 fingerprint of its own file with the one announced by the server. If they differ, it downloads the new file, checks the fingerprint and the PowerShell syntax, and replaces itself. Fingerprint and file come from **the same server, over HTTP**: they protect against a broken download, not against an attacker. Whoever controls the server, or can tamper with its traffic, can run code on every PC, as the logged-on user.
- **Agent files without login.** `/agent/agent.ps1` and `/agent/install-agent.ps1` can be downloaded without logging in. They contain no secrets.
- **The service user.** Anyone who can log on to the server as the service user can read every password. Protect that account like an administrator account.
- **The exported configuration.** The file from **Settings → Export** contains no passwords, tokens or keys, but it does describe your network: addresses, MAC addresses, NAS user names, drive letter profiles. Keep it like any other private document.
- **Unsigned installers.** The double-click installer and the scripts are not code-signed. Windows SmartScreen and browsers will warn about them.
- **The demo.** Demo mode (`NASM_DEMO=1`) has a fixed, public access key, `demo`. For this reason it always listens on `127.0.0.1` only, whatever `NASM_HOST` says, and it works on invented data in its own folder.

## Recommendations

- Keep the firewall rule created by `scripts/install-service.ps1`: it accepts connections from the local subnet only.
- Do not forward the service port on your router and do not publish it through a tunnel.
- Give the metrics account read-only rights on the NAS.
- Change the access key with `node src/cli.js key --new` if you think someone has seen it.

## Backups

`data/vault.json` only works on the server and for the Windows user that created it. Keep your NAS passwords somewhere else too, for example in a password manager. If the server is reinstalled, enter them again on the **Devices → Credentials** page.
