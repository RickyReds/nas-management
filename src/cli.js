// Command line, to run on the server as the service user (DPAPI ties the
// vault to the Windows user).
//   node src/cli.js key           creates the access key, if there is none
//   node src/cli.js key --show    shows the existing key again
//   node src/cli.js key --new     replaces it
const crypto = require("crypto");
require("./migrate").run(console.log);
const V = require("./vault");

// Without options it creates the key only if missing; an existing key is
// shown again with --show (same machine, same user: it is DPAPI-encrypted).
function key() {
  const replace = process.argv.includes("--new");
  if (V.hasKey() && !replace) {
    if (process.argv.includes("--show")) {
      console.log("Access key for the web page:\n\n  " + V.readKey() + "\n");
    } else {
      console.log("A key already exists. To show it:  node src/cli.js key --show");
      console.log("To replace it:                      node src/cli.js key --new");
    }
    return;
  }
  const k = crypto.randomBytes(15).toString("base64url");
  V.setKey(k);
  console.log("New access key for the web page:\n\n  " + k + "\n");
  console.log("To show it again later: node src/cli.js key --show");
  if (replace) console.log("The old key no longer works for new logins; sessions already open last up to 12 hours.");
}

const command = process.argv[2];
if (command === "key") key();
else {
  console.log("Usage: node src/cli.js key [--show | --new]");
  process.exitCode = 1;
}
