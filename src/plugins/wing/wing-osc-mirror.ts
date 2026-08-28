import dgram from "node:dgram";
import osc from "osc";
import type { OscArgument } from "osc";
import { WingValueError } from "./wing-errors.js";
import type { WingPluginContext } from "./wing-plugin.js";

export interface OscMirrorConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface OscMirrorStatus extends OscMirrorConfig {
  messagesSent: number;
  bytesSent: number;
  lastError: string | null;
}

/**
 * Raw UDP tap for the WING control plane and meter stream: when enabled, re-sends every OSC
 * message `WingOscClient` receives from the console (re-encoded from its parsed form) and every
 * binary packet `WingMeterClient` receives (forwarded as the exact bytes received) to a configured
 * host:port — byte-for-byte, unfiltered. Lets a second app (another OSC-aware tool, a protocol
 * logger, a bridge into a different control surface) observe live console traffic without opening
 * its own connection to the console. Deliberately one-directional (console -> mirror target only,
 * see wing-plugin.ts's connectClients/disconnectClients for the "receives" side this hooks into) —
 * nothing this server sends to the console is mirrored, since the roadmap scope is limited to what
 * ctx.client/ctx.meterClient *receive*.
 *
 * One instance is owned by WingPlugin for the whole process lifetime (see WingPluginContext.oscMirror)
 * and stays wired to whichever client/meterClient instance is currently connected, so it survives a
 * host change / reconnect without needing to be reconfigured. A send failure is recorded in
 * `lastError` and dropped — never thrown into the console-traffic callback path that calls
 * mirrorOscMessage/mirrorRawBuffer.
 */
export class WingOscMirror {
  private config: OscMirrorConfig = { enabled: false, host: "", port: 0 };
  private socket: dgram.Socket | null = null;
  private messagesSent = 0;
  private bytesSent = 0;
  private lastError: string | null = null;

  getStatus(): OscMirrorStatus {
    return { ...this.config, messagesSent: this.messagesSent, bytesSent: this.bytesSent, lastError: this.lastError };
  }

  configure(next: Partial<OscMirrorConfig>): OscMirrorStatus {
    if (next.enabled === undefined && next.host === undefined && next.port === undefined) {
      throw new WingValueError("Nothing to set — pass at least one of enabled/host/port.");
    }
    const merged: OscMirrorConfig = { ...this.config, ...next };
    if (merged.enabled) {
      if (typeof merged.host !== "string" || !merged.host) {
        throw new WingValueError("A target host (non-empty string) is required to enable the OSC mirror.");
      }
      if (!Number.isInteger(merged.port) || merged.port < 1 || merged.port > 65535) {
        throw new WingValueError(`Invalid mirror port ${merged.port} — must be an integer between 1 and 65535.`);
      }
    }
    this.config = merged;
    if (!merged.enabled) {
      this.closeSocket();
    }
    return this.getStatus();
  }

  /** Re-encodes and forwards one OSC message received from the console. No-op while disabled. */
  mirrorOscMessage(address: string, args: OscArgument[]): void {
    if (!this.config.enabled) {
      return;
    }
    let packet: Uint8Array;
    try {
      packet = osc.writeMessage({ address, args });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return;
    }
    this.send(packet);
  }

  /** Forwards one raw meter-stream UDP packet exactly as received. No-op while disabled. */
  mirrorRawBuffer(buf: Buffer): void {
    if (!this.config.enabled) {
      return;
    }
    this.send(buf);
  }

  /** Releases the mirror's own outbound socket — call on plugin shutdown. */
  close(): void {
    this.closeSocket();
  }

  private send(payload: Uint8Array | Buffer): void {
    const socket = this.ensureSocket();
    try {
      socket.send(payload, this.config.port, this.config.host, (err) => {
        if (err) {
          this.lastError = err.message;
          return;
        }
        this.messagesSent += 1;
        this.bytesSent += payload.length;
      });
    } catch (err) {
      // dgram's send() can throw synchronously (e.g. a malformed host/port) instead of only failing
      // via its callback — never let that escape into the console-traffic callback path that calls
      // mirrorOscMessage/mirrorRawBuffer, per this class's contract.
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  private ensureSocket(): dgram.Socket {
    if (!this.socket) {
      const socket = dgram.createSocket("udp4");
      socket.on("error", (err) => {
        this.lastError = err.message;
      });
      socket.unref();
      this.socket = socket;
    }
    return this.socket;
  }

  private closeSocket(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

export function getOscMirrorStatus(ctx: WingPluginContext): OscMirrorStatus {
  return ctx.oscMirror.getStatus();
}

export function configureOscMirror(ctx: WingPluginContext, opts: Partial<OscMirrorConfig>): OscMirrorStatus {
  return ctx.oscMirror.configure(opts);
}
