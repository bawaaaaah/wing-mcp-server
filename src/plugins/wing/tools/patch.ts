import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveColor, resolveIcon, searchIcons, type ResolvedColor, type ResolvedIcon } from "../wing-color-icon.js";
import { WingBoxMapSchema, type WingBoxMap } from "../wing-config.js";
import { WingValueError } from "../wing-errors.js";
import { isSourceGroup, readSourceIdentity, readStripIdentity, STRIP_KINDS, stripPath, type Identity, type StripKind } from "../wing-identity.js";
import { ioInPath } from "../wing-node-paths.js";
import {
  describeOutputSignal,
  ioGroupCount,
  listSources,
  listUserSignals,
  readInputPatch,
  readOutputPatch,
  readUserSignal,
  USER_SIGNAL_COUNT,
  USER_SIGNAL_STRIP_RANGE_MAX,
  type InputPatchRow,
  type OutputPatchRow,
  type SourceListEntry,
  type UserSignal,
} from "../wing-patch.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { describeWriteResult, writeAssignments, type WingWriteResult } from "../wing-write.js";
import { textResult, wrapWingTool } from "./generic.js";

const colorInput = z
  .union([z.number().int(), z.string()])
  .describe('Palette index 1..18, or a color word in French or English ("rose", "violet", "bleu ciel"...). There is no pink: rose -> Magenta.');
const iconInput = z
  .union([z.number().int(), z.string()])
  .describe('Icon id 0..999, or a word ("chanteuse", "batterie", "piano") matched like wing_icon_search.');
const modeInput = z.enum(["M", "ST", "M/S"]);
const writeFlags = {
  dryRun: z.boolean().optional().describe("Report current vs target without writing."),
  confirm: z.boolean().optional().describe("Required for an audible change (mode, link) when show mode is on."),
};

/** Strip or source or user signal — anything with a name/col/icon. */
const refSchema = z.object({
  kind: z.enum([...STRIP_KINDS, "source", "usr"]),
  group: z.string().optional().describe('Source group for kind "source": LCL, AUX, A, B, C, SC, USB, CRD, MOD, PLAY, AES, USR, OSC.'),
  index: z.number().int().min(1),
});
type Ref = z.infer<typeof refSchema>;

function refBase(ref: Ref): string {
  if (ref.kind === "usr") {
    if (ref.index > USER_SIGNAL_COUNT) throw new WingValueError(`User signal index must be 1..${USER_SIGNAL_COUNT}.`);
    return ioInPath("USR", ref.index);
  }
  if (ref.kind === "source") {
    if (!ref.group || !isSourceGroup(ref.group)) throw new WingValueError(`A source ref needs a valid group (got ${JSON.stringify(ref.group)}).`);
    return ioInPath(ref.group, ref.index);
  }
  return stripPath(ref.kind as StripKind, ref.index);
}

function refLabel(ref: Ref): string {
  return ref.kind === "source" ? `${ref.group}${ref.index}` : `${ref.kind}${ref.index}`;
}

/** The identity a ref shows: a strip's effective one, a source's or user signal's own. */
async function readRefIdentity(ctx: WingPluginContext, ref: Ref): Promise<Identity & { mode?: string }> {
  if (ref.kind === "source") {
    const s = await readSourceIdentity(ctx, ref.group as string, ref.index);
    return { ...s, mode: s.mode ?? undefined };
  }
  if (ref.kind === "usr") {
    const u = await readUserSignal(ctx, ref.index);
    return { name: u.name, col: u.col, colorName: u.colorName, icon: u.icon, iconName: u.iconName, mode: u.mode };
  }
  return (await readStripIdentity(ctx, ref.kind as StripKind, ref.index)).effective;
}

/** The identity a user signal's link points at, for `from: "linked"`. */
async function readLinkedIdentity(ctx: WingPluginContext, usr: UserSignal): Promise<{ identity: Identity; label: string } | null> {
  const { link } = usr;
  if (link.kind === "off" || !link.group || !link.index) return null;
  if (link.kind === "source") {
    return { identity: await readSourceIdentity(ctx, link.group, link.index), label: link.label ?? "" };
  }
  const kind = ({ CH: "ch", AUX: "aux", BUS: "bus", MAIN: "main", MTX: "mtx" } as Record<string, StripKind>)[link.group];
  if (!kind) return null;
  return { identity: (await readStripIdentity(ctx, kind, link.index)).effective, label: link.label ?? "" };
}

function describeUsr(u: UserSignal): string {
  const link =
    u.link.kind === "off"
      ? "off"
      : `${u.link.label}${u.link.kind === "strip" ? ` ${u.link.tap ?? ""} ${u.link.lr ?? ""}`.trimEnd() : ""}` +
        (u.link.targetName !== undefined ? ` "${u.link.targetName}"` : "");
  return `  USR${u.index} ${JSON.stringify(u.name)} ${u.colorName ?? u.col}/${u.iconName ?? u.icon} ${u.mode}${u.mute ? " muted" : ""} <- ${link}`;
}

function describeInputRow(r: InputPatchRow): string {
  const who = `${r.strip}${r.index} ${JSON.stringify(r.effectiveName)}`;
  if (!r.source) return `  ${who} <- OFF`;
  if ("tap" in r.source) {
    const t = r.source.tap;
    return `  ${who} <- ${t ? `${t.strip} ${t.stripIndex} ${t.side}` : r.source.label}${r.source.tapName ? ` "${r.source.tapName}"` : ""}`;
  }
  const s = r.source;
  const extras = [s.sourceName ? `"${s.sourceName}"` : "", s.phantom48v ? "48V" : "", s.box ? `[${s.box.device} ${s.box.devicePort}]` : ""]
    .filter(Boolean)
    .join(" ");
  return `  ${who} <- ${s.label}${extras ? ` ${extras}` : ""}${r.nameLinkedToSource ? " (name linked)" : ""}`;
}

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0] as Record<string, unknown>);
  return [headers.join(","), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(","))].join("\n");
}

export function registerPatchTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_usr_list",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Wing: List user signals",
      description:
        "Lists user signals in one call: name, color, icon, mode (M/ST/M-S), mute, and what each is linked to. " +
        "User signals 1-24 take a strip (`link.kind: \"strip\"`: group CH/AUX/BUS/MAIN/MTX, index, tap PRE/POST, " +
        "lr L+R/L/R, and the strip's effective name as `targetName`); 25-56 are user patches taking a physical " +
        "source (`link.kind: \"source\"`: group LCL/AUX/A/B/C/SC/USB/CRD/MOD/PLAY/AES, index, source name); " +
        "`link.kind: \"off\"` means unassigned. One dump per signal.",
      inputSchema: {
        from: z.number().int().min(1).max(USER_SIGNAL_COUNT).optional(),
        to: z.number().int().min(1).max(USER_SIGNAL_COUNT).optional(),
      },
    },
    ({ from, to }) =>
      wrapWingTool(async () => {
        const signals = await listUserSignals(ctx, from, to);
        return { content: [textResult(signals.map(describeUsr).join("\n"))], structuredContent: { userSignals: signals } };
      }),
  );

  server.registerTool(
    "wing_usr_set",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Wing: Set a user signal",
      description:
        "Sets any of a user signal's name, color, icon, mode and link in one verified write (read back; " +
        "journaled for wing_undo). `link` for 1-24: {group: OFF|CH|AUX|BUS|MAIN|MTX, index 1..40, tap?: PRE|POST, " +
        "lr?: L+R|L|R}; for 25-56: {group: OFF|LCL|AUX|A|B|C|SC|USB|CRD|MOD|PLAY|AES, index 1..64} (no tap/lr). " +
        "`col`/`icon` accept words (\"rose\", \"chanteuse\"). Name, color and icon are cosmetic; mode and link are " +
        "audible.",
      inputSchema: {
        index: z.number().int().min(1).max(USER_SIGNAL_COUNT),
        name: z.string().optional(),
        col: colorInput.optional(),
        icon: iconInput.optional(),
        mode: modeInput.optional(),
        link: z
          .object({
            group: z.string(),
            index: z.number().int().min(1).optional(),
            tap: z.enum(["PRE", "POST"]).optional(),
            lr: z.enum(["L+R", "L", "R"]).optional(),
          })
          .optional(),
        ...writeFlags,
      },
    },
    ({ index, name, col, icon, mode, link, dryRun, confirm }) =>
      wrapWingTool(async () => {
        const assignments: Record<string, number | string> = {};
        let color: ResolvedColor | undefined;
        let ic: ResolvedIcon | undefined;
        if (name !== undefined) assignments.name = name;
        if (col !== undefined) assignments.col = (color = resolveColor(col)).col;
        if (icon !== undefined) assignments.icon = (ic = resolveIcon(icon)).icon;
        if (mode !== undefined) assignments.mode = mode;
        if (link) {
          const strip = index <= USER_SIGNAL_STRIP_RANGE_MAX;
          const groups = strip
            ? ["OFF", "CH", "AUX", "BUS", "MAIN", "MTX"]
            : ["OFF", "LCL", "AUX", "A", "B", "C", "SC", "USB", "CRD", "MOD", "PLAY", "AES"];
          if (!groups.includes(link.group)) {
            throw new WingValueError(
              `User ${strip ? "signal" : "patch"} ${index} links to one of ${groups.join(", ")} — got "${link.group}". ` +
                `(1-24 take a strip, 25-56 a physical source.)`,
            );
          }
          if (!strip && (link.tap || link.lr)) {
            throw new WingValueError(`User patch ${index} (25-56) has no tap or lr — those exist on user signals 1-24 only.`);
          }
          const max = strip ? 40 : 64;
          if (link.index !== undefined && link.index > max) throw new WingValueError(`link.index must be 1..${max}.`);
          assignments["user.grp"] = link.group;
          if (link.index !== undefined) assignments["user.in"] = link.index;
          if (link.tap) assignments["user.tap"] = link.tap;
          if (link.lr) assignments["user.lr"] = link.lr;
        }
        if (Object.keys(assignments).length === 0) throw new WingValueError("Nothing to set.");
        const result = await writeAssignments(ctx, ioInPath("USR", index), assignments, { dryRun, confirm });
        const notes = [
          color?.from ? `color "${color.from}" -> ${color.col} ${color.colorName}` : "",
          ic?.from ? `icon "${ic.from}" -> ${ic.icon} ${ic.iconName}` : "",
        ].filter(Boolean);
        return {
          content: [textResult(`USR${index}: ${describeWriteResult(result)}${notes.length ? `\n${notes.join("; ")}` : ""}`)],
          structuredContent: { index, color, icon: ic, ...result },
          isError: result.ok ? undefined : true,
        };
      }),
  );

  server.registerTool(
    "wing_input_patch",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Wing: Input patch table",
      description:
        "The whole input patch in one call. Per channel/aux: effective and own name, `nameLinkedToSource`, and " +
        "the source as the console displays it — {group, index, storedIndex, stereo, pair, label, sourceName, " +
        "phantom48v, gain, box} — where a stereo pair is reported by its first member (A9-10) even if the strip " +
        "stores the second, plus the alt source. A strip fed from an internal tap (BUS/MAIN/MTX/SEND/MON) reports " +
        "the tapped strip and side instead. `box` is filled when a box map is configured (wing_set_box_map). " +
        "Use this for patch audits instead of wing_get per strip.",
      inputSchema: { strips: z.enum(["ch", "aux", "all"]).optional().describe("Default: all.") },
    },
    ({ strips }) =>
      wrapWingTool(async () => {
        const rows = await readInputPatch(ctx, strips ?? "all");
        return { content: [textResult(rows.map(describeInputRow).join("\n"))], structuredContent: { inputs: rows } };
      }),
  );

  server.registerTool(
    "wing_output_patch",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Wing: Output patch table",
      description:
        "Reads every port of an output group (LCL, AUX, A, B, C, SC, USB, CRD, MOD, REC, AES) and decodes what " +
        "feeds it. Internal taps are numbered in L/R pairs — verified on the console: BUS in=7 is bus 4 left " +
        "(odd = L, even = R; strip = ceil(in/2)), same for MAIN, MTX, SEND (FX sends) and MON (1-2 phones, 3-4 " +
        "speakers) — and come back as {strip, stripIndex, side, stripName}. A physical source comes back with its " +
        "name. `box` gives the stage-box connector when a box map is configured.",
      inputSchema: {
        group: z.string().describe("Output group: LCL, AUX, A, B, C, SC, USB, CRD, MOD, REC, AES."),
        from: z.number().int().min(1).optional(),
        to: z.number().int().min(1).optional(),
      },
    },
    ({ group, from, to }) =>
      wrapWingTool(async () => {
        const rows = await readOutputPatch(ctx, group, from, to);
        const text = rows
          .map((r) => `  ${r.group} ${r.port}${r.box ? ` [${r.box.device} ${r.box.devicePort}]` : ""} <- ${describeOutputSignal(r.signal)}`)
          .join("\n");
        return { content: [textResult(text)], structuredContent: { outputs: rows } };
      }),
  );

  server.registerTool(
    "wing_source_list",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Wing: List input sources",
      description:
        "Lists the physical input sources of one group (LCL, AUX, A, B, C, SC, USB, CRD, MOD, PLAY, AES, USR, OSC) " +
        "with name, color, icon, mode (M/ST/M-S; stereo sources come in odd/even pairs), gain, 48V, mute and " +
        "polarity — one dump each. `box` gives the stage-box connector when a box map is configured.",
      inputSchema: {
        group: z.string(),
        from: z.number().int().min(1).optional(),
        to: z.number().int().min(1).optional(),
      },
    },
    ({ group, from, to }) =>
      wrapWingTool(async () => {
        const sources = await listSources(ctx, group, from, to);
        const text = sources
          .map(
            (s) =>
              `  ${s.group}${s.index} ${JSON.stringify(s.name)} ${s.colorName ?? s.col}/${s.iconName ?? s.icon} ${s.mode ?? ""}` +
              `${s.phantom48v ? " 48V" : ""}${s.gain !== null ? ` ${s.gain} dB` : ""}${s.mute ? " muted" : ""}` +
              `${s.box ? ` [${s.box.device} ${s.box.devicePort}]` : ""}`,
          )
          .join("\n");
        return { content: [textResult(text)], structuredContent: { sources } };
      }),
  );

  server.registerTool(
    "wing_copy_identity",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Wing: Copy name/color/icon",
      description:
        "Copies the identity (name, col, icon, and optionally mode) of one element to one or more others. A ref " +
        "is {kind: ch|aux|bus|main|mtx|dca|mgrp|source|usr, group? (for source), index}. A strip's identity is " +
        "the one it displays (its source's if linked). `from: \"linked\"` with user-signal targets copies, for " +
        "each, the identity of whatever that user signal is linked to — \"name the user signals after what feeds " +
        "them\". `fields` defaults to name, col, icon (`mode` is audible and only copied when asked; it applies " +
        "between sources/user signals only). Verified and journaled (wing_undo).",
      inputSchema: {
        from: z.union([refSchema, z.literal("linked")]),
        to: z.union([refSchema, z.array(refSchema).min(1).max(64)]),
        fields: z.array(z.enum(["name", "col", "icon", "mode"])).optional(),
        ...writeFlags,
      },
    },
    ({ from, to, fields, dryRun, confirm }) =>
      wrapWingTool(async () => {
        const targets = Array.isArray(to) ? to : [to];
        const wanted = new Set(fields ?? ["name", "col", "icon"]);
        const results: Array<{ from: string; to: string; result: WingWriteResult; warning?: string }> = [];
        const fixed = from === "linked" ? null : await readRefIdentity(ctx, from);
        for (const target of targets) {
          let identity: (Identity & { mode?: string }) | null = fixed;
          let fromLabel = from === "linked" ? "" : refLabel(from);
          if (from === "linked") {
            if (target.kind !== "usr") throw new WingValueError(`from: "linked" only applies to user-signal targets (got ${refLabel(target)}).`);
            const linked = await readLinkedIdentity(ctx, await readUserSignal(ctx, target.index));
            if (!linked) {
              results.push({ from: "(off)", to: refLabel(target), result: { status: "SKIPPED", ok: true, dryRun: Boolean(dryRun), audible: false, results: [] }, warning: "not linked" });
              continue;
            }
            identity = linked.identity;
            fromLabel = linked.label;
          }
          if (!identity) continue;
          const assignments: Record<string, number | string> = {};
          if (wanted.has("name")) assignments.name = identity.name;
          if (wanted.has("col")) assignments.col = identity.col;
          if (wanted.has("icon")) assignments.icon = identity.icon;
          if (wanted.has("mode")) {
            if (!identity.mode || !(target.kind === "source" || target.kind === "usr")) {
              throw new WingValueError("mode can only be copied between sources and user signals.");
            }
            assignments.mode = identity.mode;
          }
          let warning: string | undefined;
          if (target.kind === "ch" || target.kind === "aux") {
            const linked = await ctx.client.get(stripPath(target.kind, target.index, "clink")).catch(() => null);
            if (linked && linked.kind === "leaf" && Number(linked.value) === 1) {
              warning = `${refLabel(target)} is linked to its source (clink=1): its own name was written but the surface keeps showing the source's.`;
            }
          }
          results.push({ from: fromLabel, to: refLabel(target), result: await writeAssignments(ctx, refBase(target), assignments, { dryRun, confirm }), warning });
        }
        const ok = results.every((r) => r.result.ok);
        const text = results
          .map((r) => `${r.from} -> ${r.to}: ${r.result.status === "SKIPPED" ? `skipped (${r.warning})` : describeWriteResult(r.result)}${r.warning && r.result.status !== "SKIPPED" ? `\n  ⚠ ${r.warning}` : ""}`)
          .join("\n");
        return { content: [textResult(text)], structuredContent: { ok, copies: results }, isError: ok ? undefined : true };
      }),
  );

  server.registerTool(
    "wing_clear_identity",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Wing: Clear name/color/icon",
      description:
        "Resets an element's name to empty, color to 1 (Blue) and icon to 0 (none) — the console's defaults. " +
        "Cosmetic, verified and journaled (wing_undo). Same refs as wing_copy_identity.",
      inputSchema: { ref: z.union([refSchema, z.array(refSchema).min(1).max(64)]), dryRun: z.boolean().optional() },
    },
    ({ ref, dryRun }) =>
      wrapWingTool(async () => {
        const refs = Array.isArray(ref) ? ref : [ref];
        const results: WingWriteResult[] = [];
        for (const r of refs) results.push(await writeAssignments(ctx, refBase(r), { name: "", col: 1, icon: 0 }, { dryRun }));
        const ok = results.every((r) => r.ok);
        return {
          content: [textResult(results.map((r, i) => `${refLabel(refs[i] as Ref)}: ${describeWriteResult(r)}`).join("\n"))],
          structuredContent: { ok, results },
          isError: ok ? undefined : true,
        };
      }),
  );

  server.registerTool(
    "wing_icon_search",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Wing: Search icons",
      description:
        "Finds console icons by word, in French or English (\"femme\", \"batterie\", \"guitare\", \"retour\", " +
        "\"piano\"), best match first. The setters that take `icon` also accept such a word directly.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() },
    },
    ({ query, limit }) =>
      wrapWingTool(async () => {
        const matches = searchIcons(query, limit ?? 10);
        const text = matches.length ? matches.map((m) => `  ${m.id}: ${m.name} (${m.category})`).join("\n") : `No icon matches "${query}".`;
        return { content: [textResult(text)], structuredContent: { matches } };
      }),
  );

  server.registerTool(
    "wing_get_box_map",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Wing: Get stage-box map",
      description: "Returns the saved description of which stage box is plugged into which AES50/StageConnect port range.",
    },
    () =>
      wrapWingTool(async () => {
        const boxMap = ctx.getConfig().boxMap ?? {};
        const text = Object.keys(boxMap).length
          ? Object.entries(boxMap)
              .map(([g, boxes]) => `${g}: ${boxes.map((b) => `${b.range[0]}-${b.range[1]} ${b.device}${b.model ? ` (${b.model})` : ""}`).join(", ")}`)
              .join("\n")
          : "No box map configured.";
        return { content: [textResult(text)], structuredContent: { boxMap } };
      }),
  );

  server.registerTool(
    "wing_set_box_map",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Wing: Set stage-box map",
      description:
        "Saves (server-side, persisted) which stage box sits on which port range, so patch listings and exports " +
        "can say \"AES50-A 11 = DL8-2 port 3\". Keys are I/O groups (\"A\"/\"AES50-A\", \"B\", \"C\", \"SC\", ...); " +
        "each box is {range: [first, last], device, model?, localPorts?: [first, last]}. Replaces the whole map. " +
        "Does not touch the console.",
      inputSchema: { boxMap: WingBoxMapSchema },
    },
    ({ boxMap }) =>
      wrapWingTool(async () => {
        const normalized: WingBoxMap = {};
        for (const [key, boxes] of Object.entries(boxMap)) {
          const group = key.replace(/^AES50-/i, "").toUpperCase();
          for (const box of boxes) {
            if (box.range[0] > box.range[1]) throw new WingValueError(`${key} ${box.device}: range start is after its end.`);
          }
          normalized[group] = boxes;
        }
        const config = await ctx.updateConfig({ boxMap: normalized });
        return { content: [textResult(`Saved box map for ${Object.keys(normalized).join(", ") || "(none)"}.`)], structuredContent: { boxMap: config.boxMap } };
      }),
  );

  server.registerTool(
    "wing_patch_export",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Wing: Export the full patch",
      description:
        "Exports inputs (channel/aux sources), outputs, user signals and the sources they use — with names, " +
        "modes and stereo pairs — in one call, as JSON or CSV (one CSV section per table). Each port carries " +
        "`device`/`devicePort` from the box map (saved with wing_set_box_map, or passed as `boxes` for this call " +
        "only). Outputs default to every group; unpatched outputs and unused user signals are left out unless " +
        "`includeUnused`. Takes a few seconds: it reads several hundred nodes.",
      inputSchema: {
        format: z.enum(["json", "csv"]).optional(),
        boxes: WingBoxMapSchema.optional(),
        outputGroups: z.array(z.string()).optional().describe("Default: every output group on the console."),
        includeUnused: z.boolean().optional(),
      },
    },
    ({ format, boxes, outputGroups, includeUnused }) =>
      wrapWingTool(async () => {
        const exportCtx: WingPluginContext = boxes
          ? { ...ctx, getConfig: () => ({ ...ctx.getConfig(), boxMap: { ...ctx.getConfig().boxMap, ...boxes } }) }
          : ctx;
        const inputs = (await readInputPatch(exportCtx, "all")).filter((r) => includeUnused || r.source || r.effectiveName);
        const groups: string[] =
          outputGroups ?? (await ctx.client.get("/io/out").then((r) => (r.kind === "branch" ? r.children : [])));
        const outputs: OutputPatchRow[] = [];
        for (const g of groups) {
          if ((await ioGroupCount(ctx, "out", g).catch(() => 0)) === 0) continue;
          outputs.push(...(await readOutputPatch(exportCtx, g)).filter((r) => includeUnused || r.signal.kind !== "off"));
        }
        const userSignals = (await listUserSignals(ctx)).filter((u) => includeUnused || u.link.kind !== "off" || u.name);
        const sourceGroups = new Set<string>();
        for (const r of inputs) if (r.source && !("tap" in r.source)) sourceGroups.add(r.source.group);
        for (const o of outputs) if (o.signal.kind === "source" && isSourceGroup(o.signal.group)) sourceGroups.add(o.signal.group);
        for (const u of userSignals) if (u.link.kind === "source" && u.link.group) sourceGroups.add(u.link.group);
        const sources: SourceListEntry[] = [];
        for (const g of sourceGroups) {
          sources.push(...(await listSources(exportCtx, g)).filter((s) => includeUnused || s.name || s.phantom48v));
        }

        if (format === "csv") {
          const inputRows = inputs.map((r) => {
            const s = r.source;
            const tap = s && "tap" in s ? s : null;
            const src = s && !("tap" in s) ? s : null;
            return {
              strip: `${r.strip}${r.index}`,
              name: r.effectiveName,
              source: s ? s.label : "OFF",
              stereo: src?.stereo ? "ST" : "",
              sourceName: src?.sourceName ?? tap?.tapName ?? "",
              phantom48v: src?.phantom48v ? "48V" : "",
              device: src?.box?.device ?? "",
              devicePort: src?.box?.devicePort ?? "",
              nameLinked: r.nameLinkedToSource ? "yes" : "",
            };
          });
          const outputRows = outputs.map((o) => ({
            port: `${o.group} ${o.port}`,
            device: o.box?.device ?? "",
            devicePort: o.box?.devicePort ?? "",
            signal: describeOutputSignal(o.signal),
          }));
          const usrRows = userSignals.map((u) => ({
            usr: u.index,
            name: u.name,
            mode: u.mode,
            link: u.link.kind === "off" ? "OFF" : u.link.label,
            tap: u.link.tap ?? "",
            lr: u.link.lr ?? "",
            target: u.link.targetName ?? "",
          }));
          const sourceRows = sources.map((s) => ({
            source: `${s.group}${s.index}`,
            name: s.name,
            mode: s.mode ?? "",
            phantom48v: s.phantom48v ? "48V" : "",
            gain: s.gain ?? "",
            device: s.box?.device ?? "",
            devicePort: s.box?.devicePort ?? "",
          }));
          const text = [
            "# Inputs", csv(inputRows), "", "# Outputs", csv(outputRows), "", "# User signals", csv(usrRows), "", "# Sources", csv(sourceRows),
          ].join("\n");
          return { content: [textResult(text)], structuredContent: { format: "csv", csv: text } };
        }
        const data = { inputs, outputs, userSignals, sources, boxMap: exportCtx.getConfig().boxMap };
        return {
          content: [
            textResult(
              `Patch export: ${inputs.length} inputs, ${outputs.length} outputs, ${userSignals.length} user signals, ` +
                `${sources.length} sources.\n${JSON.stringify(data)}`,
            ),
          ],
          structuredContent: data,
        };
      }),
  );
}
