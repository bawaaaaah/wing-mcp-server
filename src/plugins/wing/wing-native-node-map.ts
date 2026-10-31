// What the tablet bridge knows of the console's native node tree: id <-> path, learned from node
// definition records (0xdf) — the ones it asks for itself to cover the safe strips, and every one a
// tablet asks for, as they pass through. The native protocol addresses nodes by id (or by stepping
// through the tree), never by path, so this is what lets a safe written as "/ch/5" stop a write to
// "0xd7 <id of /ch/5/fdr>".

import { encodeNodeId, TOKEN_ROOT, type NativeNodeDef, type NativeToken } from "./wing-native-codec.js";

export interface NativeNodeEntry {
  id: number;
  parent: number;
  name: string;
  index: number;
  type: NativeNodeDef["type"];
  readOnly: boolean;
}

interface ChildList {
  byName: Map<string, number>;
  byIndex: Map<number, number>;
  complete: boolean;
}

export class NativeNodeMap {
  private readonly nodes = new Map<number, NativeNodeEntry>();
  private readonly children = new Map<number, ChildList>();
  private readonly pathCache = new Map<number, string | null>();
  /** The id the console reports as the parent of the root's children; null until a root listing is seen. */
  rootId: number | null = null;

  get size(): number {
    return this.nodes.size;
  }

  clear(): void {
    this.nodes.clear();
    this.children.clear();
    this.pathCache.clear();
    this.rootId = null;
  }

  learn(def: NativeNodeDef): void {
    const previous = this.nodes.get(def.id);
    if (previous && previous.parent !== def.parent) this.pathCache.clear();
    this.nodes.set(def.id, { id: def.id, parent: def.parent, name: def.name, index: def.index, type: def.type, readOnly: def.readOnly });
    const list = this.childList(def.parent);
    list.byName.set(def.name.toLowerCase(), def.id);
    list.byIndex.set(def.index, def.id);
    this.pathCache.delete(def.id);
  }

  /** Records that `parentId`'s children were listed in full (a definition request ended). */
  markComplete(parentId: number, isRoot = false): void {
    this.childList(parentId).complete = true;
    if (isRoot) this.rootId = parentId;
  }

  isComplete(parentId: number): boolean {
    return this.children.get(parentId)?.complete === true;
  }

  get(id: number): NativeNodeEntry | undefined {
    return this.nodes.get(id);
  }

  childrenOf(parentId: number): NativeNodeEntry[] {
    const list = this.children.get(parentId);
    if (!list) return [];
    return [...list.byIndex.values()].map((id) => this.nodes.get(id)).filter((n): n is NativeNodeEntry => n !== undefined);
  }

  child(parentId: number, step: { name: string } | { index: number }): number | null {
    const list = this.children.get(parentId);
    if (!list) return null;
    return ("name" in step ? list.byName.get(step.name.toLowerCase()) : list.byIndex.get(step.index)) ?? null;
  }

  /** "/ch/5/fdr", or null when the chain up to the root is not known. */
  pathOf(id: number): string | null {
    if (this.pathCache.has(id)) return this.pathCache.get(id) ?? null;
    const segments: string[] = [];
    let current = this.nodes.get(id);
    let path: string | null = null;
    for (let depth = 0; current && depth < 32; depth++) {
      segments.unshift(current.name);
      if (this.rootId !== null && current.parent === this.rootId) {
        path = "/" + segments.join("/");
        break;
      }
      current = this.nodes.get(current.parent);
    }
    this.pathCache.set(id, path);
    return path;
  }

  idOf(path: string): number | null {
    if (this.rootId === null) return null;
    let id = this.rootId;
    for (const segment of path.split("/").filter(Boolean)) {
      const next = this.child(id, { name: segment });
      if (next === null) return null;
      id = next;
    }
    return id;
  }

  /** Drops what is known under `id` (not `id` itself): its children get listed again on the next walk. */
  forgetBelow(id: number): void {
    const list = this.children.get(id);
    if (!list) return;
    for (const childId of list.byIndex.values()) {
      this.forgetBelow(childId);
      this.nodes.delete(childId);
    }
    this.children.delete(id);
    this.pathCache.clear();
  }

  private childList(parentId: number): ChildList {
    let list = this.children.get(parentId);
    if (!list) {
      list = { byName: new Map(), byIndex: new Map(), complete: false };
      this.children.set(parentId, list);
    }
    return list;
  }
}

/** Names compare as the safe rules read paths: case-insensitive, a leading "$" ignored. */
function sameName(a: string, b: string): boolean {
  return a.toLowerCase().replace(/^\$+/, "") === b.toLowerCase().replace(/^\$+/, "");
}

/** Lists a node's children: `"root"` is the tree root (0xda 0xdd), otherwise 0xd7 id 0xdd. */
export type DefinitionRequester = (target: number | "root") => Promise<NativeNodeDef[]>;

/**
 * Walks just enough of the tree to resolve every node matching `patterns` ("/ch/5/**",
 * "/ch/*\/send/3/**", "/io/in/LCL/4/**"): the child lists of every node on the way down, complete,
 * and the whole subtree under a trailing "**". Already-complete lists are not asked for again.
 * Returns how many definition requests it sent.
 */
export async function walkNodeMap(map: NativeNodeMap, request: DefinitionRequester, patterns: string[]): Promise<number> {
  let requests = 0;
  const inFlight = new Map<number | "root", Promise<NativeNodeEntry[]>>();

  const ensureChildren = (id: number | "root"): Promise<NativeNodeEntry[]> => {
    let pending = inFlight.get(id);
    if (!pending) {
      pending = listChildren(id);
      inFlight.set(id, pending);
    }
    return pending;
  };

  const listChildren = async (id: number | "root"): Promise<NativeNodeEntry[]> => {
    if (id === "root") {
      if (map.rootId === null || !map.isComplete(map.rootId)) {
        requests += 1;
        const defs = await request("root");
        const rootId = defs[0]?.parent ?? 0;
        for (const def of defs) map.learn(def);
        map.markComplete(rootId, true);
      }
      return map.childrenOf(map.rootId ?? 0);
    }
    if (!map.isComplete(id)) {
      requests += 1;
      const defs = await request(id);
      for (const def of defs) map.learn(def);
      map.markComplete(id);
    }
    return map.childrenOf(id);
  };

  const walkSubtree = async (id: number): Promise<void> => {
    const children = await ensureChildren(id);
    await Promise.all(children.filter((c) => c.type === "node").map((c) => walkSubtree(c.id)));
  };

  const expand = async (at: number | "root", segments: string[]): Promise<void> => {
    if (segments.length === 0) return;
    const [segment, ...rest] = segments;
    if (segment === "**") {
      if (at === "root") throw new RangeError("refusing to walk the whole tree");
      await walkSubtree(at);
      return;
    }
    const children = await ensureChildren(at);
    const matches = segment === "*" ? children : children.filter((c) => sameName(c.name, segment));
    await Promise.all(matches.filter((c) => c.type === "node" && rest.length > 0).map((c) => expand(c.id, rest)));
  };

  await Promise.all(patterns.map((pattern) => expand("root", pattern.split("/").filter(Boolean))));
  return requests;
}

/**
 * Where a tablet's "current node" is. Anchored by `0xd7 id` or `0xda` (root); relative steps
 * (index, name, up) are resolved through the map when it can, and otherwise kept as the exact bytes
 * the tablet sent, so the position can always be replayed upstream even when it cannot be named.
 */
export class NativePosition {
  private anchor: Buffer = Buffer.from([TOKEN_ROOT]);
  private steps: Buffer[] = [];
  /** The node id, when known. */
  id: number | null = null;
  /** True once a relative step could not be resolved: `id` is then unknown. */
  unresolved = false;

  constructor(private readonly map: NativeNodeMap) {
    this.id = map.rootId;
    this.unresolved = map.rootId === null;
  }

  /** Applies a navigation token; returns false for any other token. */
  apply(token: NativeToken): boolean {
    switch (token.kind) {
      case "navId":
        this.anchor = token.bytes;
        this.steps = [];
        this.id = token.id;
        this.unresolved = false;
        return true;
      case "root":
        this.anchor = token.bytes;
        this.steps = [];
        this.id = this.map.rootId;
        this.unresolved = this.map.rootId === null;
        return true;
      case "up":
      case "navIndex":
      case "navName": {
        this.steps.push(token.bytes);
        if (this.unresolved || this.id === null) {
          this.unresolved = true;
          this.id = null;
          return true;
        }
        const next =
          token.kind === "up"
            ? (this.map.get(this.id)?.parent ?? null)
            : this.map.child(this.id, token.kind === "navIndex" ? { index: token.index } : { name: token.name });
        if (next === null) {
          this.unresolved = true;
          this.id = null;
        } else {
          this.id = next;
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** Bytes that put another connection on the same node. */
  replay(): Buffer {
    if (this.id !== null && !this.unresolved && this.id !== this.map.rootId) return encodeNodeId(this.id);
    return Buffer.concat([this.anchor, ...this.steps]);
  }

  /** A stable key for comparing positions. */
  key(): string {
    return this.replay().toString("hex");
  }
}

export type NativeWriteVerdict = { allow: true; path: string | null } | { allow: false; reason: string; path: string | null };

/**
 * Whether a write on `position` may reach the console, given the safes. Fail-closed:
 * - safes exist but the map of their subtrees is not complete yet -> blocked;
 * - the node is known and its path is protected -> blocked;
 * - the position could not be resolved (relative steps the map cannot follow) -> blocked;
 * - the node is unknown: the protected subtrees and every node above them are fully listed, so an
 *   unknown id is outside them -> allowed, unless part of the map is stale (a model change renumbered
 *   nodes and the re-walk has not finished) -> blocked.
 */
export function nativeWriteVerdict(opts: {
  map: NativeNodeMap;
  position: NativePosition;
  hasSafes: boolean;
  mapReady: boolean;
  mapStale: boolean;
  isProtectedPath: (path: string) => boolean;
}): NativeWriteVerdict {
  const { map, position } = opts;
  const path = position.id !== null && !position.unresolved ? map.pathOf(position.id) : null;
  if (!opts.hasSafes) return { allow: true, path };
  if (!opts.mapReady) return { allow: false, reason: "safe map not ready", path };
  if (position.unresolved || position.id === null) return { allow: false, reason: "position not resolvable", path };
  if (path !== null) {
    return opts.isProtectedPath(path) ? { allow: false, reason: "protected", path } : { allow: true, path };
  }
  if (opts.mapStale) return { allow: false, reason: "unknown node while the safe map is being refreshed", path };
  return { allow: true, path };
}
