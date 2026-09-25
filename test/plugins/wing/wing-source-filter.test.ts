// The OSC and meter sockets accept datagrams only from the console: anyone else on the LAN could
// otherwise ack a write that never happened, or feed the state cache invented values.

import { expect } from "chai";
import dgram from "node:dgram";
import osc from "osc";
import { WingOscClient, type WingParamChange } from "../../../src/plugins/wing/wing-osc-client.js";
import { isFromConsole, normalizeAddress, resolveConsoleSources } from "../../../src/plugins/wing/wing-source-filter.js";

function pushFrom(sourceAddress: string, targetPort: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.bind(0, sourceAddress, () => {
      const packet = osc.writePacket(
        { address, args: [{ type: "s", value: "-3.0" }, { type: "f", value: 0.6 }, { type: "f", value: -3 }] },
        { metadata: true },
      );
      socket.send(Buffer.from(packet), targetPort, "127.0.0.1", (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

describe("console source filtering", () => {
  it("normalizes IPv4-mapped addresses and treats an unresolved console as unfiltered", async () => {
    expect(normalizeAddress("::ffff:192.168.1.50")).to.equal("192.168.1.50");
    const sources = await resolveConsoleSources("192.168.1.50");
    expect(isFromConsole(sources, "::ffff:192.168.1.50")).to.equal(true);
    expect(isFromConsole(sources, "192.168.1.51")).to.equal(false);
    expect(isFromConsole(null, "10.0.0.1")).to.equal(true);
  });

  it("drops an OSC push from another host, and keeps one from the console", async () => {
    const client = new WingOscClient({ host: "127.0.0.1", port: 9, subscriptionRenewalIntervalMs: 60_000 });
    await client.connect();
    try {
      const localPort = (client as unknown as { udpPort: { socket: dgram.Socket } }).udpPort.socket.address().port;
      const changes: WingParamChange[] = [];
      const handle = client.subscribe();
      handle.on("change", (change) => changes.push(change));

      await pushFrom("127.0.0.2", localPort, "/ch/1/$fdr");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(changes, "a push from 127.0.0.2 must be ignored").to.deep.equal([]);

      await pushFrom("127.0.0.1", localPort, "/ch/1/$fdr");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(changes.map((change) => change.path)).to.deep.equal(["/ch/1/fdr"]);
      handle.close();
    } finally {
      await client.close();
    }
  });
});
