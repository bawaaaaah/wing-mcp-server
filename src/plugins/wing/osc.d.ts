/**
 * Minimal ambient typing for the "osc" npm package (osc.js), which ships
 * without TypeScript definitions. Covers only the surface actually used by
 * wing-osc-client.ts and the test-only wing-mock-server.ts; everything else
 * is intentionally left untyped. See node_modules/osc/README.md and
 * node_modules/osc/src/platforms/osc-node.js / node_modules/osc/src/osc.js
 * for the real (untyped) API this was transcribed from.
 *
 * IMPORTANT: "osc" is a CommonJS module whose `module.exports` is an object
 * built by mutating a local variable (`osc.UDPPort = ...`, etc.) before the
 * final `module.exports = osc;` assignment. Node's ESM/CJS interop (via
 * cjs-module-lexer) cannot statically detect those as named exports — only
 * the default import works at runtime (verified empirically: `import {
 * UDPPort } from "osc"` throws `SyntaxError: Named export 'UDPPort' not
 * found` under Node's ESM loader, while `import osc from "osc"; osc.UDPPort`
 * works). Always import the default and access members off of it; only
 * `import type { ... }` (type-only, erased at compile time) is safe as a
 * named import from this module.
 */
declare module "osc" {
  export interface OscArgument {
    type: string;
    value: unknown;
  }

  export interface OscMessage {
    address: string;
    args: OscArgument[] | OscArgument | unknown[];
  }

  export interface OscRemoteInfo {
    address: string;
    port: number;
    family?: string;
    size?: number;
  }

  export interface UDPPortOptions {
    localAddress?: string;
    localPort?: number;
    remoteAddress?: string;
    remotePort?: number;
    metadata?: boolean;
    broadcast?: boolean;
    socket?: unknown;
  }

  export class UDPPort {
    constructor(options: UDPPortOptions);
    options: UDPPortOptions;
    /** The underlying Node dgram socket, created once `open()` has bound it. */
    socket?: import("node:dgram").Socket;
    open(): void;
    close(): void;
    send(message: OscMessage, address?: string, port?: number): void;
    on(event: "ready", listener: () => void): this;
    on(event: "message", listener: (message: OscMessage, timeTag: unknown, info: OscRemoteInfo) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: "ready", listener: () => void): this;
    once(event: "message", listener: (message: OscMessage, timeTag: unknown, info: OscRemoteInfo) => void): this;
    once(event: "error", listener: (error: Error) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    off(event: "ready", listener: () => void): this;
    off(event: "message", listener: (message: OscMessage, timeTag: unknown, info: OscRemoteInfo) => void): this;
    off(event: "error", listener: (error: Error) => void): this;
    off(event: string, listener: (...args: unknown[]) => void): this;
    removeListener(event: "ready", listener: () => void): this;
    removeListener(
      event: "message",
      listener: (message: OscMessage, timeTag: unknown, info: OscRemoteInfo) => void,
    ): this;
    removeListener(event: "error", listener: (error: Error) => void): this;
    removeListener(event: string, listener: (...args: unknown[]) => void): this;
  }

  /** Low-level pure encode/decode, used directly only by the test mock server. */
  export function writeMessage(message: OscMessage, options?: { metadata?: boolean }): Uint8Array;
  export function readMessage(data: Uint8Array | Buffer, options?: { metadata?: boolean }): OscMessage;

  interface OscModule {
    UDPPort: typeof UDPPort;
    writeMessage: typeof writeMessage;
    readMessage: typeof readMessage;
  }

  const osc: OscModule;
  export default osc;
}
