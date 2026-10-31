import { expect } from "chai";
import type { NetworkInterfaceInfo } from "node:os";
import {
  deriveSerial,
  formatDiscoveryReply,
  isDiscoveryQuery,
  pickAdvertiseAddress,
  plainIpv4,
} from "../../../src/plugins/wing/wing-bridge-discovery.js";

function v4(address: string, netmask: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask, family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: null };
}

describe("wing-bridge-discovery", () => {
  const interfaces = {
    lo0: [v4("127.0.0.1", "255.0.0.0", true)],
    en0: [v4("192.168.20.23", "255.255.255.0")],
    en7: [v4("10.0.7.2", "255.255.0.0")],
  };

  it("answers with the address on the requester's subnet", () => {
    expect(pickAdvertiseAddress("10.0.200.9", interfaces)).to.equal("10.0.7.2");
    expect(pickAdvertiseAddress("::ffff:192.168.20.140", interfaces)).to.equal("192.168.20.23");
  });

  it("falls back to the first external IPv4 address when no subnet matches", () => {
    expect(pickAdvertiseAddress("172.16.0.4", interfaces)).to.equal("192.168.20.23");
    expect(pickAdvertiseAddress("172.16.0.4", { lo0: interfaces.lo0 })).to.equal(null);
  });

  it("formats the console's reply, dropping commas and capping the name at 16 bytes", () => {
    expect(
      formatDiscoveryReply({ ip: "192.168.20.23", name: "FOH, main desk via bridge", model: "wing-rack", serial: "S123", firmware: "3.1.1" }),
    ).to.equal("WING,192.168.20.23,FOH main desk vi,wing-rack,S123,3.1.1");
  });

  it("never splits a multi-byte character when capping the name", () => {
    const reply = formatDiscoveryReply({ ip: "1.2.3.4", name: "éééééééééé", model: "m", serial: "s", firmware: "f" });
    expect(reply.split(",")[2]).to.equal("éééééééé");
  });

  it("derives a serial distinct from the console's", () => {
    expect(deriveSerial("S123", "BR")).to.equal("S123-BR");
    expect(deriveSerial("", "BR")).to.equal("BR");
  });

  it("recognises the query and nothing else", () => {
    expect(isDiscoveryQuery(Buffer.from("WING?"))).to.equal(true);
    expect(isDiscoveryQuery(Buffer.from("WING?\n"))).to.equal(true);
    expect(isDiscoveryQuery(Buffer.from("WING,1.2.3.4,a,b,c,d"))).to.equal(false);
  });

  it("strips the IPv4-mapped prefix", () => {
    expect(plainIpv4("::ffff:10.0.0.1")).to.equal("10.0.0.1");
    expect(plainIpv4("10.0.0.1")).to.equal("10.0.0.1");
  });
});
