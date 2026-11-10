import type { WingBox } from "../wing-config.js";
import type { InputPatchRow, OutputPatchRow, PatchData, SourceListEntry, UserSignal } from "../wing-patch.js";
import { wingColorName } from "../wing-param-catalog.js";
import { GROUP_PORT_LIMIT } from "./box-map-validation.js";
import { COLOR_BUS, COLOR_MAIN, COLOR_USER, wingHex } from "./colors.js";
import { findDeviceSpec, resolveFeed, type DeviceSpec } from "./device-catalog.js";

/** How a port is labelled: the I/O's own name, the channel's name first, or all of them. */
export type NamingMode = "io" | "channel" | "full";

export interface PortCell {
  /** The box's own connector number (first one if the cell spans a stereo pair). */
  port: number;
  /** 1 for a mono connector, 2 for a stereo pair or an L/R output pair. */
  span: number;
  /** The physical input's name / the output's signal name. Undefined when the console has none. */
  inputName?: string;
  /** Names of the channels fed by this input, or the strip/channel an output carries. */
  channelNames: string[];
  outputName?: string;
  mode?: string;
  colorName?: string;
  /** Hex colour of the cell (WING colour of the source/user signal, or the output's role). */
  color?: string;
  phantom48v?: boolean;
  /** Technical label of what is patched ("A9-10", "Bus 4 · L/R", "USR 3"). */
  patch?: string;
  used: boolean;
}

export interface BoxPage {
  /** Left out of the sheet (no page of its own) but still part of the wiring: links and counts keep it. */
  hidden?: boolean;
  device: string;
  spec: DeviceSpec;
  group: string;
  /** Console ports the box covers, "A 33-48". */
  link: string;
  range: [number, number];
  via?: string;
  /** The hub (HUB4) this box is plugged into. */
  hub?: string;
  inputs: PortCell[];
  outputs: PortCell[];
  /** DL16 / S16: the AES50 ports its eight XLR outputs follow, and whether its Ultranet carries its own inputs. */
  outRange?: [number, number];
  splitter?: boolean;
}

export interface ConsoleSourceRow {
  label: string;
  name: string;
  channelNames: string[];
  color?: string;
}

/** One line of a console port's contents: a device, indented under the one it hangs off. */
export interface PortLine {
  name: string;
  /** "A 1-8", "port 2", "Ultranet": where it sits. */
  detail: string;
  indent: 0 | 1 | 2;
  kind: DeviceSpec["kind"];
}

/** A port of the console and what is plugged into it. */
export interface ConsolePort {
  group: string;
  /** As WING Edit names it: "AES50 A", "ST CONNECT"... */
  label: string;
  lines: PortLine[];
}

export interface PatchSheetModel {
  /** What is plugged into each port of the console, for the "ports" page. */
  consolePorts: ConsolePort[];
  boxes: BoxPage[];
  /** Used sources that are not on a stage box: Local, USB, card... */
  consoleSources: ConsoleSourceRow[];
}

/** What the four outputs of a HUB4 port are called on its back panel (A 33-36 = port 1, 37-40 = port 2...). */
export const HUB_OUT_NAMES = ["MIX A-L", "MIX A-R", "MIX B-L", "MIX B-R"] as const;

/** Source groups as WING Edit names them. */
export const SOURCE_GROUP_LABEL: Record<string, string> = {
  LCL: "LOCAL IN",
  AUX: "AUX IN",
  AES: "AES/EBU IN",
  A: "AES50 A",
  B: "AES50 B",
  C: "AES50 C",
  SC: "ST CONNECT",
  USB: "USB AUDIO",
  CRD: "WLIVE PLAY",
  MOD: "DANTE",
  PLAY: "USB PLAYER",
  OSC: "OSCILLATOR",
};
export function groupLabel(group: string): string {
  return SOURCE_GROUP_LABEL[group] ?? group;
}

const STRIP_LABEL: Record<string, string> = { bus: "Bus", main: "Main", mtx: "Matrix", fxsend: "FX send", monitor: "Monitor" };

type InputSource = Exclude<InputPatchRow["source"], null | { tap: unknown }>;
function isSourceInput(s: InputPatchRow["source"]): s is InputSource {
  return s !== null && !("tap" in s);
}

/** `${group}${index}` -> channel names using that physical source, through user patches too. */
export function channelsBySource(data: Pick<PatchData, "inputs" | "userSignals">): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (group: string, indexes: number[], name: string) => {
    for (const i of indexes) {
      const key = `${group}${i}`;
      const list = out.get(key) ?? [];
      if (name && !list.includes(name)) list.push(name);
      out.set(key, list);
    }
  };
  for (const r of data.inputs) {
    if (!isSourceInput(r.source)) continue;
    const s = r.source;
    // `ownName` first: a name linked to the source would just repeat the input's own name.
    const name = r.ownName || (r.nameLinkedToSource ? "" : r.effectiveName);
    const indexes = s.pair ? [s.pair[0], s.pair[1]] : [s.index];
    if (s.group === "USR") {
      const u = data.userSignals.find((x) => x.index === s.index);
      if (u && u.link.kind === "source" && u.link.group && u.link.index) add(u.link.group, [u.link.index], name);
      continue;
    }
    add(s.group, indexes, name);
  }
  return out;
}

function inputCell(port: number, src: SourceListEntry | undefined, channels: string[], patch: string, stereo: boolean): PortCell {
  return {
    port,
    span: stereo ? 2 : 1,
    ...(src?.name ? { inputName: src.name } : {}),
    channelNames: channels,
    ...(src?.mode ? { mode: src.mode } : {}),
    ...(src?.colorName ? { colorName: src.colorName } : {}),
    ...(wingHex(src?.colorName) ? { color: wingHex(src?.colorName) } : {}),
    ...(src?.phantom48v ? { phantom48v: true } : {}),
    patch,
    used: channels.length > 0 || !!src?.name,
  };
}

function outputLabel(row: OutputPatchRow, usr: UserSignal | undefined): Pick<PortCell, "outputName" | "channelNames" | "patch" | "used" | "color" | "mode"> {
  const s = row.signal;
  if (s.kind === "off") return { channelNames: [], used: false };
  if (s.kind === "tap") {
    const label = `${STRIP_LABEL[s.strip] ?? s.strip} ${s.stripIndex}`;
    return { outputName: label, channelNames: s.stripName ? [s.stripName] : [], patch: `${label} ${s.side}`, used: true, color: wingHex(s.col ? wingColorName(s.col) : undefined) ?? (s.strip === "bus" || s.strip === "fxsend" ? COLOR_BUS : COLOR_MAIN) };
  }
  // A user signal (USR 1-24) is a named alias of a strip: that strip is the channel.
  const target = usr?.link.kind === "strip" ? usr.link.targetName : undefined;
  return {
    ...(s.sourceName ? { outputName: s.sourceName } : {}),
    channelNames: target ? [target] : [],
    patch: s.label,
    used: true,
    color: wingHex(usr?.colorName) ?? wingHex(s.col ? wingColorName(s.col) : undefined) ?? COLOR_USER,
    ...(usr?.mode ? { mode: usr.mode } : {}),
  };
}

/** Adjacent L then R outputs of one strip become a single two-wide cell ("Bus 4 · L/R"). */
function outputCells(rows: OutputPatchRow[], base: (row: OutputPatchRow) => number, usrFor: (row: OutputPatchRow) => UserSignal | undefined): PortCell[] {
  const cells: PortCell[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as OutputPatchRow;
    const next = rows[i + 1];
    const info = outputLabel(row, usrFor(row));
    let span = 1;
    if (
      row.signal.kind === "tap" &&
      row.signal.side === "L" &&
      next?.signal.kind === "tap" &&
      next.signal.side === "R" &&
      next.signal.strip === row.signal.strip &&
      next.signal.stripIndex === row.signal.stripIndex &&
      next.port === row.port + 1 &&
      // A pair starts on an odd connector of its box: slots 2-3 cannot be one stereo pair.
      base(row) % 2 === 1
    ) {
      span = 2;
      i++;
      if (info.patch) info.patch = info.patch.replace(/ L$/, " · L/R");
    }
    cells.push({ port: base(row), span, ...info });
  }
  return cells;
}

export function buildPatchSheet(data: PatchData): PatchSheetModel {
  const byGroupIndex = new Map<string, SourceListEntry>();
  for (const s of data.sources) byGroupIndex.set(`${s.group}${s.index}`, s);
  const channels = channelsBySource(data);
  const claimed = new Set<string>();

  const hosts = new Map<string, { range: [number, number]; spec: DeviceSpec; group: string; box: WingBox }>();
  for (const [g, list] of Object.entries(data.boxMap)) {
    for (const b of list as WingBox[]) if (!b.via) hosts.set(b.device, { range: b.range, spec: findDeviceSpec(b.device, b.model, b.range[1] - b.range[0] + 1, g), group: g, box: b });
  }

  type Entry = { group: string; box: WingBox; list: WingBox[] };
  const entries: Entry[] = [];
  for (const [g, list] of Object.entries(data.boxMap)) for (const b of list as WingBox[]) entries.push({ group: g, box: b, list: list as WingBox[] });
  const built = new Map<WingBox, BoxPage>();
  const buildOne = ({ group: boxGroup, box, list }: Entry): void => {
      // A box hung off another one plays the console outputs of its `feed`, numbered 1.. on the box.
      const host = box.via ? hosts.get(box.via) : undefined;
      // On a host in splitter mode the Ultranet carries the host's own inputs, not console outputs.
      const splitterHost = !!host?.box.splitter;
      const feed = box.via && !splitterHost ? resolveFeed(box, boxGroup, host) : undefined;
      const group = splitterHost && host ? host.group : (feed?.group ?? boxGroup);
      const [lo, configuredHi] = splitterHost && host ? [host.range[0], host.range[0] + 15] : (feed?.range ?? box.range);
      const spec = findDeviceSpec(box.device, box.model, configuredHi - lo + 1, group);
      // A known box has all its connectors even when the range saved for it is shorter (a DL16 saved
      // as B 1-8): extend it to its input count unless another box sits on the ports it would take.
      let hi = configuredHi;
      if (!feed && (spec.kind === "stagebox" || spec.kind === "converter") && spec.ins > hi - lo + 1) {
        const wanted = Math.min(lo + spec.ins - 1, GROUP_PORT_LIMIT[group] ?? 999);
        const clash = (list as WingBox[]).some((o) => o !== box && !o.via && o.range[0] <= wanted && o.range[1] > hi);
        if (!clash) hi = wanted;
      }
      const first = box.via ? 1 : (box.localPorts?.[0] ?? 1);
      const localOf = (consolePort: number) => first + (consolePort - lo);
      const inputs: PortCell[] = [];
      if (!box.via) {
        const count = Math.min(spec.ins, hi - lo + 1);
        for (let n = 0; n < count; n++) {
          const idx = lo + n;
          const key = `${group}${idx}`;
          claimed.add(key);
          const src = byGroupIndex.get(key);
          // The odd member of a stereo pair carries the pair; the even one is covered by its span.
          const prev = byGroupIndex.get(`${group}${idx - 1}`);
          if (prev && prev.pair && prev.pair[1] === idx && idx - 1 >= lo) continue;
          // A pair is one two-wide cell only when both members are on this box (it may start or end mid-pair).
          const pairInside = !!src && src.mode !== null && src.mode !== "M" && !!src.pair && src.pair[0] === idx && src.pair[1] <= hi;
          const cell = inputCell(localOf(idx), src, channels.get(key) ?? [], pairInside && src?.pair ? `${group}${src.pair[0]}-${src.pair[1]}` : key, pairInside);
          if (pairInside && src?.pair) cell.channelNames = [...new Set([...(channels.get(`${group}${src.pair[0]}`) ?? []), ...(channels.get(`${group}${src.pair[1]}`) ?? [])])];
          cell.used = cell.channelNames.length > 0 || !!src?.name;
          inputs.push(cell);
        }
      }
      // DL16 / S16 output modes: the eight XLR outputs follow AES50 ch 1-8, 9-16 or 17-24 of the box.
      const modes = !box.via && !!spec.outModes;
      const outLo = modes ? lo + (box.outOffset ?? 0) : lo;
      const outHi = modes ? outLo + spec.outs - 1 : Math.min(hi, lo + spec.outs - 1);
      const rows = data.outputs
        .filter((o) => o.group === group && o.port >= outLo && o.port <= outHi)
        .sort((a, b) => a.port - b.port);
      let outs = outputCells(
        rows,
        (r) => first + (r.port - outLo),
        (r) => (r.signal.kind === "source" && r.signal.group === "USR" ? data.userSignals.find((u) => u.index === (r.signal as { rawIn: number }).rawIn) : undefined),
      );
      // Output ports with nothing patched are not in `rows` (filtered upstream): fill them as free.
      const seen = new Set(outs.flatMap((c) => (c.span === 2 ? [c.port, c.port + 1] : [c.port])));
      const outCount = modes ? spec.outs : Math.min(spec.outs, hi - lo + 1);
      for (let n = 0; n < outCount; n++) {
        const lp = first + n;
        if (!seen.has(lp)) outs.push({ port: lp, span: 1, channelNames: [], used: false });
      }
      outs.sort((a, b) => a.port - b.port);
      // Splitter mode: the mixer plays the host's own inputs 1-16 (its Local In), as the host shows them.
      if (splitterHost && host) {
        const hostPage = built.get(host.box);
        outs = (hostPage?.inputs ?? []).filter((c) => c.port <= 16).map((c) => ({ ...c }));
        const covered = new Set(outs.flatMap((c) => (c.span === 2 ? [c.port, c.port + 1] : [c.port])));
        for (let p = 1; p <= 16; p++) if (!covered.has(p)) outs.push({ port: p, span: 1, channelNames: [], used: false });
        outs.sort((a, b) => a.port - b.port);
      }
      // A HUB4 serves its outputs on its back panel: 4 ports of MIX A L/R and MIX B L/R.
      if (spec.kind === "hub") for (const c of outs) c.patch = `P${Math.ceil(c.port / 4)} ${HUB_OUT_NAMES[(c.port - 1) % 4]} · ${group}${lo + c.port - 1}`;
      built.set(box, {
        device: box.device,
        spec,
        group,
        link: `${group} ${lo}-${hi}`,
        range: [lo, hi],
        ...(box.via ? { via: box.via } : {}),
        ...(box.hub ? { hub: box.hub } : {}),
        ...(modes ? { outRange: [outLo, outLo + spec.outs - 1] as [number, number] } : {}),
        ...(modes && box.splitter ? { splitter: true } : {}),
        ...(splitterHost ? { splitter: true } : {}),
        inputs,
        outputs: outs,
      });
  };
  // A box that takes its data from another (a personal mixer on a splitter box) is built after it.
  for (const e of entries) if (!e.box.via) buildOne(e);
  for (const e of entries) if (e.box.via) buildOne(e);
  const boxes = entries.map((e) => built.get(e.box)).filter((b): b is BoxPage => !!b);

  const consoleSources: ConsoleSourceRow[] = [];
  for (const s of data.sources) {
    const key = `${s.group}${s.index}`;
    if (claimed.has(key)) continue;
    // A stereo pair is one row: skip its second member.
    if (s.pair && s.index !== s.pair[0]) continue;
    const ch = s.pair ? [...new Set([...(channels.get(`${s.group}${s.pair[0]}`) ?? []), ...(channels.get(`${s.group}${s.pair[1]}`) ?? [])])] : (channels.get(key) ?? []);
    if (!s.name && ch.length === 0) continue;
    consoleSources.push({ label: s.pair ? `${groupLabel(s.group)} ${s.pair[0]}-${s.pair[1]}` : `${groupLabel(s.group)} ${s.index}`, name: s.name, channelNames: ch, ...(wingHex(s.colorName) ? { color: wingHex(s.colorName) } : {}) });
  }
  return { boxes, consoleSources, consolePorts: buildConsolePorts(boxes) };
}

/** The console's ports in a fixed order: the AES50 links and StageCONNECT always, the rest when used. */
function buildConsolePorts(boxes: BoxPage[]): ConsolePort[] {
  const order = ["LCL", "A", "B", "C", "SC", "AES", "CRD", "MOD"];
  const always = new Set(["A", "B", "C", "SC"]);
  const groups = [...new Set([...order.filter((g) => always.has(g) || boxes.some((b) => b.group === g)), ...boxes.map((b) => b.group)])];
  groups.sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)));
  const range = (b: BoxPage): string => `${groupLabelShort(b.group)} ${b.range[0]}-${b.range[1]}`;
  return groups.map((group) => {
    const lines: PortLine[] = [];
    const tops = boxes.filter((b) => b.group === group && !b.via && !b.hub);
    const kidsOf = (host: BoxPage): BoxPage[] => boxes.filter((k) => k.via === host.device || k.hub === host.device);
    const add = (b: BoxPage, indent: 0 | 1 | 2): void => {
      let detail = range(b);
      if (indent > 0) {
        if (b.via) detail = "Ultranet";
        else if (b.range[0] >= 33) detail = "StageConnect";
        else detail = `port ${Math.floor((b.range[0] - 1) / 8) + 1}`;
      }
      lines.push({ name: b.device, detail, indent, kind: b.spec.kind });
    };
    for (const b of tops) {
      add(b, 0);
      for (const k of kidsOf(b)) {
        add(k, 1);
        for (const kk of kidsOf(k)) add(kk, 2);
      }
    }
    // Boxes hung off a host that sits on another group still belong to that host's port.
    return { group, label: groupLabel(group), lines };
  });
}

function groupLabelShort(group: string): string {
  return group.length <= 3 ? group : groupLabel(group);
}

/** The cell that covers a connector: a stereo pair or an L/R bus pair is one cell spanning two ports. */
export function coveringCell(cells: PortCell[], port: number): PortCell | undefined {
  return cells.find((c) => port >= c.port && port < c.port + c.span);
}

/** Lines shown in a cell, per naming mode. */
export function cellLines(cell: PortCell, naming: NamingMode, free = "libre"): string[] {
  const ch = cell.channelNames.join(" + ");
  switch (naming) {
    case "io":
      return [cell.inputName ?? cell.outputName ?? free];
    case "channel":
      return [ch || cell.inputName || cell.outputName || free];
    case "full": {
      const lines: string[] = [];
      for (const l of [cell.inputName, ch, cell.outputName]) if (l && !lines.includes(l)) lines.push(l);
      return lines.length > 0 ? lines : [free];
    }
  }
}
