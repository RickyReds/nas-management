// Wake-on-LAN: magic packet (6 bytes 0xFF + the MAC 16 times) sent as UDP
// broadcast to ports 9 and 7 of the device's network.
const dgram = require("dgram");

function packet(mac) {
  const b = Buffer.from(String(mac).replace(/[:-]/g, ""), "hex");
  if (b.length !== 6) throw new Error(`invalid MAC: ${mac}`);
  const p = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i++) b.copy(p, 6 + i * 6);
  return p;
}

// Broadcast address of the /24 of the device's IPv4 address. A device on a
// different subnet, or a network wider than /24, needs a directed broadcast
// the router allows: see the README.
function broadcastFor(addresses) {
  const ip = addresses.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  return ip ? ip.replace(/\.\d+$/, ".255") : "255.255.255.255";
}

function send(mac, broadcast) {
  const p = packet(mac);
  return new Promise((ok, ko) => {
    const s = dgram.createSocket("udp4");
    s.once("error", e => { s.close(); ko(e); });
    s.bind(() => {
      s.setBroadcast(true);
      s.send(p, 9, broadcast, e => {
        if (e) { s.close(); return ko(e); }
        s.send(p, 7, broadcast, () => { s.close(); ok(); });
      });
    });
  });
}

module.exports = { packet, broadcastFor, send };
