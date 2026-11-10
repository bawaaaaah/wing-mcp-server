import type { WingBox } from "../wing-config.js";
import type { InputPatchRow, OutputPatchRow, PatchData, SourceListEntry, UserSignal } from "../wing-patch.js";
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
}

export interface ConsoleSourceRow {
  label: string;
  name: string;
  channelNames: string[];
  color?: string;
}

export interface PatchSheetModel {
  boxes: BoxPage[];
  /** Used sources that are not on a stage box: Local, USB, card... */
  consoleSources: ConsoleSourceRow[];
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

function inputCell(port: number, src: SourceListEntry | undefined, channels: string[], patch: string): PortCell {
  const stereo = !!src && src.mode !== null && src.mode !== "M" && !!src.pair;
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
    return { outputName: label, channelNames: s.stripName ? [s.stripName] : [], patch: `${label} ${s.side}`, used: true, color: s.strip === "bus" || s.strip === "fxsend" ? COLOR_BUS : COLOR_MAIN };
  }
  // A user signal (USR 1-24) is a named alias of a strip: that strip is the channel.
  const target = usr?.link.kind === "strip" ? usr.link.targetName : undefined;
  return {
    ...(s.sourceName ? { outputName: s.sourceName } : {}),
    channelNames: target ? [target] : [],
    patch: s.label,
    used: true,
    color: wingHex(usr?.colorName) ?? COLOR_USER,
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
      next.port === row.port + 1
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
  const boxes: BoxPage[] = [];
  const claimed = new Set<string>();

  const hosts = new Map<string, { range: [number, number]; spec: DeviceSpec }>();
  for (const list of Object.values(data.boxMap)) {
    for (const b of list as WingBox[]) if (!b.via) hosts.set(b.device, { range: b.range, spec: findDeviceSpec(b.device, b.model, b.range[1] - b.range[0] + 1) });
  }

  for (const [boxGroup, list] of Object.entries(data.boxMap)) {
    for (const box of list as WingBox[]) {
      // A box hung off another one plays the console outputs of its `feed`, numbered 1.. on the box.
      const feed = box.via ? resolveFeed(box, boxGroup, hosts.get(box.via)) : undefined;
      const group = feed?.group ?? boxGroup;
      const [lo, hi] = feed?.range ?? box.range;
      const spec = findDeviceSpec(box.device, box.model, hi - lo + 1);
      const first = feed ? 1 : (box.localPorts?.[0] ?? 1);
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
          const cell = inputCell(localOf(idx), src, channels.get(key) ?? [], src?.pair ? `${group}${src.pair[0]}-${src.pair[1]}` : key);
          if (src?.pair) cell.channelNames = [...new Set([...(channels.get(`${group}${src.pair[0]}`) ?? []), ...(channels.get(`${group}${src.pair[1]}`) ?? [])])];
          cell.used = cell.channelNames.length > 0 || !!src?.name;
          inputs.push(cell);
        }
      }
      const rows = data.outputs
        .filter((o) => o.group === group && o.port >= lo && o.port <= Math.min(hi, lo + spec.outs - 1))
        .sort((a, b) => a.port - b.port);
      const outs = outputCells(
        rows,
        (r) => localOf(r.port),
        (r) => (r.signal.kind === "source" && r.signal.group === "USR" ? data.userSignals.find((u) => u.index === (r.signal as { rawIn: number }).rawIn) : undefined),
      );
      // Output ports with nothing patched are not in `rows` (filtered upstream): fill them as free.
      const seen = new Set(outs.flatMap((c) => (c.span === 2 ? [c.port, c.port + 1] : [c.port])));
      const outCount = Math.min(spec.outs, hi - lo + 1);
      for (let n = 0; n < outCount; n++) {
        const lp = first + n;
        if (!seen.has(lp)) outs.push({ port: lp, span: 1, channelNames: [], used: false });
      }
      outs.sort((a, b) => a.port - b.port);
      // A HUB4 serves its outputs as 4 ports of 4 signals.
      if (spec.kind === "hub") for (const c of outs) c.patch = `Port ${Math.ceil(c.port / 4)} · ${group}${lo + c.port - 1}`;
      boxes.push({
        device: box.device,
        spec,
        group,
        link: `${group} ${lo}-${hi}`,
        range: [lo, hi],
        ...(box.via ? { via: box.via } : {}),
        ...(box.hub ? { hub: box.hub } : {}),
        inputs,
        outputs: outs,
      });
    }
  }

  const consoleSources: ConsoleSourceRow[] = [];
  for (const s of data.sources) {
    const key = `${s.group}${s.index}`;
    if (claimed.has(key)) continue;
    // A stereo pair is one row: skip its second member.
    if (s.pair && s.index !== s.pair[0]) continue;
    const ch = s.pair ? [...new Set([...(channels.get(`${s.group}${s.pair[0]}`) ?? []), ...(channels.get(`${s.group}${s.pair[1]}`) ?? [])])] : (channels.get(key) ?? []);
    if (!s.name && ch.length === 0) continue;
    consoleSources.push({ label: s.pair ? `${s.group} ${s.pair[0]}-${s.pair[1]}` : `${s.group} ${s.index}`, name: s.name, channelNames: ch, ...(wingHex(s.colorName) ? { color: wingHex(s.colorName) } : {}) });
  }
  return { boxes, consoleSources };
}

/** Lines shown in a cell, per naming mode. */
export function cellLines(cell: PortCell, naming: NamingMode): string[] {
  const ch = cell.channelNames.join(" + ");
  const free = "libre";
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
