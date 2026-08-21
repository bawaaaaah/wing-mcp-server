// UDP discovery for WING consoles: broadcast "WING?" on port 2222, collect "WING,<ip>,<name>,<model>,<serial>,<firmware>" replies.
// Shared by both the metering client's port (2222) and the OSC control plane's discovery port.

import dgram from "node:dgram";

export interface WingDiscoveryResult {
  ip: string;
  name: string;
  model: string;
  serial: string;
  firmware: string;
}

export interface WingDiscoveryOptions {
  timeoutMs?: number;
  broadcastAddress?: string;
  port?: number;
}

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_BROADCAST_ADDRESS = "255.255.255.255";
const DEFAULT_PORT = 2222;
const DISCOVERY_QUERY = Buffer.from("WING?", "ascii");

/**
 * Broadcasts a WING discovery query and collects replies for `opts.timeoutMs`. Always resolves
 * (never rejects) — zero consoles responding (e.g. broadcast blocked on this LAN) is a normal
 * outcome, not an error.
 */
export async function discoverWingConsoles(opts?: WingDiscoveryOptions): Promise<WingDiscoveryResult[]> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const broadcastAddress = opts?.broadcastAddress ?? DEFAULT_BROADCAST_ADDRESS;
  const port = opts?.port ?? DEFAULT_PORT;

  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const found = new Map<string, WingDiscoveryResult>();
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        socket.close();
      } catch (err) {
        console.error("wing-discovery: error closing socket:", err);
      }
      resolve(Array.from(found.values()));
    };

    socket.on("error", (err) => {
      console.error("wing-discovery: socket error:", err);
      finish();
    });

    socket.on("message", (msg) => {
      try {
        const parts = msg.toString("ascii").split(",");
        if (parts.length !== 6 || parts[0] !== "WING") {
          return;
        }
        const [, ip, name, model, serial, firmware] = parts;
        found.set(ip, { ip, name, model, serial, firmware });
      } catch (err) {
        console.error("wing-discovery: ignoring malformed reply:", err);
      }
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(DISCOVERY_QUERY, port, broadcastAddress, (err) => {
        if (err) {
          console.error("wing-discovery: failed to send discovery query:", err);
        }
      });
    });

    setTimeout(finish, timeoutMs);
  });
}
