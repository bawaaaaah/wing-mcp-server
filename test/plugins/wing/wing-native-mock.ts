// Test-only fake WING console for the native protocol's control channel (TCP, ChID 1): a real
// net.Server holding a small node tree with ids, answering navigation, data and definition requests
// and applying writes, and pushing every change to the other connections — the console behaviour the
// tablet bridge relies on (see docs/wing-protocol/03-native-binary-protocol.md). Where real-console
// behaviour is not confirmed yet, it is an option (`echoToSender`, `dataReplyEnd`).

/* eslint-disable no-bitwise -- FNV-1a hashing for node ids. */
import net from "node:net";
import { WebSocket } from "ws";
import { WingChannelDemuxer } from "../../../src/plugins/wing/wing-meter-protocol.js";
import {
  CONTROL_CHANNEL_ID,
  encodeFloat,
  encodeInt,
  encodeNodeDef,
  encodeNodeId,
  encodeString,
  frameControl,
  NativeTokenizer,
  TOKEN_REQUEST_END,
  type NativeNodeType,
  type NativeToken,
} from "../../../src/plugins/wing/wing-native-codec.js";

export interface MockNode {
  id: number;
  parent: MockNode | null;
  name: string;
  index: number;
  type: NativeNodeType;
  unit: string;
  min?: number;
  max?: number;
  items?: string[];
  value: number | string;
  children: MockNode[];
}

/** Leaf spec: "fader" | "int" | "linf" | "string" | "enum:A,B,C", with an optional "=value". */
type LeafSpec = string;

export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The default tree: enough of a WING to exercise strips, sends, mains, sources and a dyn model. */
export function defaultNativeTree(): Record<string, LeafSpec> {
  const leaves: Record<string, LeafSpec> = {};
  for (let ch = 1; ch <= 4; ch++) {
    leaves[`ch/${ch}/fdr`] = "fader=-144";
    leaves[`ch/${ch}/mute`] = "int=0";
    leaves[`ch/${ch}/name`] = "string=";
    leaves[`ch/${ch}/pan`] = "linf=0";
    leaves[`ch/${ch}/in/conn/grp`] = "enum:OFF,LCL,A=LCL";
    leaves[`ch/${ch}/in/conn/in`] = `int=${ch}`;
    for (const send of ["1", "2", "MX1"]) {
      leaves[`ch/${ch}/send/${send}/on`] = "int=0";
      leaves[`ch/${ch}/send/${send}/lvl`] = "fader=-144";
    }
    leaves[`ch/${ch}/main/1/on`] = "int=1";
    leaves[`ch/${ch}/main/1/lvl`] = "fader=0";
    leaves[`ch/${ch}/dyn/mdl`] = "enum:COMP,LA=COMP";
    leaves[`ch/${ch}/dyn/thr`] = "linf=-20";
  }
  for (let aux = 1; aux <= 2; aux++) {
    leaves[`aux/${aux}/fdr`] = "fader=-144";
    for (const send of ["1", "2", "MX1"]) leaves[`aux/${aux}/send/${send}/lvl`] = "fader=-144";
  }
  for (let bus = 1; bus <= 2; bus++) {
    leaves[`bus/${bus}/fdr`] = "fader=0";
    leaves[`bus/${bus}/mute`] = "int=0";
    leaves[`bus/${bus}/name`] = "string=";
    for (const send of ["1", "2", "MX1"]) leaves[`bus/${bus}/send/${send}/lvl`] = "fader=-144";
    for (const insert of ["preins", "postins"]) {
      leaves[`bus/${bus}/${insert}/on`] = "int=0";
      leaves[`bus/${bus}/${insert}/ins`] = "enum:NONE,FX1,FX2=NONE";
    }
  }
  for (let fx = 1; fx <= 2; fx++) {
    leaves[`fx/${fx}/mdl`] = "enum:NONE,HALL,ROOM=HALL";
    leaves[`fx/${fx}/dcy`] = "linf=2";
  }
  leaves["main/1/fdr"] = "fader=0";
  leaves["main/1/mute"] = "int=0";
  leaves["mtx/1/fdr"] = "fader=-144";
  leaves["dca/1/fdr"] = "fader=0";
  for (let n = 1; n <= 4; n++) {
    leaves[`io/in/LCL/${n}/g`] = "linf=0";
    leaves[`io/in/LCL/${n}/name`] = "string=";
  }
  return leaves;
}

function parseLeaf(spec: LeafSpec): Pick<MockNode, "type" | "unit" | "min" | "max" | "items" | "value"> {
  const [kind, raw = ""] = spec.split("=");
  if (kind.startsWith("enum:")) {
    const items = kind.slice(5).split(",");
    return { type: "enum", unit: "", items, value: raw || items[0] };
  }
  switch (kind) {
    case "fader":
      return { type: "fader", unit: "dB", value: Number(raw || 0) };
    case "int":
      return { type: "int", unit: "", min: 0, max: 1000, value: Number(raw || 0) };
    case "linf":
      return { type: "linf", unit: "", min: -1000, max: 1000, value: Number(raw || 0) };
    default:
      return { type: "string", unit: "", value: raw };
  }
}

export interface WingNativeMockOptions {
  /** Push a connection's own write back to it too (unknown on hardware; the bridge must cope either way). */
  echoToSender?: boolean;
  /** End a data request's reply with 0xde (default true). */
  dataReplyEnd?: boolean;
  leaves?: Record<string, LeafSpec>;
  /** Called after a client's write is applied (path without a leading slash). */
  onWrite?: (path: string, value: number | string) => void;
  /**
   * Cut a definition reply on this node (path without a leading slash, "" = root) short, as a lost
   * packet would: only its first record is sent, and no closing 0xde.
   */
  truncateDefReply?: (path: string) => boolean;
}

interface Session {
  socket: net.Socket;
  demuxer: WingChannelDemuxer;
  tokenizer: NativeTokenizer;
  current: MockNode | null;
}

export class WingNativeMock {
  readonly root: MockNode;
  private readonly byId = new Map<number, MockNode>();
  private readonly byPath = new Map<string, MockNode>();
  private server: net.Server | null = null;
  private readonly sessions = new Set<Session>();
  private salt = new Map<string, number>();
  /** Every token received on the control channel, by connection number. */
  readonly received: { conn: number; token: NativeToken }[] = [];
  /** Every applied write: path and new value. */
  readonly writes: { path: string; value: number | string }[] = [];
  connectionsAccepted = 0;

  constructor(private readonly opts: WingNativeMockOptions = {}) {
    this.root = { id: 0, parent: null, name: "", index: 0, type: "node", unit: "", value: 0, children: [] };
    this.byPath.set("", this.root);
    for (const [path, spec] of Object.entries(opts.leaves ?? defaultNativeTree())) {
      this.addLeaf(path, spec);
    }
  }

  get openConnections(): number {
    return this.sessions.size;
  }

  private idFor(path: string): number {
    const salted = [...this.salt].filter(([prefix]) => path.startsWith(prefix + "/")).map(([, n]) => `#${n}`).join("");
    return fnv1a(path + salted);
  }

  private addLeaf(path: string, spec: LeafSpec): void {
    const segments = path.split("/");
    let parent = this.root;
    for (let i = 0; i < segments.length; i++) {
      const sub = segments.slice(0, i + 1).join("/");
      let node = this.byPath.get(sub);
      if (!node) {
        const isLeaf = i === segments.length - 1;
        // As on a real console: numbered strips and main assigns are unnamed and told apart by
        // index; sends ("1", "MX1") and everything else are named, with index 0.
        const unnamed = /^\d+$/.test(segments[i]) && parent.name !== "send" && segments[i - 2] !== "io";
        node = {
          id: this.idFor(sub),
          parent,
          name: unnamed ? "" : segments[i],
          index: unnamed ? Number(segments[i]) : 0,
          ...(isLeaf ? parseLeaf(spec) : { type: "node" as const, unit: "", value: 0 }),
          children: [],
        };
        parent.children.push(node);
        this.byPath.set(sub, node);
        this.byId.set(node.id, node);
      }
      parent = node;
    }
  }

  pathOf(node: MockNode): string {
    const segments: string[] = [];
    for (let n: MockNode | null = node; n && n !== this.root; n = n.parent) segments.unshift(n.name || String(n.index));
    return segments.join("/");
  }

  node(path: string): MockNode {
    const node = this.byPath.get(path.replace(/^\//, ""));
    if (!node) throw new Error(`no node ${path}`);
    return node;
  }

  idOf(path: string): number {
    return this.node(path).id;
  }

  get(path: string): number | string {
    return this.node(path).value;
  }

  /** A change made on the desk itself: applied and pushed to every connection. */
  setFromDesk(path: string, value: number | string): void {
    const node = this.node(path);
    node.value = value;
    this.push(node, null);
  }

  /**
   * What changing a processing model does on hardware (assumed, see A15 in the protocol doc): the
   * nodes under `path` get new ids. Existing children keep their names and values.
   */
  renumberSubtree(path: string): void {
    const prefix = path.replace(/^\//, "");
    this.salt.set(prefix, (this.salt.get(prefix) ?? 0) + 1);
    for (const [sub, node] of this.byPath) {
      if (!sub.startsWith(prefix + "/")) continue;
      this.byId.delete(node.id);
      node.id = this.idFor(sub);
      this.byId.set(node.id, node);
    }
  }

  async start(port = 0): Promise<{ port: number }> {
    const server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    this.server = server;
    return { port: (server.address() as net.AddressInfo).port };
  }

  async stop(): Promise<void> {
    for (const session of this.sessions) session.socket.destroy();
    this.sessions.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Drops every connection, as a console reboot would. */
  dropConnections(): void {
    for (const session of this.sessions) session.socket.destroy();
  }

  /** Feeds a connection's raw bytes; exposed so fake-wing can route ChID 1 of a shared socket here. */
  attach(socket: net.Socket): (chunk: Buffer) => void {
    const session: Session = { socket, demuxer: new WingChannelDemuxer(), tokenizer: new NativeTokenizer(), current: this.root };
    const conn = ++this.connectionsAccepted;
    this.sessions.add(session);
    socket.on("close", () => this.sessions.delete(session));
    socket.on("error", () => this.sessions.delete(session));
    return (chunk) =>
      session.demuxer.feed(chunk, (ch, byte) => {
        if (ch !== CONTROL_CHANNEL_ID) return;
        session.tokenizer.feedByte(byte, (token) => {
          this.received.push({ conn, token });
          this.handle(session, token);
        });
      });
  }

  private accept(socket: net.Socket): void {
    const feed = this.attach(socket);
    socket.on("data", feed);
  }

  private send(session: Session, logical: Buffer[]): void {
    if (!session.socket.destroyed) session.socket.write(frameControl(Buffer.concat(logical)));
  }

  private encodeValue(node: MockNode): Buffer {
    if (node.type === "string" || node.type === "enum") return encodeString(String(node.value));
    if (node.type === "int") return encodeInt(Number(node.value));
    return encodeFloat(Number(node.value));
  }

  private push(node: MockNode, from: Session | null): void {
    for (const session of this.sessions) {
      if (session === from && !this.opts.echoToSender) continue;
      this.send(session, [encodeNodeId(node.id), this.encodeValue(node)]);
    }
  }

  private write(session: Session, token: NativeToken): void {
    const node = session.current;
    if (!node || node.type === "node") return;
    let value: number | string;
    switch (token.kind) {
      case "int":
      case "float":
      case "rawFloat":
        value = node.type === "string" || node.type === "enum" ? String(token.value) : token.value;
        break;
      case "string":
        value = node.type === "string" || node.type === "enum" ? token.value : Number(token.value);
        break;
      case "click":
        value = Number(node.value) ? 0 : 1;
        break;
      case "step":
        value = Number(node.value) + token.delta;
        break;
      default:
        return;
    }
    node.value = value;
    this.writes.push({ path: this.pathOf(node), value });
    this.push(node, session);
    this.opts.onWrite?.(this.pathOf(node), value);
  }

  private handle(session: Session, token: NativeToken): void {
    const current = session.current;
    switch (token.kind) {
      case "navId":
        session.current = this.byId.get(token.id) ?? null;
        return;
      case "root":
        session.current = this.root;
        return;
      case "up":
        session.current = current?.parent ?? null;
        return;
      case "navIndex":
        session.current = current?.children[token.index - 1] ?? null;
        return;
      case "navName":
        session.current = current?.children.find((c) => c.name !== "" && c.name === token.name) ?? null;
        return;
      case "reqData": {
        const out: Buffer[] = [];
        if (current) {
          const nodes = current.type === "node" ? current.children.filter((c) => c.type !== "node") : [current];
          for (const node of nodes) out.push(encodeNodeId(node.id), this.encodeValue(node));
        }
        if (this.opts.dataReplyEnd !== false) out.push(Buffer.from([TOKEN_REQUEST_END]));
        this.send(session, out);
        return;
      }
      case "reqDef": {
        const truncate = current !== null && this.opts.truncateDefReply?.(this.pathOf(current)) === true;
        const out: Buffer[] = [];
        for (const child of current?.children ?? []) {
          out.push(
            encodeNodeDef({
              parent: current?.id ?? 0,
              id: child.id,
              index: child.index,
              name: child.name,
              longName: child.name,
              type: child.type,
              unit: child.unit,
              min: child.min,
              max: child.max,
              items: child.items?.map((item) => ({ value: item, label: item })),
              maxLength: child.type === "string" ? 16 : undefined,
            }),
          );
          if (truncate) break;
        }
        if (!truncate) out.push(Buffer.from([TOKEN_REQUEST_END]));
        this.send(session, out);
        return;
      }
      default:
        this.write(session, token);
    }
  }
}

/** A tablet stand-in for tests: connects, sends logical control bytes, collects decoded tokens. */
export class NativeTestClient {
  readonly tokens: NativeToken[] = [];
  private readonly demuxer = new WingChannelDemuxer();
  private readonly tokenizer = new NativeTokenizer();
  private socket: net.Socket | null = null;
  private ws: WebSocket | null = null;
  closed = false;

  private receive(chunk: Buffer): void {
    this.demuxer.feed(chunk, (ch, byte) => {
      if (ch === CONTROL_CHANNEL_ID) this.tokenizer.feedByte(byte, (token) => this.tokens.push(token));
    });
  }

  /** As WING-Q does: the same stream, as binary messages of a WebSocket on "/". */
  async connectWebSocket(port: number, host = "127.0.0.1"): Promise<this> {
    const ws = new WebSocket(`ws://${host}:${port}/`, { origin: "http://localhost" });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.on("message", (data: Buffer) => this.receive(data));
    ws.on("close", () => (this.closed = true));
    ws.on("error", () => undefined);
    this.ws = ws;
    return this;
  }

  async connect(port: number, host = "127.0.0.1"): Promise<this> {
    const socket = net.connect(port, host);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("close", () => (this.closed = true));
    socket.on("error", () => undefined);
    this.socket = socket;
    return this;
  }

  send(...logical: (Buffer | number[])[]): void {
    this.sendRaw(frameControl(Buffer.concat(logical.map((part) => Buffer.from(part)))));
  }

  /** Raw bytes as-is (e.g. a channel-3 meter request). */
  sendRaw(bytes: Buffer): void {
    if (this.ws) this.ws.send(bytes, { binary: true });
    else this.socket?.write(bytes);
  }

  /** Values received for `id` (a value token right after `0xd7 id`), in order. */
  valuesFor(id: number): (number | string)[] {
    const values: (number | string)[] = [];
    let current: number | null = null;
    for (const token of this.tokens) {
      if (token.kind === "navId") current = token.id;
      else if ((token.kind === "int" || token.kind === "float" || token.kind === "rawFloat" || token.kind === "string") && current === id) values.push(token.value);
    }
    return values;
  }

  count(kind: NativeToken["kind"]): number {
    return this.tokens.filter((t) => t.kind === kind).length;
  }

  close(): void {
    this.socket?.destroy();
    this.ws?.terminate();
  }
}
