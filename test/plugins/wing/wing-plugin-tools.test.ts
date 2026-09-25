import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect } from "chai";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { registerWingTools } from "../../../src/plugins/wing/tools/index.js";
import type { WingMeterClient } from "../../../src/plugins/wing/wing-meter-client.js";
import type {
  WingBranchResult,
  WingBulkSetResult,
  WingGetResult,
  WingNodeDescription,
  WingOscClient,
} from "../../../src/plugins/wing/wing-osc-client.js";
import { WingOscMirror } from "../../../src/plugins/wing/wing-osc-mirror.js";
import { WingMicCalibrationStore } from "../../../src/plugins/wing/wing-mic-calibration-store.js";
import { WingPresetStore } from "../../../src/plugins/wing/wing-preset-store.js";
import { WingStateCache } from "../../../src/plugins/wing/wing-state-cache.js";
import { WingWriteJournal } from "../../../src/plugins/wing/wing-write-journal.js";
import type { RtaSnapshot, WingPluginContext } from "../../../src/plugins/wing/wing-plugin.js";

type CallToolTextContent = { type: string; text: string };

/**
 * Canned GET replies for the paths exercised by this test. Keyed by the
 * exact OSC path a tool would request.
 */
const GET_FIXTURES: Record<string, WingGetResult> = {
  "/ch/1/fdr": { path: "/ch/1/fdr", kind: "leaf", valueKind: "float", display: "-6.0", raw: 0.53, value: -6 },
  // Value memory (wing_store_value/wing_adjust_value_by_delta / wing-value-memory.ts) — dedicated
  // channels so tests don't collide with the module-level (process-lifetime) memory map other
  // value-memory tests exercise via the same path.
  "/ch/2/fdr": { path: "/ch/2/fdr", kind: "leaf", valueKind: "float", display: "0.0", raw: 0.7, value: 0 },
  "/ch/3/fdr": { path: "/ch/3/fdr", kind: "leaf", valueKind: "float", display: "-6.0", raw: 0.53, value: -6 },
  "/ch/8/fdr": { path: "/ch/8/fdr", kind: "leaf", valueKind: "float", display: "-6.0", raw: 0.53, value: -6 },
  "/ch/9/fdr": { path: "/ch/9/fdr", kind: "leaf", valueKind: "float", display: "-6.0", raw: 0.53, value: -6 },
  // Dedicated to the MAX-clamp branch of wing_adjust_value_by_delta (channel 2 above already covers MIN).
  "/ch/10/fdr": { path: "/ch/10/fdr", kind: "leaf", valueKind: "float", display: "5.0", raw: 0.9, value: 5 },
  "/ch/1/mute": { path: "/ch/1/mute", kind: "leaf", valueKind: "int", display: "0", raw: 0, value: 0 },
  "/dca/1/fdr": { path: "/dca/1/fdr", kind: "leaf", valueKind: "float", display: "0.0", raw: 0.72, value: 0 },
  // wing_list_names/wing_channel_get_summary read the "$name" shadow (the effective display name,
  // which mirrors a linked source's name when one is connected) rather than the plain "name" leaf.
  "/ch/1/$name": { path: "/ch/1/$name", kind: "leaf", valueKind: "string", value: "Kick" },
  "/dca/2/name": { path: "/dca/2/name", kind: "leaf", valueKind: "string", value: "Band" },
  // Channel 5 simulates a source-linked input (clink=1, connected to physical input A/3) —
  // used to exercise wing_channel_set_name's rename-the-source redirect. `in/conn/in`'s `value` is
  // deliberately 2, one below its `display` of "3" — verified live against real hardware that this
  // field's wire "int" arg is 0-indexed while `display` (and the /io/in/{group}/{n} addressing
  // convention) is 1-indexed; resolvePhysicalSource() must read `display`, not `value`.
  "/ch/5/clink": { path: "/ch/5/clink", kind: "leaf", valueKind: "int", value: 1 },
  "/ch/5/in/conn/grp": { path: "/ch/5/in/conn/grp", kind: "leaf", valueKind: "string", value: "A" },
  "/ch/5/in/conn/in": { path: "/ch/5/in/conn/in", kind: "leaf", valueKind: "int", display: "3", raw: 0.032, value: 3 },
  "/cfg/rta/rtasrc": { path: "/cfg/rta/rtasrc", kind: "leaf", valueKind: "int", value: 7 },
  "/cfg/rta/rtatap": { path: "/cfg/rta/rtatap", kind: "leaf", valueKind: "string", value: "PREEQ" },
  // Talkback source on/off (wing_get_talkback / wing-talkback.ts) — "$on" is GET-only, never in dump().
  "/cfg/talk/A/$on": { path: "/cfg/talk/A/$on", kind: "leaf", valueKind: "int", value: 1 },
  "/cfg/talk/B/$on": { path: "/cfg/talk/B/$on", kind: "leaf", valueKind: "int", value: 0 },
  // GPIO electrical state (wing_get_gpio / wing-gpio.ts) — "$state" is GET-only, never in dump().
  "/$ctl/gpio/1/$state": { path: "/$ctl/gpio/1/$state", kind: "leaf", valueKind: "int", value: 1 },
  "/$ctl/gpio/2/$state": { path: "/$ctl/gpio/2/$state", kind: "leaf", valueKind: "int", value: 0 },
  // USB player/recorder module fixtures (wing_usb_player_status / wing-usb-player.ts) — the "$"
  // fields are verified against real hardware to be GET-only, never included in a dump().
  "/$stat/usbstate": { path: "/$stat/usbstate", kind: "leaf", valueKind: "string", value: "ATTACHED" },
  "/$stat/usbvolname": { path: "/$stat/usbvolname", kind: "leaf", valueKind: "string", value: "USBDRIVE" },
  "/play/$actstate": { path: "/play/$actstate", kind: "leaf", valueKind: "string", value: "PLAY" },
  "/play/$actidx": { path: "/play/$actidx", kind: "leaf", valueKind: "int", value: 1 },
  "/play/$actfile": { path: "/play/$actfile", kind: "leaf", valueKind: "string", value: "Song1.wav" },
  "/play/$song": { path: "/play/$song", kind: "leaf", valueKind: "string", value: "Song1" },
  "/play/$album": { path: "/play/$album", kind: "leaf", valueKind: "string", value: "Album1" },
  "/play/$artist": { path: "/play/$artist", kind: "leaf", valueKind: "string", value: "Artist1" },
  "/play/$pos": { path: "/play/$pos", kind: "leaf", valueKind: "float", display: "0:30", value: 30 },
  "/play/$total": { path: "/play/$total", kind: "leaf", valueKind: "float", display: "3:00", value: 180 },
  "/play/$resolution": { path: "/play/$resolution", kind: "leaf", valueKind: "string", value: "16bit" },
  "/play/$channels": { path: "/play/$channels", kind: "leaf", valueKind: "string", value: "2" },
  "/play/$rate": { path: "/play/$rate", kind: "leaf", valueKind: "string", value: "44100" },
  "/play/$format": { path: "/play/$format", kind: "leaf", valueKind: "string", value: "WAV" },
  "/rec/$actstate": { path: "/rec/$actstate", kind: "leaf", valueKind: "string", value: "STOP" },
  "/rec/$actfile": { path: "/rec/$actfile", kind: "leaf", valueKind: "string", value: "" },
  "/rec/$path": { path: "/rec/$path", kind: "leaf", valueKind: "string", value: "" },
  "/rec/$time": { path: "/rec/$time", kind: "leaf", valueKind: "float", display: "0:00", value: 0 },
  // Insert status fields (wing_get_insert / wing-insert.ts) — the "$stat" leaf is verified (same
  // convention as the USB module's "$"-prefixed fields above) to be GET-only, never in dump().
  "/ch/1/preins/$stat": { path: "/ch/1/preins/$stat", kind: "leaf", valueKind: "string", value: "OK" },
  "/ch/1/postins/$stat": { path: "/ch/1/postins/$stat", kind: "leaf", valueKind: "string", value: "OK" },
  // EQ/Gate/Dyn on-off (wing_get_processing_block / wing-processing-toggle.ts).
  "/ch/1/eq/on": { path: "/ch/1/eq/on", kind: "leaf", valueKind: "int", value: 1 },
  "/ch/1/gate/on": { path: "/ch/1/gate/on", kind: "leaf", valueKind: "int", value: 0 },
  "/ch/1/dyn/on": { path: "/ch/1/dyn/on", kind: "leaf", valueKind: "int", value: 1 },
  // Processing order (wing_channel_get_proc / wing-proc-order.ts) — one of the 24 G/E/D/I permutations.
  "/ch/1/proc": { path: "/ch/1/proc", kind: "leaf", valueKind: "string", value: "GEDI" },
  // Input patch (wing_get_input_patch / wing-input-patch.ts) — Main (grp/in) + Alt (altgrp/altin),
  // both exercising the same display-vs-value off-by-one as channel 5's clink fixture above.
  "/ch/1/in/conn/grp": { path: "/ch/1/in/conn/grp", kind: "leaf", valueKind: "string", value: "A" },
  "/ch/1/in/conn/in": { path: "/ch/1/in/conn/in", kind: "leaf", valueKind: "int", display: "3", value: 3 },
  "/ch/1/in/conn/altgrp": { path: "/ch/1/in/conn/altgrp", kind: "leaf", valueKind: "string", value: "B" },
  "/ch/1/in/conn/altin": { path: "/ch/1/in/conn/altin", kind: "leaf", valueKind: "int", display: "5", value: 5 },
  "/ch/1/in/set/altsrc": { path: "/ch/1/in/set/altsrc", kind: "leaf", valueKind: "int", value: 0 },
  "/ch/1/clink": { path: "/ch/1/clink", kind: "leaf", valueKind: "int", value: 0 },
  // Global Alt switch (wing_get_global_alt_switch / wing-input-patch.ts).
  "/io/altsw": { path: "/io/altsw", kind: "leaf", valueKind: "int", value: 0 },
  "/io/autoaltovr": { path: "/io/autoaltovr", kind: "leaf", valueKind: "int", value: 1 },
  // Autosave switch (wing_get_autosave_config / wing-console-admin.ts) — 0 means autosave is on.
  "/$ctl/$globals/$noautosave": { path: "/$ctl/$globals/$noautosave", kind: "leaf", valueKind: "int", value: 0 },
  // WING Live card (wing_get_wlive_status / wing-live.ts) — simulates a card installed, with slot 1
  // reachable (a session loaded) and slot 2 unreachable (no SD card, see the dump() branches below).
  "/cards/$type": { path: "/cards/$type", kind: "leaf", valueKind: "string", value: "WLIVE" },
  "/cards/wlive/$actlink": { path: "/cards/wlive/$actlink", kind: "leaf", valueKind: "string", value: "IND" },
  "/cards/wlive/$battstate": { path: "/cards/wlive/$battstate", kind: "leaf", valueKind: "string", value: "GOOD" },
  // Selected strip (wing_get_selected_strip / wing-selected-strip.ts) — raw GET value 6 decodes
  // (after the documented +1 GET/SET off-by-one) to canonical index 7, which is "channel 7" per
  // the same 1..76 numbering RTA source uses (channels occupy 1..40).
  "/$ctl/$stat/selidx": { path: "/$ctl/$stat/selidx", kind: "leaf", valueKind: "int", value: 6 },
  // Delay line (wing_get_delay / wing-delay.ts) — channel/aux use the `in/set/dly*` shape, bus/
  // main/matrix use the separate `dly/*` node (two different shapes, see wing-delay.ts).
  "/ch/1/in/set/dlyon": { path: "/ch/1/in/set/dlyon", kind: "leaf", valueKind: "int", value: 1 },
  "/ch/1/in/set/dlymode": { path: "/ch/1/in/set/dlymode", kind: "leaf", valueKind: "string", value: "MS" },
  "/ch/1/in/set/dly": { path: "/ch/1/in/set/dly", kind: "leaf", valueKind: "float", value: 12.5 },
  "/bus/1/dly/on": { path: "/bus/1/dly/on", kind: "leaf", valueKind: "int", value: 0 },
  "/bus/1/dly/mode": { path: "/bus/1/dly/mode", kind: "leaf", valueKind: "string", value: "M" },
  "/bus/1/dly/dly": { path: "/bus/1/dly/dly", kind: "leaf", valueKind: "float", value: 3 },
  // Scribble strip identity (wing_get_scribble / wing-scribble.ts) — led/col/icon are three separate
  // leaf reads (Promise.all), not a dump(). `col`'s `value` is deliberately one below `display`,
  // same 0-indexed-wire-vs-1-indexed-display quirk as /ch/5/in/conn/in above — getScribble must
  // read `display`, not `value`.
  "/ch/1/led": { path: "/ch/1/led", kind: "leaf", valueKind: "int", value: 1 },
  "/ch/1/col": { path: "/ch/1/col", kind: "leaf", valueKind: "int", display: "4", raw: 0.176, value: 4 },
  "/ch/1/icon": { path: "/ch/1/icon", kind: "leaf", valueKind: "int", value: 101 },
  // Physical input source identity + preamp (wing_get_source / wing-source.ts) — B/2 has its own
  // fixtures so it doesn't collide with the /io/in/A/3 gain the auto_gain tests rely on. `col`'s
  // `value` is deliberately one below `display`, same 0-indexed-wire quirk as /ch/1/col — getSourceProps
  // must read `display`.
  "/io/in/B/2/name": { path: "/io/in/B/2/name", kind: "leaf", valueKind: "string", value: "Guitar" },
  "/io/in/B/2/col": { path: "/io/in/B/2/col", kind: "leaf", valueKind: "int", display: "5", raw: 0.23, value: 5 },
  "/io/in/B/2/icon": { path: "/io/in/B/2/icon", kind: "leaf", valueKind: "int", value: 300 },
  "/io/in/B/2/g": { path: "/io/in/B/2/g", kind: "leaf", valueKind: "float", display: "12.0", value: 12 },
  "/io/in/B/2/vph": { path: "/io/in/B/2/vph", kind: "leaf", valueKind: "int", value: 1 },
  "/io/in/B/2/pol": { path: "/io/in/B/2/pol", kind: "leaf", valueKind: "int", value: 0 },
  "/io/in/B/2/mute": { path: "/io/in/B/2/mute", kind: "leaf", valueKind: "int", value: 0 },
  // Strip solo (wing_get_strip_solo / wing-solo-monitor.ts) — channel 1 is soloed with solo-safe off
  // and presolo idle (channel is the only type that exposes presolo); DCA 1 is not soloed and has no
  // solo-safe/presolo field at all, exercising getStripSolo's per-type field omission.
  "/ch/1/$solo": { path: "/ch/1/$solo", kind: "leaf", valueKind: "int", value: 1 },
  "/ch/1/$sololed": { path: "/ch/1/$sololed", kind: "leaf", valueKind: "int", value: 2 },
  "/ch/1/solosafe": { path: "/ch/1/solosafe", kind: "leaf", valueKind: "int", value: 0 },
  "/ch/1/$presolo": { path: "/ch/1/$presolo", kind: "leaf", valueKind: "int", value: 0 },
  "/dca/1/$solo": { path: "/dca/1/$solo", kind: "leaf", valueKind: "int", value: 0 },
  "/dca/1/$sololed": { path: "/dca/1/$sololed", kind: "leaf", valueKind: "int", value: 0 },
  // Global solo config's/monitor buses' "$"-prefixed fields (wing_get_solo_config, wing_get_monitor_bus
  // / wing-solo-monitor.ts) — read individually via get(), never via dump() (see the dump() branches
  // below for why).
  "/cfg/solo/$dim": { path: "/cfg/solo/$dim", kind: "leaf", valueKind: "int", value: 1 },
  "/cfg/solo/$mono": { path: "/cfg/solo/$mono", kind: "leaf", valueKind: "int", value: 0 },
  "/cfg/solo/$flip": { path: "/cfg/solo/$flip", kind: "leaf", valueKind: "int", value: 0 },
  "/cfg/solo/$srcsolo": { path: "/cfg/solo/$srcsolo", kind: "leaf", valueKind: "int", value: 0 },
  "/cfg/solo/$srcsgrp": { path: "/cfg/solo/$srcsgrp", kind: "leaf", valueKind: "int", value: 1 },
  "/cfg/solo/$srcsin": { path: "/cfg/solo/$srcsin", kind: "leaf", valueKind: "int", value: 1 },
  "/cfg/mon/1/$lvl": { path: "/cfg/mon/1/$lvl", kind: "leaf", valueKind: "float", value: -10 },
  "/cfg/mon/1/$lvlact": { path: "/cfg/mon/1/$lvlact", kind: "leaf", valueKind: "float", value: -10 },
  "/cfg/mon/2/$lvlact": { path: "/cfg/mon/2/$lvlact", kind: "leaf", valueKind: "float", value: -144 },
};

interface FakeClientHandle {
  client: WingOscClient;
  bulkSetCalls: { baseNode: string; assignments: Record<string, number | string> }[];
  toggleCalls: string[];
  setCalls: { path: string; value: number | string }[];
}

/**
 * A lightweight in-file fake implementing just the `WingOscClient` methods
 * the tools call (get/dump/describe/bulkSet/toggle). Deliberately does not
 * depend on the real `WingOscClient` or `WingMockServer` — this test only
 * needs to prove the MCP tool surface behaves correctly given canned
 * protocol-shaped responses, independent of the other agent's client
 * implementation. Cast through `unknown` since `WingOscClient` is a
 * concrete class with private members that a plain object can't
 * structurally satisfy.
 */
function createFakeWingClient(): FakeClientHandle {
  const bulkSetCalls: { baseNode: string; assignments: Record<string, number | string> }[] = [];
  const toggleCalls: string[] = [];
  const setCalls: { path: string; value: number | string }[] = [];

  const fakeClient = {
    async get(path: string): Promise<WingGetResult | WingBranchResult> {
      // "/tags" is the one leaf this fake makes stateful: wing_set_group_membership reads it back
      // after a set() to verify the console applied the change, so it needs to see its own write.
      if (path.endsWith("/tags")) {
        const lastSet = [...setCalls].reverse().find((call) => call.path === path);
        return { path, kind: "leaf", valueKind: "string", value: lastSet ? String(lastSet.value) : "" };
      }
      // Like the real console, a leaf reads back whatever the last bulk-set wrote to it — the
      // generic write tools verify every write by reading it back.
      for (const call of [...bulkSetCalls].reverse()) {
        for (const [key, value] of Object.entries(call.assignments)) {
          if (`${call.baseNode}/${key.replace(/\./g, "/")}` === path) {
            return { path, kind: "leaf", valueKind: typeof value === "number" ? "float" : "string", value };
          }
        }
      }
      return GET_FIXTURES[path] ?? { path, kind: "branch", children: ["fdr", "mute", "name"] };
    },
    async set(path: string, value: number | string): Promise<void> {
      setCalls.push({ path, value });
    },
    async dump(path: string): Promise<Record<string, string | number>> {
      // Channel 20's gate slot simulates a real Dynamic EQ plugin (mdl "DEQ2", confirmed live against
      // real hardware on channel 3) — used to exercise the bidirectional (boost-or-cut) handling that
      // every other verified gate/dyn model (STD/COMP/... below) doesn't need.
      if (path === "/ch/20/gate") {
        return { on: 1, mdl: "DEQ2", thr: -40, range: -60, att: 1, hld: 10, rel: 100, ratio: 4, mix: 100, gain: 0 };
      }
      // Channel 21's gate slot simulates the "GATE" model specifically — the one documented exception
      // (WING_Remote-Protocols-3.1-03.pdf p.98: "Standard Wing gate is 60 dB" full-scale range, vs the
      // 20dB default every other model uses) that wing-dynamics-models.ts's gainReductionScaleCorrection
      // must apply a 3x (60/20) correction for, on top of whatever the meter protocol itself parsed.
      if (path === "/ch/21/gate") {
        return { on: 1, mdl: "GATE", thr: 0, range: 60, att: 10, hld: 10, rel: 200, acc: 0, ratio: "gate", mix: 100, gain: 0 };
      }
      if (path.endsWith("/gate")) {
        return { on: 1, mdl: "STD", thr: -40, range: -60, att: 1, hld: 10, rel: 100, ratio: 4, mix: 100, gain: 0 };
      }
      // Channel 22's dyn slot simulates the real "76LA" model — verified live to have NO "thr" field
      // at all (it uses "in"/"out" gain-staging instead), exercising the model-aware validation that
      // rejects thresholdDb/ratio for a model that doesn't expose that control, instead of blindly
      // sending "thr" and getting back a cryptic console rejection.
      if (path === "/ch/22/dyn") {
        return { on: 1, mdl: "76LA", mix: 100, gain: 0, in: -26.5, out: -27, att: 2, rel: 2, ratio: 8 };
      }
      // Channel 28's dyn slot simulates the real "ECL33" (Even Comp/Limiter) — NO plain "thr"; it has
      // a SPLIT threshold, "cthr" (compressor) + "lthr" (limiter). auto_compress drives "cthr" and
      // treats it exactly like a plain dB threshold (polarity +1).
      if (path === "/ch/28/dyn") {
        return { on: 1, mdl: "ECL33", mix: 100, gain: 0, cthr: -20, lthr: -3, ratio: 4, att: 20, rel: 150 };
      }
      // Channel 29's dyn slot simulates the real "NSTR" (No Stressor / Distressor) — NO threshold of
      // any kind; compression is driven by its UNITLESS "in" drive knob (describe()'d 0..10, no unit),
      // exercising the describe-unit-based step scaling (a dB of error must NOT move a 0..10 knob 1:1).
      if (path === "/ch/29/dyn") {
        return { on: 1, mdl: "NSTR", mix: 100, gain: 0, in: 3, out: 5, ratio: "NUKE" };
      }
      // Channel 30's dyn slot simulates the real "LA" (Teletronix LA-2A "LA Leveler") — driven by a
      // unitless "ingain" knob (0..100) and, uniquely, has NO "gain" (makeup) field at all, so
      // auto_compress reports makeupGain.applied=false and writes nothing there.
      if (path === "/ch/30/dyn") {
        return { on: 1, mdl: "LA", mix: 100, ingain: 20, peak: 50, mode: "comp" };
      }
      // Channel 31's dyn slot simulates "DEQ2" (Dual Dynamic EQ) — NO plain "thr"; per-band "1-thr"
      // /"2-thr" (dB). auto_compress drives band 1's "1-thr"; DEQ2 has no broadband "gain" field
      // (only per-band "1-g"/"2-g"), so makeupGain.applied=false.
      if (path === "/ch/31/dyn") {
        return { on: 1, mdl: "DEQ2", "1-thr": -30, "2-thr": 0, "1-g": -6, "2-g": 0, "1-ratio": 3, "1-f": 1000 };
      }
      // Channel 32's dyn slot simulates "ONEC" (One Knob Compressor) — no threshold; a unitless
      // "gr" ("gain reduction") amount knob 0..10. Has the standard makeup "gain".
      if (path === "/ch/32/dyn") {
        return { on: 1, mdl: "ONEC", mix: 100, gain: 0, gr: 2, dag: 1 };
      }
      // Channel 33's dyn slot simulates "LMT" (LMT Compressor) — no threshold; a unitless "comp"
      // amount knob 0..100. Has the standard makeup "gain".
      if (path === "/ch/33/dyn") {
        return { on: 1, mdl: "LMT", mix: 100, gain: 0, comp: 20, con: 1, trans: 0 };
      }
      if (path.endsWith("/dyn")) {
        return { on: 1, mdl: "COMP", thr: -20, ratio: "4:1", knee: 2, det: "RMS", att: 5, hld: 0, rel: 150, mix: 100, gain: 2 };
      }
      // USB player/recorder — dump() only returns the writable config (repeat/resolution/channels),
      // never the "$"-prefixed live status fields (those are GET-only, see GET_FIXTURES above).
      if (path === "/play") {
        return { repeat: 0 };
      }
      if (path === "/rec") {
        return { resolution: "16bit", channels: "2" };
      }
      // Insert fixtures (wing_get_insert/wing_set_insert) — pre-insert has no mode/w fields, post
      // has both (see wing-insert.ts). Any strip's postins fixture below is used interchangeably by
      // the channel/bus/main/matrix tests, since the shape doesn't vary by strip type.
      if (path.endsWith("/preins")) {
        return { on: 1, ins: "FX2" };
      }
      if (path.endsWith("/postins")) {
        return { on: 0, ins: "NONE", mode: "FX", w: 0 };
      }
      // AES50/StageConnect link status (wing_get_link_status / wing-link-status.ts), shaped like a
      // real live dump() of "/$stat" (verified live, see wing-link-status.ts's doc comment) — port A
      // simulates a healthy link, B simulates nothing connected ("-", the documented idle state), C
      // simulates an active error condition, exercising all three states in one fixture.
      if (path === "/$stat") {
        return {
          "A.stat": "OK",
          "A.dev": "WING-A1",
          "A.errorsc": 3,
          "A.errorsu": 0,
          "B.stat": "-",
          "B.dev": "",
          "B.errorsc": 0,
          "B.errorsu": 0,
          "C.stat": "ERR",
          "C.dev": "WING-C1",
          "C.errorsc": 12,
          "C.errorsu": 2,
          sc_stat: "OK",
          sc_devices: "SC-1",
          sc_upcnt: 1,
          sc_dncnt: 2,
          rmt_a: "FOH1",
          rmt_b: "",
          rmt_c: "MON1",
        };
      }
      // WING Live card (wing_get_wlive_status / wing-live.ts) — slot 1 simulates a loaded session,
      // slot 2 throws to simulate an unreachable slot (no SD card physically inserted).
      if (path === "/cards/wlive") {
        return { sdlink: "PAR", autoin: "1", meters: 1, auto_stop: "KEEP", auto_play: "MAIN", auto_rec: "ALT" };
      }
      if (path === "/cards/wlive/1/$stat") {
        return {
          state: "PLAY",
          etime: 12345,
          sdfree: 36000000,
          sdsize: 128,
          sdstate: "READY",
          sessions: 3,
          markers: 2,
          sessionlen: 600000,
          sessionpos: 5,
          markerpos: 1,
          tracks: "32",
          rate: "48",
          linkedpos: 0,
          start: 1000,
          stop: 599000,
          errormessage: "",
          errorcode: 0,
        };
      }
      if (path === "/cards/wlive/1/cfg") {
        return { rectracks: "32", playmode: "PLAY" };
      }
      if (path === "/cards/wlive/2/$stat" || path === "/cards/wlive/2/cfg") {
        throw new Error("no SD card in slot 2");
      }
      // Matrix Direct Input (wing_get_matrix_direct_input / wing-matrix-direct.ts).
      if (path === "/mtx/1/dir") {
        return { on: 1, lvl: -6, inv: 0, in: "AES" };
      }
      // Talkback (wing_get_talkback / wing-talkback.ts) — source A is on/AUTO with bus 1 and main 1
      // assigned, source B is off/PUSH with nothing assigned (all destination fields default to 0
      // via asNumber's fallback, so B's dump omits them entirely here on purpose). Verified live
      // against real hardware that "{A,B}/$on" is silently omitted from a dump() reply (same class of
      // behavior as the solo config's "$"-prefixed fields below) — this fixture omits it too and the
      // real value is read individually via get() (see GET_FIXTURES below).
      if (path === "/cfg/talk") {
        return { assign: "CH40" };
      }
      if (path === "/cfg/talk/A") {
        return { mode: "AUTO", mondim: 20, busdim: 10, indiv: 0, B1: 1, M1: 1 };
      }
      if (path === "/cfg/talk/B") {
        return { mode: "PUSH", mondim: 40, busdim: 40, indiv: 1 };
      }
      // GPIO (wing_get_gpio / wing-gpio.ts) — GPIO 1 is an output currently closed, GPIO 2 is an
      // input toggle currently open; 3 and 4 fall back to the generic default below on purpose,
      // exercising getAllGpioStatus's per-index dump() fan-out. Verified live against real hardware
      // that "$state" is silently omitted from a dump() reply here too — omitted from this fixture and
      // read individually via get() (see GET_FIXTURES below).
      if (path === "/$ctl/gpio/1") {
        return { mode: "OUTNC", gpstate: 1 };
      }
      if (path === "/$ctl/gpio/2") {
        return { mode: "TGLNO", gpstate: 0 };
      }
      // Lighting (wing_get_lighting / wing-lighting.ts) — a distinct value per zone so a
      // mixed-up field order in getLightingStatus would fail the test.
      if (path === "/$ctl/cfg/lights") {
        return { btns: 80, leds: 60, meters: 100, rgbleds: 70, chlcds: 50, chlcdctr: 40, chedit: 65, main: 90, glow: 20, patch: 30, lamp: 10 };
      }
      // Global solo config (wing_get_solo_config / wing-solo-monitor.ts) — verified live against real
      // hardware that this node's six "$"-prefixed fields are silently omitted from a dump() reply
      // (same class of behavior as the USB player's "$"-prefixed status fields), so this fixture
      // deliberately omits them too; they're read individually via get() (see GET_FIXTURES below).
      if (path === "/cfg/solo") {
        return {
          mode: "LIVE",
          mon: "PH+SPK",
          mute: 0,
          chtap: "PFL",
          bustap: "AFL",
          maintap: "PFL",
          mtxtap: "PFL",
          srcsolo: "OFF",
        };
      }
      // Control-room monitor buses (wing_get_monitor_bus / wing-solo-monitor.ts) — bus 1 (Monitor A)
      // simulates an active, routed monitor with a dedicated physical level knob (level is `$lvl`,
      // read-only, omitted from dump() — read individually via get(), see GET_FIXTURES below); bus 2
      // (Monitor B) simulates the OTHER real shape confirmed live on this console: no physical knob,
      // so level is the plain, settable `lvl` (no `$`) and DOES show up here in dump() — getMonitorBus
      // must detect this from dump()'s own reply rather than assuming one shape for both buses.
      // "$lvlact" is always `$`-prefixed and always omitted from dump() on both buses.
      if (path === "/cfg/mon/1") {
        return {
          inv: 0,
          pan: 0,
          wid: 100,
          lim: -6,
          "dly.on": 1,
          "dly.m": 3.5,
          dim: 20,
          pfldim: 15,
          eqbdtrim: 6,
          srclvl: -3,
          srcmix: 0,
          src: "MAIN.1",
          dirin: "OFF",
          tags: "MonA",
        };
      }
      if (path === "/cfg/mon/2") {
        return {
          lvl: -144,
          inv: 1,
          pan: 0,
          wid: 100,
          lim: 0,
          "dly.on": 0,
          "dly.m": 0.1,
          dim: 0,
          pfldim: 0,
          eqbdtrim: 0,
          srclvl: -144,
          srcmix: -144,
          src: "OFF",
          dirin: "CH.5",
          tags: "",
        };
      }
      return { name: "Kick", fdr: -6, mute: 0, pan: 0 };
    },
    async describe(path: string, _includeValues?: boolean): Promise<WingNodeDescription> {
      // Describing the "/play" branch (not the "$songs" leaf directly, which never replies on real
      // hardware, same dead end as $scenes) is how the browsable track list is discovered.
      if (path === "/play") {
        const lines = ["$songs list [Song1, Song2, Song3]", "repeat int [0 .. 1]"];
        return { path, raw: lines.join("~"), lines };
      }
      if (path === "/ch/22/dyn") {
        const lines = [
          "on int [0 .. 1]",
          "in lin [-48.0 .. 0.0 dB], 97 steps",
          "out lin [-48.0 .. 0.0 dB], 97 steps",
          "gain lin [-6.0 .. 12.0 dB], 37 steps",
          "ratio list [4, 8, 12, 20, ALL]",
        ];
        return { path, raw: lines.join("~"), lines };
      }
      if (path === "/ch/28/dyn") {
        const lines = [
          "on int [0 .. 1]",
          "cthr lin [-35.0 .. -5.0 dB], 61 steps",
          "lthr lin [-12.0 .. 0.0 dB], 25 steps",
          "gain lin [-6.0 .. 12.0 dB], 37 steps",
          "ratio list [2, 3, 4, 6, 10]",
        ];
        return { path, raw: lines.join("~"), lines };
      }
      if (path === "/ch/29/dyn") {
        const lines = [
          "on int [0 .. 1]",
          "in lin [0.0 .. 10.0], 101 steps",
          "out lin [0.0 .. 10.0], 101 steps",
          "gain lin [-6.0 .. 12.0 dB], 37 steps",
          "ratio list [1, 2, 4, 6, 10, NUKE]",
        ];
        return { path, raw: lines.join("~"), lines };
      }
      if (path === "/ch/30/dyn") {
        const lines = [
          "on int [0 .. 1]",
          // Real LA-2A exposes BOTH "ingain" (make-up trim — inert as a compression control) and
          // "peak" (its single Peak Reduction knob). resolveCompressionControl must pick "peak".
          "ingain lin [0.0 .. 100.0], 101 steps",
          "peak lin [0.0 .. 100.0], 101 steps",
          "mix lin [0.0 .. 100.0 %], 101 steps",
        ];
        return { path, raw: lines.join("~"), lines };
      }
      if (path === "/ch/31/dyn") {
        const lines = [
          "on int [0 .. 1]",
          "1-thr lin [-60.0 .. 0.0 dB], 121 steps",
          "2-thr lin [-60.0 .. 0.0 dB], 121 steps",
          "1-g lin [-15.0 .. 15.0 dB], 301 steps",
          "2-g lin [-15.0 .. 15.0 dB], 301 steps",
          "1-f log [20.0 .. 20k00 Hz], 961 steps",
        ];
        return { path, raw: lines.join("~"), lines };
      }
      if (path === "/ch/32/dyn") {
        const lines = [
          "on int [0 .. 1]",
          "gr lin [0.0 .. 10.0], 101 steps",
          "gain lin [-6.0 .. 12.0 dB], 37 steps",
        ];
        return { path, raw: lines.join("~"), lines };
      }
      if (path === "/ch/33/dyn") {
        const lines = [
          "on int [0 .. 1]",
          "comp lin [0.0 .. 100.0], 101 steps",
          "gain lin [-6.0 .. 12.0 dB], 37 steps",
        ];
        return { path, raw: lines.join("~"), lines };
      }
      if (path.endsWith("/dyn")) {
        const lines = [
          "on int [0 .. 1]",
          "thr lin [-60.0 .. 0.0 dB], 601 steps",
          "gain lin [-20.0 .. +20.0 dB], 401 steps",
        ];
        return { path, raw: lines.join("~"), lines };
      }
      if (path.endsWith("/gate")) {
        const lines = [
          "on int [0 .. 1]",
          "thr lin [-80.0 .. 0.0 dB], 801 steps",
          "gain lin [-20.0 .. +20.0 dB], 401 steps",
        ];
        return { path, raw: lines.join("~"), lines };
      }
      // Value memory (wing_adjust_value_by_delta / wing-value-memory.ts) describes the leaf's PARENT
      // BLOCK (describe() on a bare leaf genuinely fails on real hardware), then picks the "fdr" line
      // out of several — multiple lines here on purpose, so a regression that reverts to matching
      // params[0] instead of filtering by key would fail this fixture too.
      if (path === "/ch/2" || path === "/ch/3" || path === "/ch/10") {
        const lines = [
          "mute int [0 .. 1]",
          "fdr lin [-144.0 .. 10.0 dB], 1541 steps",
          "pan lin [-100.0 .. 100.0], 201 steps",
        ];
        return { path, raw: lines.join("~"), lines };
      }
      const raw = "1?Show A/Scene 1~2?Show A/Scene 2";
      return { path, raw, lines: raw.split("~") };
    },
    async bulkSet(baseNode: string, assignments: Record<string, number | string>): Promise<WingBulkSetResult> {
      bulkSetCalls.push({ baseNode, assignments });
      // Simulates the plan's flagged open question: the bulk-set toggle
      // convention (mute=-1) is NOT acknowledged as OK by this console,
      // forcing wing_channel_toggle_mute through its documented fallback.
      if (assignments.mute === -1) {
        return { status: "VALUE ERROR", ok: false, raw: "VALUE ERROR" };
      }
      return { status: "OK", ok: true, raw: "OK" };
    },
    async toggle(path: string): Promise<void> {
      toggleCalls.push(path);
    },
  };

  return { client: fakeClient as unknown as WingOscClient, bulkSetCalls, toggleCalls, setCalls };
}

function createFakeContext(presetDir: string): {
  ctx: WingPluginContext;
  handle: FakeClientHandle;
  rta: { snapshot: RtaSnapshot | null };
  meterClient: EventEmitter;
  oscMirror: WingOscMirror;
} {
  const handle = createFakeWingClient();
  const rta: { snapshot: RtaSnapshot | null } = { snapshot: null };
  const meterClient = new EventEmitter();
  const oscMirror = new WingOscMirror();
  const ctx: WingPluginContext = {
    client: handle.client,
    meterClient: meterClient as unknown as WingMeterClient,
    cache: new WingStateCache(),
    eventBus: new EventBus(),
    getConfig: () => ({
      host: "127.0.0.1",
      oscPort: 2223,
      discoveryPort: 2222,
      meterTcpPort: 2222,
      meterUdpPort: 14135,
      warmCacheOnConnect: true,
      oscMirrorEnabled: false,
      oscMirrorHost: "",
      oscMirrorPort: 0,
      showMode: false,
      boxMap: {},
    }),
    buildOverviewSnapshot: async () => ({}),
    getLastRta: () => rta.snapshot,
    presetStore: new WingPresetStore({ dir: presetDir }),
    micCalibrationStore: new WingMicCalibrationStore({ dir: presetDir + "-mics" }),
    oscMirror,
    journal: new WingWriteJournal(),
    updateConfig: async () => {
      throw new Error("updateConfig is not wired in this test");
    },
  };
  return { ctx, handle, rta, meterClient, oscMirror };
}

describe("wing plugin MCP tools (end-to-end via a real McpServer/Client pair)", () => {
  let client: Client;
  let server: McpServer;
  let handle: FakeClientHandle;
  let rta: { snapshot: RtaSnapshot | null };
  let meterClient: EventEmitter;
  let oscMirror: WingOscMirror;
  let presetDir: string;

  beforeEach(async () => {
    presetDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "wing-mcp-test-presets-"));
    const created = createFakeContext(presetDir);
    handle = created.handle;
    rta = created.rta;
    meterClient = created.meterClient;
    oscMirror = created.oscMirror;

    server = new McpServer({ name: "wing-test-server", version: "0.0.0" });
    registerWingTools(server, created.ctx);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "wing-test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    fs.rmSync(presetDir, { recursive: true, force: true });
  });

  // Exact-set assertion (not include.members — a subset check would miss a real tool silently
  // disappearing as long as it wasn't one of the ones listed here) against every tool actually
  // registered by registerWingTools as of this test's writing (134). Adding a new tool is expected
  // to require updating this list — that's the point: a change here should be a deliberate, visible
  // part of the diff that added/removed the tool, not something that slips by unnoticed.
  it("lists the full wing tool surface (all 134 registered tools, not a subset)", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).to.have.members([
      "wing_adjust_value_by_delta",
      "wing_auto_compress",
      "wing_auto_eq_balance",
      "wing_auto_eq_undo",
      "wing_auto_gain",
      "wing_auto_gate",
      "wing_bulk_set",
      "wing_bus_get_fader",
      "wing_bus_get_mute",
      "wing_bus_get_summary",
      "wing_bus_set_fader",
      "wing_bus_set_mute",
      "wing_channel_get_fader",
      "wing_channel_get_mute",
      "wing_channel_get_proc",
      "wing_channel_get_summary",
      "wing_channel_set_fader",
      "wing_channel_set_mute",
      "wing_channel_set_name",
      "wing_channel_set_pan",
      "wing_channel_set_proc",
      "wing_channel_toggle_mute",
      "wing_clear_link_errors",
      "wing_dca_get_fader",
      "wing_dca_get_mute",
      "wing_dca_get_summary",
      "wing_dca_set_fader",
      "wing_dca_set_mute",
      "wing_describe",
      "wing_discover",
      "wing_dump",
      "wing_dynamics_status",
      "wing_fade",
      "wing_fade_cancel",
      "wing_get",
      "wing_get_autosave_config",
      "wing_get_delay",
      "wing_get_global_alt_switch",
      "wing_get_gpio",
      "wing_get_group_membership",
      "wing_get_input_patch",
      "wing_get_insert",
      "wing_get_lighting",
      "wing_get_link_status",
      "wing_get_matrix_direct_input",
      "wing_get_monitor_bus",
      "wing_get_osc_mirror_status",
      "wing_get_plugin_model",
      "wing_get_processing_block",
      "wing_get_rta",
      "wing_get_rta_source",
      "wing_get_scribble",
      "wing_get_selected_strip",
      "wing_get_send",
      "wing_get_solo_config",
      "wing_get_source",
      "wing_get_strip_solo",
      "wing_get_talkback",
      "wing_get_wlive_status",
      "wing_list_names",
      "wing_list_plugins_by_usage",
      "wing_meter_stats",
      "wing_mic_calibration_delete",
      "wing_mic_calibration_list",
      "wing_mic_calibration_save",
      "wing_mutegroup_set",
      "wing_mutegroup_set_name",
      "wing_mutegroup_toggle",
      "wing_preset_delete",
      "wing_preset_get",
      "wing_preset_list",
      "wing_preset_load",
      "wing_preset_save",
      "wing_restore_value",
      "wing_save_to_flash",
      "wing_scene_get_current",
      "wing_scene_list",
      "wing_scene_next",
      "wing_scene_prev",
      "wing_scene_recall",
      "wing_set",
      "wing_set_alt_source_active",
      "wing_set_autosave_config",
      "wing_set_delay",
      "wing_set_global_alt_switch",
      "wing_set_gpio_mode",
      "wing_set_gpio_state",
      "wing_set_group_membership",
      "wing_set_input_connection",
      "wing_set_insert",
      "wing_set_lighting",
      "wing_set_matrix_direct_input",
      "wing_set_monitor_bus",
      "wing_set_osc_mirror",
      "wing_set_processing_block",
      "wing_set_rta_source",
      "wing_set_scribble",
      "wing_set_selected_strip",
      "wing_set_send",
      "wing_set_solo_config",
      "wing_set_source",
      "wing_set_srcauto",
      "wing_set_strip_solo",
      "wing_set_talkback_assign",
      "wing_set_talkback_destination",
      "wing_set_talkback_source",
      "wing_store_value",
      "wing_undo_last_adjust",
      "wing_usb_play",
      "wing_usb_player_status",
      "wing_usb_record",
      "wing_usb_set_repeat",
      "wing_wlive_format_sd_card",
      "wing_wlive_marker",
      "wing_wlive_session",
      "wing_wlive_transport",
      "wing_get_many",
      "wing_history",
      "wing_undo",
      "wing_status",
      "wing_bus_set_mono",
      "wing_usr_list",
      "wing_usr_set",
      "wing_input_patch",
      "wing_output_patch",
      "wing_source_list",
      "wing_copy_identity",
      "wing_clear_identity",
      "wing_icon_search",
      "wing_get_box_map",
      "wing_set_box_map",
      "wing_patch_export",
      "wing_channel_copy",
      "wing_channel_swap",
    ]);
  });

  it("wing_get reads a leaf value", async () => {
    const result = await client.callTool({ name: "wing_get", arguments: { path: "/ch/1/fdr" } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      path: "/ch/1/fdr",
      kind: "leaf",
      valueKind: "float",
      display: "-6.0",
      raw: 0.53,
      value: -6,
    });
  });

  it("wing_set clamps a numeric value into the catalog's [min, max] before writing", async () => {
    const result = await client.callTool({ name: "wing_set", arguments: { path: "/ch/1/fdr", value: 20 } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/1", assignments: { fdr: 10 } }]);
    const structured = result.structuredContent as { path: string; status: string; results: Record<string, unknown>[] };
    expect(structured).to.include({ path: "/ch/1/fdr", status: "OK" });
    expect(structured.results[0]).to.include({ requested: 20, sent: 10, stored: 10, match: true, previous: -6 });
  });

  it("wing_set rejects a wildly out-of-range value as a tool-visible error, without writing anything", async () => {
    const result = await client.callTool({ name: "wing_set", arguments: { path: "/ch/1/fdr", value: 1000 } });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("far outside the expected range");
    expect(handle.bulkSetCalls).to.deep.equal([]);
  });

  // The convenience setters call bulkSet directly instead of going through validateNodeValue, so
  // unlike wing_set above, their schema is the only thing standing between a model and the
  // console. It used to be a bare z.number() while the description promised -144..10.
  for (const { tool, args, label } of [
    { tool: "wing_channel_set_fader", args: { channel: 1 }, label: "channel" },
    { tool: "wing_bus_set_fader", args: { type: "bus", index: 1 }, label: "bus/main/matrix" },
    { tool: "wing_dca_set_fader", args: { dca: 1 }, label: "DCA" },
  ]) {
    it(`${tool} rejects a fader level above the console's range without writing anything`, async () => {
      const result = await client.callTool({ name: tool, arguments: { ...args, db: 100 } });
      expect(result.isError, `${label} fader accepted +100 dB`).to.equal(true);
      expect(handle.bulkSetCalls).to.deep.equal([]);
    });

    it(`${tool} rejects a fader level below the console's range without writing anything`, async () => {
      const result = await client.callTool({ name: tool, arguments: { ...args, db: -200 } });
      expect(result.isError, `${label} fader accepted -200 dB`).to.equal(true);
      expect(handle.bulkSetCalls).to.deep.equal([]);
    });

    it(`${tool} still accepts the range's endpoints`, async () => {
      const result = await client.callTool({ name: tool, arguments: { ...args, db: -144 } });
      expect(result.isError).to.not.equal(true);
      expect(handle.bulkSetCalls).to.have.lengthOf(1);
    });
  }

  it("wing_set rejects an invalid enum value as a tool-visible error, without writing anything", async () => {
    const result = await client.callTool({ name: "wing_set", arguments: { path: "/ch/1/eq/mdl", value: "NOTAMODEL" } });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("expected one of");
    expect(handle.bulkSetCalls).to.deep.equal([]);
  });

  it("wing_set passes a value through unvalidated for a path the catalog doesn't cover", async () => {
    const result = await client.callTool({ name: "wing_set", arguments: { path: "/ch/1/in/set/dlyon", value: 5 } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/1/in/set", assignments: { dlyon: 5 } }]);
  });

  it("wing_bulk_set validates each assignment against its own full path, including nested dotted keys", async () => {
    const result = await client.callTool({
      name: "wing_bulk_set",
      arguments: { baseNode: "/ch/1", assignments: { fdr: 20, "eq.on": 1 } },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/1", assignments: { fdr: 10, "eq.on": 1 } }]);
  });

  it("wing_bulk_set rejects an invalid assignment as a tool-visible error, without writing anything", async () => {
    const result = await client.callTool({
      name: "wing_bulk_set",
      arguments: { baseNode: "/ch/1/eq", assignments: { mdl: "NOTAMODEL" } },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("expected one of");
    expect(handle.bulkSetCalls).to.deep.equal([]);
  });

  it("wing_set_send issues a bulk-set with only the provided fields (on/levelDb/pan)", async () => {
    const result = await client.callTool({
      name: "wing_set_send",
      arguments: { source: "channel", sourceIndex: 1, destination: "bus", destinationIndex: 2, on: true, levelDb: -4.5, pan: 10 },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/1/send/2", assignments: { on: 1, lvl: -4.5, pan: 10 } }]);
  });

  it("wing_get_send reads a send's on/level/pan from a dump", async () => {
    const result = await client.callTool({
      name: "wing_get_send",
      arguments: { source: "channel", sourceIndex: 1, destination: "bus", destinationIndex: 2 },
    });
    expect(result.isError).to.not.equal(true);
    // The fake client's default dump() fixture has no "on"/"lvl" keys — on defaults false, levelDb NaN.
    expect(result.structuredContent).to.deep.equal({
      source: "channel",
      sourceIndex: 1,
      destination: "bus",
      destinationIndex: 2,
      on: false,
      levelDb: NaN,
      pan: 0,
    });
  });

  it("wing_set_send rejects a destination the source can't reach (main has no send-to-bus/send-to-main)", async () => {
    const result = await client.callTool({
      name: "wing_set_send",
      arguments: { source: "main", sourceIndex: 1, destination: "bus", destinationIndex: 1, on: true },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("has no send to bus");
    expect(handle.bulkSetCalls).to.deep.equal([]);
  });

  it("wing_set_send rejects a bus sending to itself", async () => {
    const result = await client.callTool({
      name: "wing_set_send",
      arguments: { source: "bus", sourceIndex: 3, destination: "bus", destinationIndex: 3, on: true },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("cannot send to itself");
    expect(handle.bulkSetCalls).to.deep.equal([]);
  });

  it("wing_set_send rejects an out-of-range destination index as a tool-visible error", async () => {
    const result = await client.callTool({
      name: "wing_set_send",
      arguments: { source: "channel", sourceIndex: 1, destination: "mtx", destinationIndex: 99, on: true },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("out of range");
    expect(handle.bulkSetCalls).to.deep.equal([]);
  });

  it("wing_channel_set_fader issues a bulk-set and reports the ack", async () => {
    const result = await client.callTool({
      name: "wing_channel_set_fader",
      arguments: { channel: 1, db: -6 },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/1", assignments: { fdr: -6 } }]);
    expect(result.structuredContent).to.deep.equal({ channel: 1, db: -6, status: "OK", ok: true, raw: "OK" });
  });

  it("wing_channel_toggle_mute falls back to the primitive toggle when the bulk-set ack is not OK", async () => {
    const result = await client.callTool({
      name: "wing_channel_toggle_mute",
      arguments: { channel: 1 },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/1", assignments: { mute: -1 } }]);
    expect(handle.toggleCalls).to.deep.equal(["/ch/1/mute"]);
    expect(result.structuredContent).to.deep.equal({ channel: 1, ackOk: false });
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("no ack");
  });

  it("wing_channel_set_name renames the channel directly when its input isn't source-linked", async () => {
    // Channel 1's clink fixture above is explicitly 0 (not linked), so resolveInputNameTarget()
    // falls back to a direct channel rename — the same behavior as before source-linking was
    // handled at all.
    const result = await client.callTool({
      name: "wing_channel_set_name",
      arguments: { channel: 1, name: "Kick2" },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/1", assignments: { name: "Kick2" } }]);
    expect(result.structuredContent).to.include({ channel: 1, name: "Kick2", viaSource: false, baseNode: "/ch/1" });
  });

  it("wing_channel_set_name renames the connected physical input instead when the channel is source-linked", async () => {
    const result = await client.callTool({
      name: "wing_channel_set_name",
      arguments: { channel: 5, name: "Vocal 1" },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/io/in/A/3", assignments: { name: "Vocal 1" } }]);
    expect(result.structuredContent).to.include({
      channel: 5,
      name: "Vocal 1",
      viaSource: true,
      baseNode: "/io/in/A/3",
    });
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("linked to its input source");
  });

  it("wing_mutegroup_set_name renames a mute group via an ACK'd bulk-set", async () => {
    const result = await client.callTool({
      name: "wing_mutegroup_set_name",
      arguments: { mutegroup: 1, name: "Vocals" },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/mgrp/1", assignments: { name: "Vocals" } }]);
    expect(result.structuredContent).to.deep.equal({
      mutegroup: 1,
      name: "Vocals",
      status: "OK",
      ok: true,
      raw: "OK",
    });
  });

  it("wing_get_group_membership decodes #D/#M tags from the strip's tags field", async () => {
    const result = await client.callTool({
      name: "wing_get_group_membership",
      arguments: { type: "channel", index: 7 },
    });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({ type: "channel", index: 7, dca: [], mutegroups: [] });
  });

  it("wing_set_group_membership adds a #D tag, preserving other tags, and verifies by reading tags back", async () => {
    const result = await client.callTool({
      name: "wing_set_group_membership",
      arguments: { type: "channel", index: 7, kind: "dca", group: 3, on: true },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.setCalls).to.deep.equal([{ path: "/ch/7/tags", value: "#D3" }]);
    expect(result.structuredContent).to.deep.equal({
      type: "channel",
      index: 7,
      kind: "dca",
      group: 3,
      on: true,
      dca: [3],
      mutegroups: [],
    });
  });

  it("wing_set_group_membership rejects a DCA index out of range as a tool-visible error", async () => {
    const result = await client.callTool({
      name: "wing_set_group_membership",
      arguments: { type: "channel", index: 7, kind: "dca", group: 99, on: true },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("out of range");
    expect(handle.setCalls).to.deep.equal([]);
  });

  it("wing_dca_get_fader reads a DCA fader value", async () => {
    const result = await client.callTool({ name: "wing_dca_get_fader", arguments: { dca: 1 } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({ dca: 1, db: 0 });
  });

  it("wing_scene_recall bulk-sets $actionidx and $action=GO on /$ctl/lib", async () => {
    const result = await client.callTool({
      name: "wing_scene_recall",
      arguments: { target: 5 },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([
      { baseNode: "/$ctl/lib", assignments: { $actionidx: 5, $action: "GO" } },
    ]);
  });

  it("wing_dump rejects a root namespace before ever calling the client, as a tool-visible error", async () => {
    const result = await client.callTool({ name: "wing_dump", arguments: { path: "/ch" } });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("wing_dump only allows");
  });

  it("wing_list_names reads every channel/aux/bus/main/matrix/dca/mutegroup name leaf", async () => {
    const result = await client.callTool({ name: "wing_list_names", arguments: {} });
    expect(result.isError).to.not.equal(true);
    const structured = result.structuredContent as { channels: { index: number; name: string }[]; dcas: { index: number; name: string }[] };
    // The fake client's default (branch) reply resolves to an empty name for any index not
    // explicitly stubbed in GET_FIXTURES — only /ch/1 and /dca/2 are stubbed above.
    expect(structured.channels).to.have.lengthOf(40);
    expect(structured.channels[0]).to.include({ index: 1, name: "Kick", source: "live" });
    expect(structured.channels[1]).to.include({ index: 2, name: "" });
    expect(structured.dcas).to.have.lengthOf(16);
    expect(structured.dcas[1]).to.include({ index: 2, name: "Band" });
  });

  it("wing_fade starts a background ramp and reports the resolved from/to immediately", async () => {
    const result = await client.callTool({
      name: "wing_fade",
      arguments: { path: "/ch/1/fdr", durationMs: 100, direction: "out" },
    });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      status: "started",
      path: "/ch/1/fdr",
      from: -6,
      to: -144,
      durationMs: 100,
      steps: 2,
      easing: "linear",
    });

    // Cancel right away — the interval's first tick is 50ms out, so this runs well before any
    // step fires, proving the fade was actually registered as active rather than a no-op.
    const cancelResult = await client.callTool({ name: "wing_fade_cancel", arguments: { path: "/ch/1/fdr" } });
    expect(cancelResult.structuredContent).to.deep.equal({ status: "cancelled", path: "/ch/1/fdr", wasActive: true });
  });

  it("wing_fade accepts an explicit easing curve and reports it back", async () => {
    const result = await client.callTool({
      name: "wing_fade",
      arguments: { path: "/ch/1/fdr", durationMs: 100, direction: "out", easing: "expo-out" },
    });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      status: "started",
      path: "/ch/1/fdr",
      from: -6,
      to: -144,
      durationMs: 100,
      steps: 2,
      easing: "expo-out",
    });
    await client.callTool({ name: "wing_fade_cancel", arguments: { path: "/ch/1/fdr" } });
  });

  it("wing_fade rejects an unknown easing curve", async () => {
    const result = await client.callTool({
      name: "wing_fade",
      arguments: { path: "/ch/1/fdr", durationMs: 100, direction: "out", easing: "bogus" },
    });
    expect(result.isError).to.equal(true);
  });

  it("wing_fade_cancel on an idle path is a no-op, not an error", async () => {
    const result = await client.callTool({ name: "wing_fade_cancel", arguments: { path: "/ch/2/fdr" } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({ status: "cancelled", path: "/ch/2/fdr", wasActive: false });
  });

  it("wing_get_rta reports unavailable before any RTA frame has been received", async () => {
    const result = await client.callTool({ name: "wing_get_rta" });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({ available: false });
  });

  it("wing_get_rta returns the cached snapshot once one has arrived", async () => {
    rta.snapshot = { bandsDb: [-80, -40, -12, 0], receivedAt: 1000 };
    const result = await client.callTool({ name: "wing_get_rta" });
    expect(result.isError).to.not.equal(true);
    const structured = result.structuredContent as { available: boolean; bandsDb: number[]; receivedAt: number; ageMs: number };
    expect(structured.available).to.equal(true);
    expect(structured.bandsDb).to.deep.equal([-80, -40, -12, 0]);
    expect(structured.receivedAt).to.equal(1000);
    expect(structured.ageMs).to.be.a("number");
  });

  it("wing_meter_stats samples the live meter stream and computes per-channel level statistics", async () => {
    const frames = [
      { type: "channel", index: 5, inputL_dB: -20, inputR_dB: -22, outputL_dB: -10, outputR_dB: -11, gateKey_dB: -30, gateGain_dB: -1, dynKey_dB: -25, dynGain_dB: -2 },
      // Below the default -50dB exclusion threshold — should count toward raw min but not minAboveThreshold.
      { type: "channel", index: 5, inputL_dB: -60, inputR_dB: -58, outputL_dB: -10, outputR_dB: -11, gateKey_dB: -30, gateGain_dB: -1, dynKey_dB: -25, dynGain_dB: -2 },
      { type: "channel", index: 5, inputL_dB: -10, inputR_dB: -12, outputL_dB: -10, outputR_dB: -11, gateKey_dB: -30, gateGain_dB: -1, dynKey_dB: -25, dynGain_dB: -2 },
      // A different index — must be ignored by the stats for channel 5.
      { type: "channel", index: 6, inputL_dB: 5, inputR_dB: 5, outputL_dB: 5, outputR_dB: 5, gateKey_dB: 5, gateGain_dB: 5, dynKey_dB: 5, dynGain_dB: 5 },
    ];
    let i = 0;
    const emitter = setInterval(() => {
      meterClient.emit("snapshot", { frames: [frames[i % frames.length]] });
      i++;
    }, 20);

    try {
      const result = await client.callTool({
        name: "wing_meter_stats",
        arguments: { type: "channel", index: 5, signal: "input", durationMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        sampleCount: number;
        excludeBelowDb: number;
        channels: { left: { min: number; max: number; minAboveThreshold: number | null }; right: unknown };
      };
      expect(structured.excludeBelowDb).to.equal(-50);
      expect(structured.sampleCount).to.be.greaterThan(0);
      expect(structured.channels.left.min).to.equal(-60);
      expect(structured.channels.left.max).to.equal(-10);
      expect(structured.channels.left.minAboveThreshold).to.equal(-20);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_meter_stats reports gate as separate key/gain stats rather than pooling them", async () => {
    // "gate" only exists on channel strips (see the "rejects...on a bus/main/matrix strip" test
    // below) — bus doesn't have one, so this uses "channel" like every other gate-signal test here.
    const frame = {
      type: "channel",
      index: 2,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -33,
      gateGain_dB: -4,
      dynKey_dB: -25,
      dynGain_dB: -2,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_meter_stats",
        arguments: { type: "channel", index: 2, signal: "gate", durationMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as { channels: { key: { min: number }; gain: { min: number } } };
      expect(structured.channels.key.min).to.equal(-33);
      // Fake gate dump fixture is model "STD" (fictional placeholder, not a real firmware model
      // name) — not "GATE", so the correction factor is 1 and -4 passes through unchanged.
      expect(structured.channels.gain.min).to.equal(-4);
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_meter_stats rejects signal: "gate" on a bus/main/matrix strip', async () => {
    const result = await client.callTool({
      name: "wing_meter_stats",
      arguments: { type: "bus", index: 2, signal: "gate" },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include('The "gate" slot only exists on channel strips');
  });

  it('wing_meter_stats applies the "GATE" model\'s documented 60dB (vs 20dB default) full-scale correction', async () => {
    const frame = {
      type: "channel",
      index: 21,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -33,
      gateGain_dB: -4, // default-scale reading; true value is -4 * 3 = -12dB for the "GATE" model
      dynKey_dB: -25,
      dynGain_dB: -2,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_meter_stats",
        arguments: { type: "channel", index: 21, signal: "gate", durationMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        channels: { gain: { min: number; max: number } };
        gainReductionFullScaleDb: number;
      };
      expect(structured.gainReductionFullScaleDb).to.equal(60);
      expect(structured.channels.gain.min).to.equal(-12);
      expect(structured.channels.gain.max).to.equal(-12);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_meter_stats fails clearly when no meter data arrives during the window", async () => {
    const result = await client.callTool({
      name: "wing_meter_stats",
      arguments: { type: "channel", index: 1, durationMs: 500 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("No live meter data received");
  });

  it("wing_dynamics_status reports gate+dyn settings and the live gain reduction happening right now", async () => {
    const frame = {
      type: "channel",
      index: 7,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -30,
      gateGain_dB: -2,
      dynKey_dB: -25,
      dynGain_dB: -5,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_dynamics_status",
        arguments: { type: "channel", index: 7, sampleMs: 300 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        blocks: {
          gate: { settings: Record<string, unknown>; live: { currentGainReductionDb: number; active: boolean } };
          dyn: { settings: Record<string, unknown>; live: { currentGainReductionDb: number; active: boolean } };
        };
      };
      expect(structured.blocks.gate.settings.thr).to.equal(-40);
      expect(structured.blocks.gate.live.currentGainReductionDb).to.equal(-2);
      expect(structured.blocks.gate.live.active).to.equal(true);
      expect(structured.blocks.dyn.settings.thr).to.equal(-20);
      expect(structured.blocks.dyn.live.currentGainReductionDb).to.equal(-5);
      const content = result.content as CallToolTextContent[];
      expect(content[0].text).to.include("reducing -2.0dB now");
      expect(content[0].text).to.include("reducing -5.0dB now");
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_dynamics_status silently reports dyn only (no gate) for aux, like bus/main/matrix", async () => {
    const frame = {
      type: "aux",
      index: 5,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -30,
      gateGain_dB: -2,
      dynKey_dB: -25,
      dynGain_dB: -5,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_dynamics_status",
        arguments: { type: "aux", index: 5, sampleMs: 300 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as { blocks: Record<string, unknown> };
      expect(Object.keys(structured.blocks)).to.deep.equal(["dyn"]);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_dynamics_status silently reports dyn only (no gate) for bus/main/matrix strips", async () => {
    const frame = {
      type: "bus",
      index: 3,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -30,
      gateGain_dB: -2,
      dynKey_dB: -25,
      dynGain_dB: -5,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_dynamics_status",
        arguments: { type: "bus", index: 3, sampleMs: 300 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as { blocks: Record<string, unknown> };
      expect(Object.keys(structured.blocks)).to.deep.equal(["dyn"]);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_dynamics_status rejects block: \"gate\" on a bus/main/matrix strip", async () => {
    const result = await client.callTool({
      name: "wing_dynamics_status",
      arguments: { type: "bus", index: 3, block: "gate" },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include('The "gate" slot only exists on channel strips');
  });

  it("wing_auto_compress sets a new threshold and compensates the measured reduction with makeup gain", async () => {
    const frame = {
      type: "channel",
      index: 9,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -16,
      outputR_dB: -18,
      gateKey_dB: -30,
      gateGain_dB: 0,
      dynKey_dB: -10,
      dynGain_dB: -6,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 9, thresholdDb: -18, sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        threshold: { old: number; new: number };
        makeupGain: { old: number; new: number; clamped: boolean };
        measured: { meanGainReductionDb: number };
      };
      expect(structured.threshold).to.deep.equal({ old: -20, new: -18 });
      expect(structured.makeupGain).to.deep.equal({ old: 2, new: 8, clamped: false, applied: true });
      expect(structured.measured.meanGainReductionDb).to.equal(-6);

      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/ch/9/dyn", assignments: { thr: -18, on: 1 } });
      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/ch/9/dyn", assignments: { gain: 8 } });
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress works on aux strips (dyn only, no gate slot exists there)", async () => {
    const frame = {
      type: "aux",
      index: 6,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -16,
      outputR_dB: -18,
      gateKey_dB: -30,
      gateGain_dB: 0,
      dynKey_dB: -10,
      dynGain_dB: -3,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "aux", index: 6, sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        block: string;
        makeupGain: { old: number; new: number; clamped: boolean };
      };
      expect(structured.block).to.equal("dyn");
      expect(structured.makeupGain).to.deep.equal({ old: 2, new: 5, clamped: false, applied: true });
      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/aux/6/dyn", assignments: { gain: 5 } });
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress can drive the \"gate\" slot instead of \"dyn\" when a compressor model is loaded there", async () => {
    const frame = {
      type: "channel",
      index: 12,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -16,
      outputR_dB: -18,
      gateKey_dB: -10,
      gateGain_dB: -4,
      dynKey_dB: -30,
      dynGain_dB: 0,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 12, block: "gate", thresholdDb: -35, sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        block: string;
        makeupGain: { old: number; new: number; clamped: boolean };
      };
      expect(structured.block).to.equal("gate");
      // Fake gate dump fixture starts at gain: 0; measured mean reduction is -4dB, so makeup compensates by +4.
      expect(structured.makeupGain).to.deep.equal({ old: 0, new: 4, clamped: false, applied: true });

      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/ch/12/gate", assignments: { thr: -35, on: 1 } });
      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/ch/12/gate", assignments: { gain: 4 } });
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress treats a positive gain reading as idle detector noise, not negative reduction", async () => {
    // Verified against real hardware: some models idle with a slight *positive* wobble in their
    // own gain-reduction reading instead of a flat 0 — must not be treated as "gain reduction" (it
    // would otherwise nudge makeup gain in the wrong direction to "compensate" for pure noise).
    const frame = {
      type: "channel",
      index: 13,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -10,
      outputR_dB: -12,
      gateKey_dB: -30,
      gateGain_dB: 0,
      dynKey_dB: -20,
      dynGain_dB: 0.5,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 13, sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        measured: { meanGainReductionDb: number; peakGainReductionDb: number };
        makeupGain: { old: number; new: number; clamped: boolean };
      };
      expect(structured.measured.meanGainReductionDb).to.equal(0);
      expect(structured.measured.peakGainReductionDb).to.equal(0);
      expect(structured.makeupGain).to.deep.equal({ old: 2, new: 2, clamped: false, applied: true });
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress rejects block: \"gate\" on a bus/main/matrix strip", async () => {
    const result = await client.callTool({
      name: "wing_auto_compress",
      arguments: { type: "bus", index: 4, block: "gate" },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include('The "gate" slot only exists on channel strips');
  });

  it("wing_auto_compress fails clearly (without guessing a makeup value) when there's no real signal to measure", async () => {
    const frame = {
      type: "channel",
      index: 10,
      inputL_dB: -90,
      inputR_dB: -92,
      outputL_dB: -90,
      outputR_dB: -92,
      gateKey_dB: -90,
      gateGain_dB: 0,
      dynKey_dB: -90,
      dynGain_dB: -3,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 10, sampleMs: 500 },
      });
      expect(result.isError).to.equal(true);
      const content = result.content as CallToolTextContent[];
      expect(content[0].text).to.include("No real signal was detected");
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress fails clearly when no live meter data arrives at all", async () => {
    const result = await client.callTool({
      name: "wing_auto_compress",
      arguments: { type: "channel", index: 11, sampleMs: 500 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("no live meter data was received");
  });

  it('wing_dynamics_status reports a Dynamic EQ (mdl "DEQ2") boosting as active, not as idle noise', async () => {
    // A Dynamic EQ can legitimately boost a detected band, unlike every cut-only gate/compressor
    // model — a boost here must NOT be treated as detector wobble (see channel 4's gate in the
    // auto-compress idle-noise test below, which IS cut-only and must still clamp positives).
    // Real DEQ/DEQ2 wire a BOOST as a NEGATIVE word (and a cut as positive) — gainReductionScaleCorrection
    // flips it, so -2.5 on the wire becomes +2.5 = "boosting 2.5dB".
    const frame = {
      type: "channel",
      index: 20,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -30,
      gateGain_dB: -2.5,
      dynKey_dB: -30,
      dynGain_dB: 0,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_dynamics_status",
        arguments: { type: "channel", index: 20, block: "gate", sampleMs: 300 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        blocks: { gate: { live: { currentGainReductionDb: number; active: boolean; bidirectional: boolean } } };
      };
      expect(structured.blocks.gate.live.bidirectional).to.equal(true);
      expect(structured.blocks.gate.live.currentGainReductionDb).to.equal(2.5);
      expect(structured.blocks.gate.live.active).to.equal(true);
      const content = result.content as CallToolTextContent[];
      expect(content[0].text).to.include("boosting 2.5dB now");
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_dynamics_status reports a Dynamic EQ (mdl "DEQ2") cutting as "cutting", not "reducing"', async () => {
    // Real DEQ/DEQ2 wire a CUT as a POSITIVE word; gainReductionScaleCorrection flips it, so +3 on
    // the wire becomes -3 = "cutting 3.0dB".
    const frame = {
      type: "channel",
      index: 20,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -30,
      gateGain_dB: 3,
      dynKey_dB: -30,
      dynGain_dB: 0,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_dynamics_status",
        arguments: { type: "channel", index: 20, block: "gate", sampleMs: 300 },
      });
      expect(result.isError).to.not.equal(true);
      const content = result.content as CallToolTextContent[];
      expect(content[0].text).to.include("cutting 3.0dB now");
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_compress does NOT clamp a Dynamic EQ (mdl "DEQ2") boost to zero like it would for a cut-only model', async () => {
    // Real DEQ/DEQ2 wire a BOOST as a NEGATIVE word; gainReductionScaleCorrection flips -2 -> +2, a
    // real boost that must survive into the mean/peak (not be clamped to 0 like a cut-only model's).
    const frame = {
      type: "channel",
      index: 20,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -10,
      outputR_dB: -12,
      gateKey_dB: -20,
      gateGain_dB: -2,
      dynKey_dB: -30,
      dynGain_dB: 0,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 20, block: "gate", sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        model: string;
        measured: { meanGainReductionDb: number; peakGainReductionDb: number };
        makeupGain: { old: number; new: number; clamped: boolean };
      };
      expect(structured.model).to.equal("DEQ2");
      // Unclamped: the real +2dB boost survives into the mean/peak instead of being flattened to 0.
      expect(structured.measured.meanGainReductionDb).to.equal(2);
      expect(structured.measured.peakGainReductionDb).to.equal(2);
      // Makeup gain compensates a net boost by going down, not up (old 0 -> new -2).
      expect(structured.makeupGain).to.deep.equal({ old: 0, new: -2, clamped: false, applied: true });
      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/ch/20/gate", assignments: { gain: -2 } });
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_dynamics_status applies the "GATE" model\'s documented 60dB (vs 20dB default) full-scale correction', async () => {
    // -10dB here simulates what the meter protocol parsing layer itself would report using the
    // DEFAULT 20dB scale (it can't know the model) — the true value, once wing_dynamics_status looks
    // up mdl "GATE" and applies the documented 3x (60/20) correction, must be -30dB, not -10dB.
    const frame = {
      type: "channel",
      index: 21,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -61,
      gateGain_dB: -10,
      dynKey_dB: -30,
      dynGain_dB: 0,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_dynamics_status",
        arguments: { type: "channel", index: 21, block: "gate", sampleMs: 300 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        blocks: { gate: { live: { currentGainReductionDb: number; peakGainReductionDb: number } } };
      };
      expect(structured.blocks.gate.live.currentGainReductionDb).to.equal(-30);
      expect(structured.blocks.gate.live.peakGainReductionDb).to.equal(-30);
      const content = result.content as CallToolTextContent[];
      expect(content[0].text).to.include("reducing -30.0dB now");
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_compress applies the "GATE" model\'s documented 60dB (vs 20dB default) full-scale correction to makeup gain', async () => {
    const frame = {
      type: "channel",
      index: 21,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -10,
      outputR_dB: -12,
      gateKey_dB: -61,
      gateGain_dB: -10, // default-scale reading; true value is -10 * 3 = -30dB for the "GATE" model
      dynKey_dB: -30,
      dynGain_dB: 0,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 21, block: "gate", sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        model: string;
        measured: { meanGainReductionDb: number; peakGainReductionDb: number };
        makeupGain: { old: number; new: number; clamped: boolean };
      };
      expect(structured.model).to.equal("GATE");
      expect(structured.measured.meanGainReductionDb).to.equal(-30);
      expect(structured.measured.peakGainReductionDb).to.equal(-30);
      expect(structured.makeupGain).to.deep.equal({ old: 0, new: 20, clamped: true, applied: true });
      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/ch/21/gate", assignments: { gain: 20 } });
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_compress rejects thresholdDb for an input-gain-driven model (e.g. real "76LA"), pointing at inputGainDb/targetReductionDb', async () => {
    const result = await client.callTool({
      name: "wing_auto_compress",
      arguments: { type: "channel", index: 22, block: "dyn", thresholdDb: -20, sampleMs: 500 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("Model 76LA");
    expect(content[0].text).to.include('driven by its "in" control');
    expect(content[0].text).to.include("inputGainDb");
    expect(content[0].text).to.include("targetReductionDb");
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it('wing_auto_compress omitting thresholdDb still works fine on a model with no "thr" field', async () => {
    const frame = {
      type: "channel",
      index: 22,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -10,
      outputR_dB: -12,
      gateKey_dB: -30,
      gateGain_dB: 0,
      dynKey_dB: -15,
      // Real 76LA reports reduction with INVERTED sign (see gainReductionScaleCorrection) — a
      // positive +2 here is 2 dB of reduction, which the tool's -1 correction turns back into -2.
      dynGain_dB: 2,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 22, block: "dyn", sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as { model: string; makeupGain: { old: number; new: number } };
      expect(structured.model).to.equal("76LA");
      expect(structured.makeupGain).to.deep.equal({ old: 0, new: 2, clamped: false, applied: true });
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_compress rejects ratio for a model with no "ratio" field in the fake fixture (channel 21\'s gate)', async () => {
    const result = await client.callTool({
      name: "wing_auto_compress",
      arguments: { type: "channel", index: 21, block: "gate", ratio: "1:3", sampleMs: 500 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include('has no "ratio" field');
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_meter_stats stops sampling the console when the caller cancels", async () => {
    // The point is not that the client's promise rejects — it does that on its own. It is that the
    // *server* lets go: before this, a cancelled call kept its snapshot listener attached and kept
    // measuring for the rest of its window, up to 45s of a desk being driven for nobody.
    const controller = new AbortController();
    const call = client.callTool(
      { name: "wing_meter_stats", arguments: { type: "channel", index: 1, signal: "input", durationMs: 30_000 } },
      undefined,
      { signal: controller.signal },
    );

    const start = Date.now();
    const until = async (condition: () => boolean): Promise<void> => {
      while (!condition()) {
        if (Date.now() - start > 5000) throw new Error("condition not met in time");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    await until(() => meterClient.listenerCount("snapshot") > 0);
    controller.abort();
    await call.catch(() => undefined);

    await until(() => meterClient.listenerCount("snapshot") === 0);
    expect(Date.now() - start, "it must let go immediately, not after the 30s window").to.be.lessThan(5000);
  });

  // Both of these tools accept, at the top of their own schemas, durations that run far past the
  // MCP client's default 60s request timeout: auto-compress 15 rounds x 15s (~4 minutes), auto-EQ
  // up to 7 captures x 21s. Past that point the client abandons the call while this server carries
  // on driving a live console — so the request is refused up front instead of started.
  it("wing_auto_compress refuses a run that cannot finish before a client gives up", async () => {
    const result = await client.callTool({
      name: "wing_auto_compress",
      arguments: { type: "channel", index: 9, targetReductionDb: -5, maxIterations: 15, sampleMs: 15000 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    // The caller is a model that picked these numbers off the schema, so the refusal has to say
    // which knob to turn back rather than just saying no.
    expect(content[0].text).to.include("maxIterations");
    expect(content[0].text).to.include("sampleMs");
    expect(handle.bulkSetCalls, "nothing may be written before refusing").to.have.length(0);
  });

  it("the budget guard stays out of the way of an ordinary run", async () => {
    // Defaults come to ~16s, comfortably inside the budget. This call still fails here — the fake
    // meter client is emitting nothing, so there is no signal to measure — but it must fail for
    // *that* reason, not because the guard turned it away.
    const result = await client.callTool({
      name: "wing_auto_compress",
      arguments: { type: "channel", index: 9, thresholdDb: -18, sampleMs: 500 },
    });
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.not.include("beyond the");
    expect(content[0].text).to.not.include("abandon a call");
  });

  it("wing_auto_eq_balance refuses a run that cannot finish before a client gives up", async () => {
    const result = await client.callTool({
      name: "wing_auto_eq_balance",
      arguments: {
        micChannel: 1,
        zones: [{ type: "matrix", index: 1, fromHz: 20, toHz: 20000 }],
        iterations: 5,
        sampleMs: 20000,
      },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("sampleMs");
  });

  it("wing_auto_compress rejects passing more than one of thresholdDb / targetReductionDb / inputGainDb together", async () => {
    const result = await client.callTool({
      name: "wing_auto_compress",
      arguments: { type: "channel", index: 9, thresholdDb: -18, targetReductionDb: -5, sampleMs: 500 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("Pass at most one of");
    expect(content[0].text).to.include("thresholdDb + targetReductionDb");
    expect(handle.bulkSetCalls).to.have.length(0);

    const result2 = await client.callTool({
      name: "wing_auto_compress",
      arguments: { type: "channel", index: 22, block: "dyn", inputGainDb: -20, targetReductionDb: -5, sampleMs: 500 },
    });
    expect(result2.isError).to.equal(true);
    expect((result2.content as CallToolTextContent[])[0].text).to.include("inputGainDb");
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it('wing_auto_compress rejects inputGainDb for a model that has a threshold (e.g. "COMP" on channel 9)', async () => {
    const result = await client.callTool({
      name: "wing_auto_compress",
      arguments: { type: "channel", index: 9, block: "dyn", inputGainDb: -20, sampleMs: 500 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include('has a threshold ("thr")');
    expect(content[0].text).to.include("thresholdDb");
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it('wing_auto_compress searches an input-gain-driven model\'s "in" control toward a target reduction (real "76LA")', async () => {
    // Channel 22 = mdl "76LA": no "thr", driven by its "in" input-drive knob (-48..0 dB). Simulate a
    // monotonic response — 1 dB more reduction per dB of "in" pushed above -30 — so the search, seeded
    // with the input-gain polarity (raise "in" -> more reduction), converges by moving "in" upward.
    // The real 76LA reports reduction with INVERTED sign (see gainReductionScaleCorrection), so the
    // fixture's dynGain_dB is POSITIVE (-reduction) — the tool's -1 correction turns it back negative.
    function currentIn(): number {
      for (let i = handle.bulkSetCalls.length - 1; i >= 0; i--) {
        const c = handle.bulkSetCalls[i];
        if (c.baseNode === "/ch/22/dyn" && typeof c.assignments.in === "number") return c.assignments.in as number;
      }
      return -26.5; // dump fixture's starting "in"
    }
    function frame() {
      const drive = currentIn();
      const reduction = Math.max(-24, Math.min(0, -(drive - -30)));
      return {
        type: "channel",
        index: 22,
        inputL_dB: -8,
        inputR_dB: -8,
        outputL_dB: -8 + reduction,
        outputR_dB: -8 + reduction,
        gateKey_dB: -40,
        gateGain_dB: 0,
        dynKey_dB: -8,
        dynGain_dB: -reduction,
      };
    }
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame()] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 22, block: "dyn", targetReductionDb: -8, sampleMs: 500, maxIterations: 6 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        model: string;
        control: { kind: string; key: string; old: number; new: number };
        threshold: { old: number; new: number };
        target: { converged: boolean; stopReason: string };
        measured: { meanGainReductionDb: number };
        makeupGain: { old: number; new: number; clamped: boolean; applied: boolean };
      };
      expect(structured.model).to.equal("76LA");
      expect(structured.control.kind).to.equal("input-gain");
      expect(structured.control.key).to.equal("in");
      expect(structured.control.old).to.equal(-26.5);
      expect(structured.control.new).to.be.greaterThan(-26.5);
      expect(structured.threshold).to.deep.equal({ old: 0, new: 0 });
      expect(structured.target.converged).to.equal(true);
      expect(structured.measured.meanGainReductionDb).to.be.closeTo(-8, 0.75);

      const inWrites = handle.bulkSetCalls
        .filter((c) => c.baseNode === "/ch/22/dyn" && typeof c.assignments.in === "number")
        .map((c) => c.assignments.in as number);
      expect(inWrites.length).to.be.greaterThan(0);
      expect(Math.max(...inWrites)).to.be.greaterThan(-26.5);
      expect(handle.bulkSetCalls.some((c) => c.baseNode === "/ch/22/dyn" && typeof c.assignments.thr === "number")).to.equal(false);
      // Makeup gain subtracts BOTH the measured reduction and the dB the "in" drive was pushed by.
      const finalGain = [...handle.bulkSetCalls].reverse().find((c) => c.baseNode === "/ch/22/dyn" && "gain" in c.assignments);
      expect(finalGain).to.not.equal(undefined);
      expect(structured.makeupGain.applied).to.equal(true);
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_compress sets an input-gain-driven model\'s "in" directly via inputGainDb (real "76LA")', async () => {
    const frame = {
      type: "channel",
      index: 22,
      inputL_dB: -8,
      inputR_dB: -8,
      outputL_dB: -12,
      outputR_dB: -12,
      gateKey_dB: -40,
      gateGain_dB: 0,
      dynKey_dB: -8,
      dynGain_dB: -3,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 22, block: "dyn", inputGainDb: -18, sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        control: { kind: string; key: string; old: number; new: number };
      };
      expect(structured.control).to.deep.equal({ kind: "input-gain", key: "in", old: -26.5, new: -18, unit: "dB" });
      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/ch/22/dyn", assignments: { in: -18, on: 1 } });
      expect(handle.bulkSetCalls.some((c) => c.baseNode === "/ch/22/dyn" && "gain" in c.assignments)).to.equal(true);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress leaves the threshold untouched when it already produces the requested reduction", async () => {
    const frame = {
      type: "channel",
      index: 24,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -16,
      outputR_dB: -18,
      gateKey_dB: -30,
      gateGain_dB: 0,
      dynKey_dB: -10,
      dynGain_dB: -6,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 24, targetReductionDb: -6, sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        threshold: { old: number; new: number };
        target: { reductionDb: number; mode: string; converged: boolean; iterations: number; stopReason: string };
        makeupGain: { old: number; new: number; clamped: boolean };
      };
      expect(structured.threshold).to.deep.equal({ old: -20, new: -20 });
      expect(structured.target).to.deep.equal({ reductionDb: -6, mode: "average", converged: true, iterations: 1, stopReason: "converged" });
      expect(structured.makeupGain).to.deep.equal({ old: 2, new: 8, clamped: false, applied: true });
      // The current threshold already hits the target, so it's never rewritten — only the final
      // makeup-gain compensation is sent.
      expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/24/dyn", assignments: { gain: 8 } }]);
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_compress drives the compressor threshold "cthr" (not "thr") on a split comp/limiter model (real "ECL33")', async () => {
    // Channel 28 = mdl "ECL33": no plain "thr", split into "cthr" (compressor) + "lthr" (limiter).
    // Simulate a compressor response keyed off the live "cthr": lower cthr -> more of the -6dB signal
    // is over threshold -> more reduction. Search seeded with threshold polarity (+1) must LOWER cthr.
    function currentCthr(): number {
      for (let i = handle.bulkSetCalls.length - 1; i >= 0; i--) {
        const c = handle.bulkSetCalls[i];
        if (c.baseNode === "/ch/28/dyn" && typeof c.assignments.cthr === "number") return c.assignments.cthr as number;
      }
      return -20; // dump fixture's starting "cthr"
    }
    function frame() {
      const cthr = currentCthr();
      // Compressor transfer: more of the -6dB signal is over threshold as cthr drops -> more reduction.
      const reduction = -Math.max(0, -6 - cthr) * 0.5;
      return {
        type: "channel",
        index: 28,
        inputL_dB: -6,
        inputR_dB: -6,
        outputL_dB: -6 + reduction,
        outputR_dB: -6 + reduction,
        gateKey_dB: -40,
        gateGain_dB: 0,
        dynKey_dB: -6,
        dynGain_dB: reduction,
      };
    }
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame()] }), 20);

    try {
      // Start at cthr -20 -> ~-7dB reduction; asking for -10 needs MORE, so the search must LOWER cthr.
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 28, block: "dyn", targetReductionDb: -10, sampleMs: 500, maxIterations: 8 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        model: string;
        control: { kind: string; key: string; old: number; new: number };
        threshold: { old: number; new: number };
        target: { converged: boolean };
        measured: { meanGainReductionDb: number };
      };
      expect(structured.model).to.equal("ECL33");
      expect(structured.control.kind).to.equal("threshold");
      expect(structured.control.key).to.equal("cthr");
      expect(structured.control.old).to.equal(-20);
      expect(structured.control.new).to.be.lessThan(-20);
      // Back-compat `threshold` mirrors the driven control for any threshold-kind model, cthr included.
      expect(structured.threshold).to.deep.equal({ old: structured.control.old, new: structured.control.new });
      expect(structured.target.converged).to.equal(true);
      expect(structured.measured.meanGainReductionDb).to.be.closeTo(-10, 0.75);
      const cthrWrites = handle.bulkSetCalls.filter((c) => c.baseNode === "/ch/28/dyn" && typeof c.assignments.cthr === "number");
      expect(cthrWrites.length).to.be.greaterThan(0);
      expect(handle.bulkSetCalls.some((c) => c.baseNode === "/ch/28/dyn" && "thr" in c.assignments)).to.equal(false);
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_compress sets "cthr" directly via thresholdDb on a split comp/limiter model (real "ECL33")', async () => {
    const frame = {
      type: "channel",
      index: 28,
      inputL_dB: -6,
      inputR_dB: -6,
      outputL_dB: -9,
      outputR_dB: -9,
      gateKey_dB: -40,
      gateGain_dB: 0,
      dynKey_dB: -6,
      dynGain_dB: -3,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);
    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 28, block: "dyn", thresholdDb: -25, sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as { control: { kind: string; key: string; old: number; new: number } };
      expect(structured.control).to.deep.equal({ kind: "threshold", key: "cthr", old: -20, new: -25, unit: "dB" });
      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/ch/28/dyn", assignments: { cthr: -25, on: 1 } });
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_compress scales the search step to a unitless drive knob\'s native range (real "NSTR", "in" 0..10)', async () => {
    // Channel 29 = mdl "NSTR": no threshold, "in" drive knob describe()'d 0..10 with NO unit. With
    // AUTO_COMPRESS_CTRL_REFERENCE_SPAN_DB = 40 the step is scaled by 10/40 = 0.25, so a big early
    // error (~4 dB) moves "in" by well under a whole unit instead of slamming it across the range.
    function currentIn(): number {
      for (let i = handle.bulkSetCalls.length - 1; i >= 0; i--) {
        const c = handle.bulkSetCalls[i];
        if (c.baseNode === "/ch/29/dyn" && typeof c.assignments.in === "number") return c.assignments.in as number;
      }
      return 3; // dump fixture's starting "in"
    }
    function frame() {
      const drive = currentIn();
      const reduction = -Math.max(0, drive - 2) * 2; // 2 dB reduction per unit of "in" above 2
      return {
        type: "channel",
        index: 29,
        inputL_dB: -8,
        inputR_dB: -8,
        outputL_dB: -8 + reduction,
        outputR_dB: -8 + reduction,
        gateKey_dB: -40,
        gateGain_dB: 0,
        dynKey_dB: -8,
        dynGain_dB: reduction,
      };
    }
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame()] }), 20);
    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 29, block: "dyn", targetReductionDb: -6, sampleMs: 500, maxIterations: 10 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        control: { key: string; old: number; new: number };
        target: { converged: boolean };
        measured: { meanGainReductionDb: number };
        makeupGain: { old: number; new: number; applied: boolean };
      };
      expect(structured.control.key).to.equal("in");
      expect(structured.target.converged).to.equal(true);
      expect(structured.measured.meanGainReductionDb).to.be.closeTo(-6, 0.75);
      const inWrites = handle.bulkSetCalls
        .filter((c) => c.baseNode === "/ch/29/dyn" && typeof c.assignments.in === "number")
        .map((c) => c.assignments.in as number);
      expect(inWrites.length).to.be.greaterThan(0);
      // First move: error ~-4 dB, step 0.7 * 4 * (10/40) ≈ 0.7 units — nowhere near the full 0..10 span.
      expect(Math.abs(inWrites[0] - 3)).to.be.lessThan(1.5);
      // Unitless knob -> no dB delta in the makeup formula: makeup ≈ 0 - mean only (mean ≈ -6 -> ~+6).
      expect(structured.makeupGain.applied).to.equal(true);
      expect(structured.makeupGain.new).to.be.closeTo(6, 1.5);
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_compress reports makeupGain.applied=false for a model with no "gain" field (real "LA" / LA-2A)', async () => {
    function currentPeak(): number {
      for (let i = handle.bulkSetCalls.length - 1; i >= 0; i--) {
        const c = handle.bulkSetCalls[i];
        if (c.baseNode === "/ch/30/dyn" && typeof c.assignments.peak === "number") return c.assignments.peak as number;
      }
      return 50; // dump fixture's starting "peak"
    }
    function frame() {
      const drive = currentPeak();
      const reduction = -Math.max(0, drive - 10) * 0.2;
      return {
        type: "channel",
        index: 30,
        inputL_dB: -8,
        inputR_dB: -8,
        outputL_dB: -8 + reduction,
        outputR_dB: -8 + reduction,
        gateKey_dB: -40,
        gateGain_dB: 0,
        dynKey_dB: -8,
        dynGain_dB: reduction,
      };
    }
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame()] }), 20);
    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 30, block: "dyn", targetReductionDb: -4, sampleMs: 500, maxIterations: 8 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        model: string;
        control: { key: string };
        makeupGain: { old: number; new: number; clamped: boolean; applied: boolean };
        ack: { status: string; raw: string };
      };
      expect(structured.model).to.equal("LA");
      expect(structured.control.key).to.equal("peak");
      expect(structured.makeupGain.applied).to.equal(false);
      expect(structured.makeupGain.new).to.equal(structured.makeupGain.old);
      expect(structured.ack.raw).to.include("no makeup-gain field");
      expect(handle.bulkSetCalls.some((c) => c.baseNode === "/ch/30/dyn" && "gain" in c.assignments)).to.equal(false);
      // Never touches the inert "ingain" make-up trim.
      expect(handle.bulkSetCalls.some((c) => c.baseNode === "/ch/30/dyn" && "ingain" in c.assignments)).to.equal(false);
      expect(handle.bulkSetCalls.some((c) => c.baseNode === "/ch/30/dyn" && typeof c.assignments.peak === "number")).to.equal(true);
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_compress drives a Dual Dynamic EQ\'s band-1 "1-thr" (never plain "thr"), with no makeup gain (real "DEQ2")', async () => {
    // Channel 31 = mdl "DEQ2": no plain "thr", per-band "1-thr"/"2-thr" (dB). Band 1 is set to cut
    // ("1-g": -6). Simulate: more of the -6 dB signal is over 1-thr as it drops -> more reduction.
    // Real DEQ/DEQ2 report a band CUT with INVERTED sign (positive dynGain_dB — see
    // gainReductionScaleCorrection), so the fixture emits -reduction; the tool's -1 correction turns
    // it back into the negative reduction the search and makeup math expect.
    function currentThr1(): number {
      for (let i = handle.bulkSetCalls.length - 1; i >= 0; i--) {
        const c = handle.bulkSetCalls[i];
        if (c.baseNode === "/ch/31/dyn" && typeof c.assignments["1-thr"] === "number") return c.assignments["1-thr"] as number;
      }
      return -30;
    }
    function frame() {
      const reduction = -Math.max(0, -6 - currentThr1()) * 0.5;
      return {
        type: "channel",
        index: 31,
        inputL_dB: -6,
        inputR_dB: -6,
        outputL_dB: -6 + reduction,
        outputR_dB: -6 + reduction,
        gateKey_dB: -40,
        gateGain_dB: 0,
        dynKey_dB: -6,
        dynGain_dB: -reduction,
      };
    }
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame()] }), 20);
    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 31, block: "dyn", targetReductionDb: -8, sampleMs: 500, maxIterations: 8 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        model: string;
        control: { kind: string; key: string; unit: string };
        target: { converged: boolean };
        measured: { meanGainReductionDb: number };
        makeupGain: { applied: boolean };
        ack: { raw: string };
      };
      expect(structured.model).to.equal("DEQ2");
      expect(structured.control).to.include({ kind: "threshold", key: "1-thr", unit: "dB" });
      expect(structured.target.converged).to.equal(true);
      expect(structured.measured.meanGainReductionDb).to.be.closeTo(-8, 0.75);
      expect(structured.makeupGain.applied).to.equal(false);
      expect(structured.ack.raw).to.include("no makeup-gain field");
      const thr1Writes = handle.bulkSetCalls.filter((c) => c.baseNode === "/ch/31/dyn" && typeof c.assignments["1-thr"] === "number");
      expect(thr1Writes.length).to.be.greaterThan(0);
      expect(handle.bulkSetCalls.some((c) => c.baseNode === "/ch/31/dyn" && ("thr" in c.assignments || "gain" in c.assignments))).to.equal(false);
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_compress drives a one-knob compressor\'s unitless "gr" amount knob, scaled to its native range (real "ONEC")', async () => {
    // Channel 32 = mdl "ONEC": no threshold, unitless "gr" 0..10 that IS the reduction amount.
    function currentGr(): number {
      for (let i = handle.bulkSetCalls.length - 1; i >= 0; i--) {
        const c = handle.bulkSetCalls[i];
        if (c.baseNode === "/ch/32/dyn" && typeof c.assignments.gr === "number") return c.assignments.gr as number;
      }
      return 2;
    }
    function frame() {
      const reduction = -currentGr(); // 1 dB reduction per unit of gr (knob IS the amount)
      return {
        type: "channel",
        index: 32,
        inputL_dB: -8,
        inputR_dB: -8,
        outputL_dB: -8 + reduction,
        outputR_dB: -8 + reduction,
        gateKey_dB: -40,
        gateGain_dB: 0,
        dynKey_dB: -8,
        dynGain_dB: reduction,
      };
    }
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame()] }), 20);
    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 32, block: "dyn", targetReductionDb: -6, sampleMs: 500, maxIterations: 10 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        control: { kind: string; key: string; unit: string; old: number; new: number };
        target: { converged: boolean };
        measured: { meanGainReductionDb: number };
        makeupGain: { applied: boolean; old: number; new: number };
      };
      expect(structured.control).to.include({ kind: "input-gain", key: "gr", unit: "" });
      expect(structured.control.new).to.be.greaterThan(2); // gr driven UP for more reduction
      expect(structured.target.converged).to.equal(true);
      expect(structured.measured.meanGainReductionDb).to.be.closeTo(-6, 0.75);
      expect(structured.makeupGain.applied).to.equal(true);
      const grWrites = handle.bulkSetCalls
        .filter((c) => c.baseNode === "/ch/32/dyn" && typeof c.assignments.gr === "number")
        .map((c) => c.assignments.gr as number);
      expect(grWrites.length).to.be.greaterThan(0);
      // First step: error ~-4 dB, step 0.7 * 4 * (10/40) ≈ 0.7 units — not a jump across the whole 0..10 range.
      expect(Math.abs(grWrites[0] - 2)).to.be.lessThan(1.5);
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_compress sets a one-knob compressor\'s "comp" amount directly via inputGainDb (real "LMT")', async () => {
    const frame = {
      type: "channel",
      index: 33,
      inputL_dB: -8,
      inputR_dB: -8,
      outputL_dB: -11,
      outputR_dB: -11,
      gateKey_dB: -40,
      gateGain_dB: 0,
      dynKey_dB: -8,
      dynGain_dB: -3,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);
    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 33, block: "dyn", inputGainDb: 60, sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as { control: { kind: string; key: string; old: number; new: number } };
      expect(structured.control).to.deep.equal({ kind: "input-gain", key: "comp", old: 20, new: 60, unit: "" });
      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/ch/33/dyn", assignments: { comp: 60, on: 1 } });
      expect(handle.bulkSetCalls.some((c) => c.baseNode === "/ch/33/dyn" && "gain" in c.assignments)).to.equal(true);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress searches toward an unreachable target and gives up once a move stops changing anything measurable", async () => {
    const frame = {
      type: "channel",
      index: 25,
      inputL_dB: -10,
      inputR_dB: -12,
      outputL_dB: -16,
      outputR_dB: -18,
      gateKey_dB: -30,
      gateGain_dB: 0,
      dynKey_dB: -10,
      dynGain_dB: -6,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        // The fake meter always reports -6dB regardless of the threshold actually set, so a target
        // this far away can never be reached — every move produces no measurable change (still
        // -6dB either way). Each unresponsive streak now also grows the step size (to escape a
        // genuine dead zone faster — see AUTO_COMPRESS_TARGET_STEP_GROWTH), so the search escalates
        // all the way to the model's own thr boundary (0dB) before conceding there's nowhere left to
        // try, rather than giving up mid-range.
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 25, targetReductionDb: -30, sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        threshold: { old: number; new: number };
        target: { reductionDb: number; mode: string; converged: boolean; iterations: number; stopReason: string };
      };
      expect(structured.threshold).to.deep.equal({ old: -20, new: 0 });
      expect(structured.target).to.deep.equal({ reductionDb: -30, mode: "average", converged: false, iterations: 4, stopReason: "range-exhausted" });
      expect(handle.bulkSetCalls.filter((c) => c.baseNode === "/ch/25/dyn" && "thr" in c.assignments)).to.have.length(3);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress empirically detects and corrects the wrong search direction for a gate-type model", async () => {
    // A downward compressor reduces MORE as the threshold drops; a gate/expander is the opposite —
    // it reduces MORE as the threshold RISES (more of the signal falls below it). This simulates a
    // simple gate-style transfer function (fixed input level, attenuates by (threshold - input) once
    // input is below threshold) so the search's first move — which always assumes compressor-style
    // polarity — is provably wrong here, and only converges if it empirically detects that and flips.
    // Fixed well below the generic "/gate" fixture's starting thr (-40) so the gate is already
    // engaged at the start — moving the threshold further down (the wrong, compressor-assumed first
    // move) shallows the gating instead of deepening it, giving the empirical check something real
    // to detect as "worse".
    const inputLevel = -50;
    function currentThr(): number {
      for (let i = handle.bulkSetCalls.length - 1; i >= 0; i--) {
        const call = handle.bulkSetCalls[i];
        if (call.baseNode === "/ch/26/gate" && typeof call.assignments.thr === "number") return call.assignments.thr as number;
      }
      return -40; // the generic "/gate" fixture's starting thr
    }
    function frame() {
      const thr = currentThr();
      const reduction = inputLevel < thr ? -(thr - inputLevel) : 0;
      return {
        type: "channel",
        index: 26,
        inputL_dB: inputLevel,
        inputR_dB: inputLevel,
        outputL_dB: inputLevel + reduction,
        outputR_dB: inputLevel + reduction,
        gateKey_dB: inputLevel,
        gateGain_dB: reduction,
        dynKey_dB: -30,
        dynGain_dB: 0,
      };
    }
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame()] }), 20);

    try {
      const result = await client.callTool({
        // maxIterations is higher than the default here because flipping polarity now requires two
        // consecutive worsened readings, not one (verified live against real, non-stationary music:
        // a single worsened round can just be the program material's own loudness drifting between
        // sampling windows, not proof the assumed direction is wrong) — that costs one extra round
        // before the search corrects course.
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 26, block: "gate", targetReductionDb: -20, sampleMs: 500, maxIterations: 10 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        target: { converged: boolean; stopReason: string };
        measured: { meanGainReductionDb: number };
      };
      expect(structured.target.converged).to.equal(true);
      expect(structured.target.stopReason).to.equal("converged");
      expect(structured.measured.meanGainReductionDb).to.be.closeTo(-20, 0.75);

      const thrCalls = handle.bulkSetCalls
        .filter((c) => c.baseNode === "/ch/26/gate" && typeof c.assignments.thr === "number")
        .map((c) => c.assignments.thr as number);
      expect(thrCalls.length).to.be.greaterThan(1);
      // First move assumes compressor polarity and lowers the threshold — the wrong direction for a
      // gate, so it must eventually correct course by raising it again rather than drifting further down.
      expect(thrCalls[0]).to.be.lessThan(-40);
      expect(Math.max(...thrCalls.slice(1))).to.be.greaterThan(thrCalls[0]);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress probes the opposite direction when the very first move is already blocked by the model's own thr range", async () => {
    // Channel 21's gate fixture already starts at thr: 0 — the fixture's own thrMax (the "GATE"
    // model's describe() range is -80..0) — so the default compressor-assumed first move (which
    // would want to go even higher) is blocked before a single real measurement is ever taken.
    // Without the boundary-probe fallback this would report "range-exhausted" having learned
    // nothing; with it, the search tries the opposite direction once, discovers that's the right way
    // for this gate-style model, and converges normally. (mdl "GATE" also exercises the live
    // range-based 3x gain-reduction scale correction alongside the polarity fix — dividing by 3 here
    // so the simulated physics below lands on the intended real-dB numbers after that correction.)
    let liveThr = 0;
    const inputLevel = -50;
    function frame() {
      const reduction = inputLevel < liveThr ? -(liveThr - inputLevel) : 0;
      return {
        type: "channel",
        index: 21,
        inputL_dB: inputLevel,
        inputR_dB: inputLevel,
        outputL_dB: inputLevel + reduction,
        outputR_dB: inputLevel + reduction,
        gateKey_dB: inputLevel,
        gateGain_dB: reduction / 3,
        dynKey_dB: -30,
        dynGain_dB: 0,
      };
    }
    function currentThr(): number {
      for (let i = handle.bulkSetCalls.length - 1; i >= 0; i--) {
        const call = handle.bulkSetCalls[i];
        if (call.baseNode === "/ch/21/gate" && typeof call.assignments.thr === "number") return call.assignments.thr as number;
      }
      return 0;
    }
    const emitter = setInterval(() => {
      liveThr = currentThr();
      meterClient.emit("snapshot", { frames: [frame()] });
    }, 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 21, block: "gate", targetReductionDb: -5, sampleMs: 500, maxIterations: 6 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        target: { converged: boolean; stopReason: string };
        measured: { meanGainReductionDb: number };
      };
      expect(structured.target.converged).to.equal(true);
      expect(structured.target.stopReason).to.equal("converged");
      expect(structured.measured.meanGainReductionDb).to.be.closeTo(-5, 0.75);

      const thrCalls = handle.bulkSetCalls
        .filter((c) => c.baseNode === "/ch/21/gate" && typeof c.assignments.thr === "number")
        .map((c) => c.assignments.thr as number);
      expect(thrCalls.length).to.be.greaterThan(0);
      // The search's very first real move must go DOWN from the boundary (the corrected,
      // gate-appropriate direction) rather than reporting defeat having tried nothing.
      expect(thrCalls[0]).to.be.lessThan(0);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_compress does not flip polarity on a single noisy/content-driven worsened reading", async () => {
    // Found via live testing against real (non-stationary) music: on genuinely dynamic program
    // material, the signal's OWN loudness can drift between two ~1-2s sampling windows by more than
    // AUTO_COMPRESS_TARGET_FLAT_EPS regardless of which way the threshold just moved — which, on a
    // model that's actually a correctly-behaving downward compressor, can look exactly like a single
    // "worsened" round and used to trigger a spurious polarity flip that then fought the correct
    // direction for the rest of the search. This simulates a real compressor transfer function (more
    // reduction as the threshold drops) plus a one-off, threshold-independent "content got louder"
    // spike injected only during the second sampling round, then verifies the search still converges
    // using the original (correct) polarity — i.e. the threshold only ever moves in the sensible
    // range around the target, never plunges toward the opposite extreme the way an incorrect flip
    // would send it.
    const signalLevel = -5;
    function currentThr(): number {
      for (let i = handle.bulkSetCalls.length - 1; i >= 0; i--) {
        const call = handle.bulkSetCalls[i];
        if (call.baseNode === "/ch/27/dyn" && typeof call.assignments.thr === "number") return call.assignments.thr as number;
      }
      return -20; // the generic "/dyn" fixture's starting thr
    }
    function roundIndex(): number {
      return handle.bulkSetCalls.filter((c) => c.baseNode === "/ch/27/dyn" && typeof c.assignments.thr === "number").length;
    }
    function frame() {
      const thr = currentThr();
      let reduction = thr < signalLevel ? -(signalLevel - thr) * 0.5 : 0;
      if (roundIndex() === 1) reduction -= 6; // one-off content-driven spike, only during round 2
      return {
        type: "channel",
        index: 27,
        inputL_dB: signalLevel,
        inputR_dB: signalLevel,
        outputL_dB: signalLevel + reduction,
        outputR_dB: signalLevel + reduction,
        gateKey_dB: -40,
        gateGain_dB: 0,
        dynKey_dB: signalLevel,
        dynGain_dB: reduction,
      };
    }
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame()] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_compress",
        arguments: { type: "channel", index: 27, targetReductionDb: -6, sampleMs: 500, maxIterations: 8 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        target: { converged: boolean; stopReason: string };
        measured: { meanGainReductionDb: number };
      };
      expect(structured.target.converged).to.equal(true);
      expect(structured.target.stopReason).to.equal("converged");
      expect(structured.measured.meanGainReductionDb).to.be.closeTo(-6, 0.75);

      const thrCalls = handle.bulkSetCalls
        .filter((c) => c.baseNode === "/ch/27/dyn" && typeof c.assignments.thr === "number")
        .map((c) => c.assignments.thr as number);
      // A wrongly-triggered flip would send the threshold plunging toward the opposite extreme (well
      // past -30) chasing a "more reduction needed" reading that was actually just the injected spike
      // — instead every move should stay in the sensible neighborhood around the real target.
      for (const thr of thrCalls) {
        expect(thr).to.be.greaterThan(-25);
      }
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_gate measures the noise floor / signal peak and sets a threshold above the noise floor", async () => {
    // Cycles through mostly-quiet (key -50dB) samples with occasional loud (key -10dB) ones, so the
    // resulting distribution has a clear, predictable noise-floor/signal-peak split once sorted.
    let tick = 0;
    const emitter = setInterval(() => {
      const quiet = tick % 5 !== 0;
      tick++;
      meterClient.emit("snapshot", {
        frames: [
          {
            type: "channel",
            index: 23,
            inputL_dB: quiet ? -50 : -10,
            inputR_dB: quiet ? -50 : -10,
            outputL_dB: -20,
            outputR_dB: -20,
            gateKey_dB: quiet ? -50 : -10,
            gateGain_dB: 0,
            dynKey_dB: -30,
            dynGain_dB: 0,
          },
        ],
      });
    }, 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_gate",
        arguments: { type: "channel", index: 23, block: "gate", sampleMs: 500 },
      });
      expect(result.isError).to.not.equal(true);
      const structured = result.structuredContent as {
        measured: { noiseFloorDb: number; signalPeakDb: number; marginDb: number };
        threshold: { old: number; new: number; clamped: boolean };
      };
      expect(structured.measured.noiseFloorDb).to.equal(-50);
      expect(structured.measured.signalPeakDb).to.equal(-10);
      expect(structured.measured.marginDb).to.equal(6);
      // 6dB margin above the -50dB noise floor.
      expect(structured.threshold).to.deep.equal({ old: -40, new: -44, clamped: false });
      expect(handle.bulkSetCalls).to.deep.include({ baseNode: "/ch/23/gate", assignments: { thr: -44, on: 1 } });
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_gate fails clearly (nothing changed) when quiet/loud moments aren't clearly distinguishable", async () => {
    const frame = {
      type: "channel",
      index: 24,
      inputL_dB: -20,
      inputR_dB: -20,
      outputL_dB: -20,
      outputR_dB: -20,
      gateKey_dB: -20,
      gateGain_dB: 0,
      dynKey_dB: -20,
      dynGain_dB: 0,
    };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);

    try {
      const result = await client.callTool({
        name: "wing_auto_gate",
        arguments: { type: "channel", index: 24, block: "gate", sampleMs: 500 },
      });
      expect(result.isError).to.equal(true);
      const content = result.content as CallToolTextContent[];
      expect(content[0].text).to.include("didn't show a clear enough difference between quiet and loud moments");
      expect(handle.bulkSetCalls).to.have.length(0);
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_gate rejects a model with no "thr" field (e.g. real "76LA") instead of guessing', async () => {
    const result = await client.callTool({
      name: "wing_auto_gate",
      arguments: { type: "channel", index: 22, block: "dyn", sampleMs: 500 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("Model 76LA");
    expect(content[0].text).to.include('has no "thr" field');
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it('wing_auto_gate rejects block: "gate" on a bus/main/matrix strip', async () => {
    const result = await client.callTool({
      name: "wing_auto_gate",
      arguments: { type: "bus", index: 4, block: "gate" },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include('The "gate" slot only exists on channel strips');
  });

  it("wing_auto_gate fails clearly when no live meter data arrives at all", async () => {
    const result = await client.callTool({
      name: "wing_auto_gate",
      arguments: { type: "channel", index: 25, block: "gate", sampleMs: 500 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("No live meter data was received");
  });

  it('wing_auto_gain mode: "gain" rejects a strip with no physical input routed, as a tool-visible error', async () => {
    // Channel 31 has no in/conn/grp|in GET_FIXTURES entry, so the fake client's default (branch)
    // reply makes resolvePhysicalSource() report "not routed" — same as source OFF on real hardware.
    const result = await client.callTool({
      name: "wing_auto_gain",
      arguments: { type: "channel", index: 31, mode: "gain" },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("no physical input routed");
    expect(handle.bulkSetCalls).to.deep.equal([]);
  });

  it('wing_auto_gain mode: "both" adjusts the physical input\'s preamp gain to reach targetDb exactly, leaving trim at 0', async () => {
    // Channel 5's GET_FIXTURES already simulate a routed physical input (group "A", index 3) for the
    // wing_channel_set_name source-linking tests — reused here for the same routing shape.
    const frame = { type: "channel", index: 5, inputL_dB: -18, inputR_dB: -18 };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);
    try {
      const result = await client.callTool({
        name: "wing_auto_gain",
        arguments: { type: "channel", index: 5, mode: "both", targetDb: -18 },
      });
      expect(result.isError).to.not.equal(true);
      // Trim zeroed before sampling, then the physical input's gain field ("g") bulk-set once the
      // measured peak already matches targetDb exactly (delta 0) — no clamping, so trim is never
      // touched a second time.
      expect(handle.bulkSetCalls).to.deep.equal([
        { baseNode: "/ch/5/in/set", assignments: { trim: 0 } },
        { baseNode: "/io/in/A/3", assignments: { g: 0 } },
      ]);
      const structured = result.structuredContent as {
        physicalSource: { group: string; index: number };
        gain: { oldValue: number; newValue: number; clamped: boolean };
        trim: unknown;
        trimLeftAtZero: boolean;
      };
      expect(structured.physicalSource).to.deep.equal({ group: "A", index: 3 });
      expect(structured.gain).to.include({ oldValue: 0, newValue: 0, clamped: false });
      expect(structured.trim).to.equal(null);
      expect(structured.trimLeftAtZero).to.equal(true);
    } finally {
      clearInterval(emitter);
    }
  });

  it('wing_auto_gain mode: "both" adjusts trim directly when the strip has no physical input to gain-stage', async () => {
    const frame = { type: "channel", index: 30, inputL_dB: -24, inputR_dB: -24 };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);
    try {
      const result = await client.callTool({
        name: "wing_auto_gain",
        arguments: { type: "channel", index: 30, mode: "both", targetDb: -18 },
      });
      expect(result.isError).to.not.equal(true);
      // No physical source -> gain stage skipped entirely; trim raised by the full +6dB delta
      // (targetDb -18 minus measured peak -24), on the strip's own /ch/30/in/set node.
      expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/30/in/set", assignments: { trim: 6 } }]);
      const structured = result.structuredContent as {
        physicalSource: null;
        gain: null;
        trim: { oldValue: number; newValue: number; clamped: boolean };
      };
      expect(structured.physicalSource).to.equal(null);
      expect(structured.gain).to.equal(null);
      expect(structured.trim).to.include({ oldValue: 0, newValue: 6, clamped: false });
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_auto_gain restores the original trim and fails clearly when no signal is present on the physical input", async () => {
    // Silent frame at the meter's digital floor (verified live, see AUTOGAIN_NO_SIGNAL_FLOOR_DB's
    // doc) — the gain stage should bail out before writing anything to the physical input, and the
    // trim it zeroed before sampling must be restored to what it was, not left at 0.
    const frame = { type: "channel", index: 5, inputL_dB: -128, inputR_dB: -128 };
    const emitter = setInterval(() => meterClient.emit("snapshot", { frames: [frame] }), 20);
    try {
      const result = await client.callTool({
        name: "wing_auto_gain",
        arguments: { type: "channel", index: 5, mode: "both" },
      });
      expect(result.isError).to.equal(true);
      const content = result.content as CallToolTextContent[];
      expect(content[0].text).to.include("No signal detected");
      // Zeroed before sampling, then restored to its pre-attempt value (0, the fake's default) once
      // runAutoGain threw — never left sitting at 0 as a side effect of a failed attempt, and the
      // physical input's own gain field is never touched at all.
      expect(handle.bulkSetCalls).to.deep.equal([
        { baseNode: "/ch/5/in/set", assignments: { trim: 0 } },
        { baseNode: "/ch/5/in/set", assignments: { trim: 0 } },
      ]);
    } finally {
      clearInterval(emitter);
    }
  });

  it("wing_usb_player_status reads USB/play/rec state in one call", async () => {
    const result = await client.callTool({ name: "wing_usb_player_status", arguments: {} });
    expect(result.isError).to.not.equal(true);
    const structured = result.structuredContent as {
      usb: { state: string; volumeName: string };
      play: { state: string; song: string; repeat: boolean; songs: { index: number; name: string }[] };
      rec: { state: string };
    };
    expect(structured.usb).to.deep.equal({ state: "ATTACHED", volumeName: "USBDRIVE" });
    expect(structured.play.state).to.equal("PLAY");
    expect(structured.play.song).to.equal("Song1");
    expect(structured.play.repeat).to.equal(false);
    // 1-based indexing verified against real hardware: $songs[0] -> index 1, matching $actionidx's
    // own 1-based convention (unlike $ctl/lib's 0-based $actidx for scenes).
    expect(structured.play.songs).to.deep.equal([
      { index: 1, name: "Song1" },
      { index: 2, name: "Song2" },
      { index: 3, name: "Song3" },
    ]);
    expect(structured.rec.state).to.equal("STOP");
  });

  it("wing_usb_play selecting a track by index sends $actionidx + $action=PLAY together", async () => {
    const result = await client.callTool({
      name: "wing_usb_play",
      arguments: { action: "PLAY", index: 2 },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/play", assignments: { $action: "PLAY", $actionidx: 2 } }]);
  });

  it("wing_usb_play PLAYFILE requires a file path", async () => {
    const result = await client.callTool({
      name: "wing_usb_play",
      arguments: { action: "PLAYFILE" },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("PLAYFILE requires a `file` path");
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_usb_play PLAYFILE with a file sends $playfile + $action", async () => {
    const result = await client.callTool({
      name: "wing_usb_play",
      arguments: { action: "PLAYFILE", file: "/USB/track.wav" },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/play", assignments: { $action: "PLAYFILE", $playfile: "/USB/track.wav" } }]);
  });

  it("wing_usb_record drives the recorder transport", async () => {
    const result = await client.callTool({
      name: "wing_usb_record",
      arguments: { action: "REC" },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/rec", assignments: { $action: "REC" } }]);
  });

  it("wing_usb_set_repeat writes the repeat flag on /play", async () => {
    const result = await client.callTool({
      name: "wing_usb_set_repeat",
      arguments: { on: true },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/play", assignments: { repeat: 1 } }]);
  });

  it("wing_get_insert reads pre-insert status (no mode/w fields)", async () => {
    const result = await client.callTool({
      name: "wing_get_insert",
      arguments: { type: "channel", index: 1, slot: "pre" },
    });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      type: "channel",
      index: 1,
      slot: "pre",
      on: true,
      fx: "FX2",
      status: "OK",
    });
  });

  it("wing_get_insert reads post-insert status including mode/w", async () => {
    const result = await client.callTool({
      name: "wing_get_insert",
      arguments: { type: "channel", index: 1, slot: "post" },
    });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      type: "channel",
      index: 1,
      slot: "post",
      on: false,
      fx: "NONE",
      mode: "FX",
      w: 0,
      status: "OK",
    });
  });

  it("wing_get_insert rejects slot: \"post\" on an aux strip (no post-insert stage)", async () => {
    const result = await client.callTool({
      name: "wing_get_insert",
      arguments: { type: "aux", index: 1, slot: "post" },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("Aux strips have no post-insert stage");
  });

  it("wing_set_insert turns on pre-insert and patches an FX slot", async () => {
    const result = await client.callTool({
      name: "wing_set_insert",
      arguments: { type: "channel", index: 3, slot: "pre", on: true, fx: "FX3" },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/3/preins", assignments: { on: 1, ins: "FX3" } }]);
  });

  it("wing_set_insert sets post-insert mode and wet/dry mix", async () => {
    const result = await client.callTool({
      name: "wing_set_insert",
      arguments: { type: "bus", index: 2, slot: "post", mode: "AUTO_X", w: 3 },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/bus/2/postins", assignments: { mode: "AUTO_X", w: 3 } }]);
  });

  it("wing_set_insert rejects mode/w on pre-insert (those fields only exist on post-insert)", async () => {
    const result = await client.callTool({
      name: "wing_set_insert",
      arguments: { type: "channel", index: 3, slot: "pre", mode: "FX" },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include('no "mode"/"w" fields');
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_set_insert rejects slot: \"post\" on an aux strip", async () => {
    const result = await client.callTool({
      name: "wing_set_insert",
      arguments: { type: "aux", index: 1, slot: "post", on: true },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("Aux strips have no post-insert stage");
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_get_processing_block reads EQ on-state for a channel", async () => {
    const result = await client.callTool({
      name: "wing_get_processing_block",
      arguments: { type: "channel", index: 1, block: "eq" },
    });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({ type: "channel", index: 1, block: "eq", on: true });
  });

  it("wing_get_processing_block reads Gate off-state for a channel", async () => {
    const result = await client.callTool({
      name: "wing_get_processing_block",
      arguments: { type: "channel", index: 1, block: "gate" },
    });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({ type: "channel", index: 1, block: "gate", on: false });
  });

  it('wing_get_processing_block rejects block: "gate" on a bus (no gate stage outside channel)', async () => {
    const result = await client.callTool({
      name: "wing_get_processing_block",
      arguments: { type: "bus", index: 2, block: "gate" },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include('"gate" block only exists on channel strips');
  });

  it("wing_set_processing_block turns EQ on for a channel", async () => {
    const result = await client.callTool({
      name: "wing_set_processing_block",
      arguments: { type: "channel", index: 4, block: "eq", on: true },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/4/eq", assignments: { on: 1 } }]);
  });

  it("wing_set_processing_block turns Dynamics off for a bus", async () => {
    const result = await client.callTool({
      name: "wing_set_processing_block",
      arguments: { type: "bus", index: 3, block: "dyn", on: false },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/bus/3/dyn", assignments: { on: 0 } }]);
  });

  it('wing_set_processing_block rejects block: "gate" on an aux (no gate stage outside channel)', async () => {
    const result = await client.callTool({
      name: "wing_set_processing_block",
      arguments: { type: "aux", index: 1, block: "gate", on: true },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include('"gate" block only exists on channel strips');
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_channel_get_proc reads the current G/E/D/I processing order", async () => {
    const result = await client.callTool({ name: "wing_channel_get_proc", arguments: { channel: 1 } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({ channel: 1, order: "GEDI" });
  });

  it("wing_channel_set_proc bulk-sets a valid permutation", async () => {
    const result = await client.callTool({
      name: "wing_channel_set_proc",
      arguments: { channel: 4, order: "EDGI" },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/4", assignments: { proc: "EDGI" } }]);
  });

  it("wing_channel_set_proc rejects an invalid permutation before touching the console", async () => {
    const result = await client.callTool({
      name: "wing_channel_set_proc",
      // Not a member of the fixed 24-permutation enum — Zod should reject this at the tool
      // boundary, the same way the input schema rejects any other out-of-enum string.
      arguments: { channel: 4, order: "GGGG" },
    });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_get_input_patch reads Main + Alt sources and which is active", async () => {
    const result = await client.callTool({ name: "wing_get_input_patch", arguments: { type: "channel", index: 1 } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      type: "channel",
      index: 1,
      main: { group: "A", index: 3 },
      alt: { group: "B", index: 5 },
      altActive: false,
      srcAuto: false,
    });
  });

  it("wing_get_input_patch rejects a strip type with no physical input", async () => {
    const result = await client.callTool({ name: "wing_get_input_patch", arguments: { type: "bus", index: 1 } });
    expect(result.isError).to.equal(true);
  });

  it("wing_set_input_connection bulk-sets the Main slot", async () => {
    const result = await client.callTool({
      name: "wing_set_input_connection",
      arguments: { type: "channel", index: 4, slot: "main", grp: "USB", in: 2 },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/4/in/conn", assignments: { grp: "USB", in: 2 } }]);
  });

  it("wing_set_input_connection bulk-sets the Alt slot", async () => {
    const result = await client.callTool({
      name: "wing_set_input_connection",
      arguments: { type: "aux", index: 2, slot: "alt", grp: "B", in: 6 },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/aux/2/in/conn", assignments: { altgrp: "B", altin: 6 } }]);
  });

  it("wing_set_alt_source_active switches a strip to its Alt source", async () => {
    const result = await client.callTool({
      name: "wing_set_alt_source_active",
      arguments: { type: "aux", index: 2, active: true },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/aux/2/in/set", assignments: { altsrc: 1 } }]);
  });

  it("wing_set_srcauto links a channel's name/customization to its source", async () => {
    const result = await client.callTool({
      name: "wing_set_srcauto",
      arguments: { type: "channel", index: 1, linked: true },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/1", assignments: { clink: 1 } }]);
  });

  it("wing_set_srcauto unlinks a strip's name/customization from its source", async () => {
    const result = await client.callTool({
      name: "wing_set_srcauto",
      arguments: { type: "aux", index: 2, linked: false },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/aux/2", assignments: { clink: 0 } }]);
  });

  it("wing_set_srcauto rejects a strip type with no physical input", async () => {
    const result = await client.callTool({
      name: "wing_set_srcauto",
      arguments: { type: "bus", index: 1, linked: true },
    });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_get_global_alt_switch reads the console-wide switch and auto-override flag", async () => {
    const result = await client.callTool({ name: "wing_get_global_alt_switch", arguments: {} });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({ on: false, autoOverride: true });
  });

  it("wing_set_global_alt_switch bulk-sets only the provided fields", async () => {
    const result = await client.callTool({ name: "wing_set_global_alt_switch", arguments: { on: true } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/io", assignments: { altsw: 1 } }]);
  });

  it("wing_set_global_alt_switch rejects an empty request before touching the console", async () => {
    const result = await client.callTool({ name: "wing_set_global_alt_switch", arguments: {} });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_get_link_status reads AES50 A/B/C and StageConnect status in one grouped call", async () => {
    const result = await client.callTool({ name: "wing_get_link_status", arguments: {} });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      ports: [
        { port: "A", state: "OK", device: "WING-A1", errorsCorrected: 3, errorsUncorrected: 0, remoteName: "FOH1" },
        { port: "B", state: "-", device: "", errorsCorrected: 0, errorsUncorrected: 0, remoteName: "" },
        { port: "C", state: "ERR", device: "WING-C1", errorsCorrected: 12, errorsUncorrected: 2, remoteName: "MON1" },
      ],
      stageConnect: { status: "OK", devices: "SC-1", upstreamCount: 1, downstreamCount: 2 },
    });
  });

  it("wing_clear_link_errors resets one AES50 port's error counters", async () => {
    const result = await client.callTool({ name: "wing_clear_link_errors", arguments: { port: "C" } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/$stat/C", assignments: { clrerr: 1 } }]);
    expect(result.structuredContent).to.deep.equal({
      port: "C",
      ack: { status: "OK", ok: true, raw: "OK" },
    });
  });

  it("wing_clear_link_errors rejects an unknown port before touching the console", async () => {
    const result = await client.callTool({ name: "wing_clear_link_errors", arguments: { port: "D" } });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_save_to_flash issues exactly one bulk-set write, no retry", async () => {
    const result = await client.callTool({ name: "wing_save_to_flash", arguments: {} });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/$ctl/$globals", assignments: { $savenow: 1 } }]);
    expect(result.structuredContent).to.deep.equal({ ack: { status: "OK", ok: true, raw: "OK" } });
  });

  it("wing_get_autosave_config reads the inverted $noautosave switch", async () => {
    const result = await client.callTool({ name: "wing_get_autosave_config", arguments: {} });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({ enabled: true });
  });

  it("wing_set_autosave_config writes the inverted $noautosave switch", async () => {
    const result = await client.callTool({ name: "wing_set_autosave_config", arguments: { enabled: false } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/$ctl/$globals", assignments: { $noautosave: 1 } }]);
    expect(result.structuredContent).to.deep.equal({
      enabled: false,
      ack: { status: "OK", ok: true, raw: "OK" },
    });
  });

  it("wing_get_selected_strip decodes the raw selidx with the documented +1 GET off-by-one", async () => {
    const result = await client.callTool({ name: "wing_get_selected_strip", arguments: {} });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      rawIndex: 6,
      strip: { type: "channel", index: 7 },
    });
  });

  it("wing_set_selected_strip encodes type+index into the 1..76 SET convention", async () => {
    const result = await client.callTool({
      name: "wing_set_selected_strip",
      arguments: { type: "bus", index: 3 },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/$ctl/$stat", assignments: { selidx: 51 } }]);
    expect(result.structuredContent).to.deep.equal({
      strip: { type: "bus", index: 3 },
      writtenIndex: 51,
      ack: { status: "OK", ok: true, raw: "OK" },
    });
  });

  it("wing_set_selected_strip rejects an out-of-range index as a tool-visible error", async () => {
    const result = await client.callTool({
      name: "wing_set_selected_strip",
      arguments: { type: "main", index: 9 },
    });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_get_delay reads a channel's delay via the in/set/dly* shape", async () => {
    const result = await client.callTool({ name: "wing_get_delay", arguments: { type: "channel", index: 1 } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      type: "channel",
      index: 1,
      on: true,
      mode: "MS",
      value: 12.5,
    });
  });

  it("wing_get_delay reads a bus's delay via the separate dly/* node", async () => {
    const result = await client.callTool({ name: "wing_get_delay", arguments: { type: "bus", index: 1 } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      type: "bus",
      index: 1,
      on: false,
      mode: "M",
      value: 3,
    });
  });

  it("wing_set_delay writes only the provided fields under the channel's in/set/dly* shape", async () => {
    const result = await client.callTool({
      name: "wing_set_delay",
      arguments: { type: "channel", index: 1, on: true, mode: "MS", value: 20 },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([
      { baseNode: "/ch/1/in/set", assignments: { dlyon: 1, dlymode: "MS", dly: 20 } },
    ]);
    expect(result.structuredContent).to.deep.equal({
      type: "channel",
      index: 1,
      ack: { status: "OK", ok: true, raw: "OK" },
    });
  });

  it("wing_set_delay writes to the bus's separate dly/* node", async () => {
    const result = await client.callTool({
      name: "wing_set_delay",
      arguments: { type: "bus", index: 1, on: true },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/bus/1/dly", assignments: { on: 1 } }]);
  });

  it("wing_set_delay rejects a call with none of on/mode/value set", async () => {
    const result = await client.callTool({ name: "wing_set_delay", arguments: { type: "channel", index: 1 } });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_get_wlive_status reports a reachable slot 1 and an unreachable slot 2", async () => {
    const result = await client.callTool({ name: "wing_get_wlive_status", arguments: {} });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      installed: true,
      cardType: "WLIVE",
      global: {
        sdlink: "PAR",
        actLink: "IND",
        battState: "GOOD",
        autoIn: "1",
        meters: true,
        autoStop: "KEEP",
        autoPlay: "MAIN",
        autoRec: "ALT",
      },
      cards: [
        {
          card: 1,
          reachable: true,
          state: "PLAY",
          etimeMs: 12345,
          sdFreeMs: 36000000,
          sdSizeGb: 128,
          sdState: "READY",
          sessions: 3,
          markers: 2,
          sessionLenMs: 600000,
          sessionPos: 5,
          markerPos: 1,
          tracks: "32",
          rate: "48",
          linkedPos: 0,
          startMs: 1000,
          stopMs: 599000,
          errorMessage: "",
          errorCode: 0,
          recTracks: "32",
          playMode: "PLAY",
        },
        {
          card: 2,
          reachable: false,
          state: "UNKNOWN",
          etimeMs: 0,
          sdFreeMs: 0,
          sdSizeGb: 0,
          sdState: "NONE",
          sessions: 0,
          markers: 0,
          sessionLenMs: 0,
          sessionPos: 0,
          markerPos: 0,
          tracks: "",
          rate: "",
          linkedPos: 0,
          startMs: 0,
          stopMs: 0,
          errorMessage: "",
          errorCode: 0,
          recTracks: "",
          playMode: "",
        },
      ],
    });
  });

  it("wing_wlive_transport bulk-sets the transport action on the right slot", async () => {
    const result = await client.callTool({ name: "wing_wlive_transport", arguments: { card: 1, action: "PLAY" } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/cards/wlive/1/$ctl", assignments: { control: "PLAY" } }]);
  });

  it("wing_wlive_transport rejects an invalid card slot before touching the console", async () => {
    const result = await client.callTool({ name: "wing_wlive_transport", arguments: { card: 3, action: "PLAY" } });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_wlive_session opens a session with the given index", async () => {
    const result = await client.callTool({
      name: "wing_wlive_session",
      arguments: { card: 2, action: "open", sessionIndex: 5 },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/cards/wlive/2/$ctl", assignments: { opensession: 5 } }]);
  });

  it("wing_wlive_session rejects open without a sessionIndex", async () => {
    const result = await client.callTool({ name: "wing_wlive_session", arguments: { card: 1, action: "open" } });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_wlive_marker seeks by writing stime and gotomarker=101 together", async () => {
    const result = await client.callTool({
      name: "wing_wlive_marker",
      arguments: { card: 1, action: "seek", timeMs: 30000 },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/cards/wlive/1/$ctl", assignments: { stime: 30000, gotomarker: 101 } }]);
  });

  it("wing_wlive_marker sets a marker at the current position with no extra fields", async () => {
    const result = await client.callTool({ name: "wing_wlive_marker", arguments: { card: 1, action: "set" } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/cards/wlive/1/$ctl", assignments: { setmarker: 1 } }]);
  });

  it("wing_wlive_marker edits a marker by index", async () => {
    const result = await client.callTool({ name: "wing_wlive_marker", arguments: { card: 1, action: "edit", markerIndex: 5 } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/cards/wlive/1/$ctl", assignments: { editmarker: 5 } }]);
  });

  it("wing_wlive_marker jumps to a marker by index (goto)", async () => {
    const result = await client.callTool({ name: "wing_wlive_marker", arguments: { card: 1, action: "goto", markerIndex: 3 } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/cards/wlive/1/$ctl", assignments: { gotomarker: 3 } }]);
  });

  it("wing_wlive_marker deletes a marker by index", async () => {
    const result = await client.callTool({ name: "wing_wlive_marker", arguments: { card: 1, action: "delete", markerIndex: 2 } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/cards/wlive/1/$ctl", assignments: { deletemarker: 2 } }]);
  });

  // markerIndex 101/negative/missing are also rejected one layer up by this tool's own zod schema
  // (min(0).max(100).optional()), so they never reach manageWLiveMarker's own requireMarkerIndex
  // through this MCP surface — see wing-live.test.ts for direct unit tests of that business logic
  // (and of the REST route at POST /wlive/:card/marker, which has no such schema and so is the one
  // surface where requireMarkerIndex's own bounds check is actually reachable).

  it("wing_wlive_format_sd_card writes formatsdcard to the given slot", async () => {
    const result = await client.callTool({ name: "wing_wlive_format_sd_card", arguments: { card: 2 } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/cards/wlive/2/$ctl", assignments: { formatsdcard: 1 } }]);
  });

  it("wing_get_matrix_direct_input reads on/level/invert/source in one dump", async () => {
    const result = await client.callTool({ name: "wing_get_matrix_direct_input", arguments: { index: 1 } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      index: 1,
      on: true,
      levelDb: -6,
      invert: false,
      input: "AES",
    });
  });

  it("wing_set_matrix_direct_input writes only the provided fields", async () => {
    const result = await client.callTool({
      name: "wing_set_matrix_direct_input",
      arguments: { index: 1, on: true, input: "MON.BUS" },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/mtx/1/dir", assignments: { on: 1, in: "MON.BUS" } }]);
    expect(result.structuredContent).to.deep.equal({
      index: 1,
      ack: { status: "OK", ok: true, raw: "OK" },
    });
  });

  it("wing_set_matrix_direct_input rejects a call with no fields set", async () => {
    const result = await client.callTool({ name: "wing_set_matrix_direct_input", arguments: { index: 1 } });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_store_value then wing_restore_value round-trips the checkpointed value", async () => {
    const stored = await client.callTool({ name: "wing_store_value", arguments: { path: "/ch/1/fdr" } });
    expect(stored.isError).to.not.equal(true);
    expect(stored.structuredContent).to.deep.equal({ path: "/ch/1/fdr", value: -6 });

    const restored = await client.callTool({ name: "wing_restore_value", arguments: { path: "/ch/1/fdr" } });
    expect(restored.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/1", assignments: { fdr: -6 } }]);
    expect(restored.structuredContent).to.deep.equal({
      path: "/ch/1/fdr",
      value: -6,
      ack: { status: "OK", ok: true, raw: "OK" },
    });
  });

  it("wing_restore_value rejects a path with no prior wing_store_value call", async () => {
    const result = await client.callTool({ name: "wing_restore_value", arguments: { path: "/ch/6/fdr" } });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_adjust_value_by_delta clamps to the console's own describe()-reported range", async () => {
    const result = await client.callTool({ name: "wing_adjust_value_by_delta", arguments: { path: "/ch/2/fdr", delta: -200 } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/2", assignments: { fdr: -144 } }]);
    expect(result.structuredContent).to.deep.equal({
      path: "/ch/2/fdr",
      oldValue: 0,
      newValue: -144,
      clamped: true,
      ack: { status: "OK", ok: true, raw: "OK" },
    });
  });

  it("wing_adjust_value_by_delta clamps to the console's own describe()-reported MAXIMUM", async () => {
    const result = await client.callTool({ name: "wing_adjust_value_by_delta", arguments: { path: "/ch/10/fdr", delta: 20 } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/10", assignments: { fdr: 10 } }]);
    expect(result.structuredContent).to.deep.equal({
      path: "/ch/10/fdr",
      oldValue: 5,
      newValue: 10,
      clamped: true,
      ack: { status: "OK", ok: true, raw: "OK" },
    });
  });

  it("wing_adjust_value_by_delta then wing_undo_last_adjust reverts exactly one step", async () => {
    const adjusted = await client.callTool({ name: "wing_adjust_value_by_delta", arguments: { path: "/ch/3/fdr", delta: 5 } });
    expect(adjusted.isError).to.not.equal(true);
    expect(adjusted.structuredContent).to.deep.equal({
      path: "/ch/3/fdr",
      oldValue: -6,
      newValue: -1,
      clamped: false,
      ack: { status: "OK", ok: true, raw: "OK" },
    });

    const undone = await client.callTool({ name: "wing_undo_last_adjust", arguments: { path: "/ch/3/fdr" } });
    expect(undone.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([
      { baseNode: "/ch/3", assignments: { fdr: -1 } },
      { baseNode: "/ch/3", assignments: { fdr: -6 } },
    ]);
    expect(undone.structuredContent).to.deep.equal({
      path: "/ch/3/fdr",
      value: -6,
      ack: { status: "OK", ok: true, raw: "OK" },
    });
  });

  it("wing_undo_last_adjust rejects a path with no prior wing_adjust_value_by_delta call", async () => {
    const result = await client.callTool({ name: "wing_undo_last_adjust", arguments: { path: "/ch/7/fdr" } });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_restore_value goes back to the ORIGINAL checkpoint even after an intervening wing_adjust_value_by_delta", async () => {
    // Regression: storeValue and adjustValueByDelta used to share one map field, so the adjust
    // silently overwrote the stored checkpoint and restoreValue became a same-value no-op instead
    // of undoing the adjust too.
    const stored = await client.callTool({ name: "wing_store_value", arguments: { path: "/ch/8/fdr" } });
    expect(stored.structuredContent).to.deep.equal({ path: "/ch/8/fdr", value: -6 });

    const adjusted = await client.callTool({ name: "wing_adjust_value_by_delta", arguments: { path: "/ch/8/fdr", delta: 5 } });
    expect(adjusted.structuredContent).to.deep.equal({
      path: "/ch/8/fdr",
      oldValue: -6,
      newValue: -1,
      clamped: false,
      ack: { status: "OK", ok: true, raw: "OK" },
    });

    const restored = await client.callTool({ name: "wing_restore_value", arguments: { path: "/ch/8/fdr" } });
    expect(restored.structuredContent).to.deep.equal({
      path: "/ch/8/fdr",
      value: -6,
      ack: { status: "OK", ok: true, raw: "OK" },
    });
    expect(handle.bulkSetCalls.at(-1)).to.deep.equal({ baseNode: "/ch/8", assignments: { fdr: -6 } });
  });

  it("wing_undo_last_adjust rejects a path that was only wing_store_value'd, never adjusted", async () => {
    // Regression: storeValue and adjustValueByDelta used to write the identical map shape, so undo
    // couldn't tell a store-only checkpoint from a real adjustment and would "undo" one that never
    // happened.
    const stored = await client.callTool({ name: "wing_store_value", arguments: { path: "/ch/9/fdr" } });
    expect(stored.isError).to.not.equal(true);

    const result = await client.callTool({ name: "wing_undo_last_adjust", arguments: { path: "/ch/9/fdr" } });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_get_rta_source decodes the raw rtasrc index into a strip type + index", async () => {
    const result = await client.callTool({ name: "wing_get_rta_source" });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      rawIndex: 7,
      source: { type: "channel", index: 7 },
      tap: "PREEQ",
    });
  });

  it("wing_set_rta_source encodes type+index into rtasrc and bulk-sets it with the optional tap", async () => {
    const result = await client.callTool({
      name: "wing_set_rta_source",
      arguments: { type: "bus", index: 3, tap: "POST" },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/cfg/rta", assignments: { rtasrc: 51, rtatap: "POST" } }]);
    expect(result.structuredContent).to.deep.equal({
      type: "bus",
      index: 3,
      rawIndex: 51,
      tap: "POST",
      status: "OK",
      ok: true,
      raw: "OK",
    });
  });

  it("wing_set_rta_source without a tap only writes rtasrc", async () => {
    const result = await client.callTool({
      name: "wing_set_rta_source",
      arguments: { type: "matrix", index: 1 },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/cfg/rta", assignments: { rtasrc: 69 } }]);
  });

  it("wing_set_rta_source rejects an out-of-range index as a tool-visible error", async () => {
    const result = await client.callTool({
      name: "wing_set_rta_source",
      arguments: { type: "main", index: 9 },
    });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("out of range");
  });

  it("wing_get_talkback reads global assign plus both sources' status and destinations", async () => {
    const result = await client.callTool({ name: "wing_get_talkback", arguments: {} });
    expect(result.isError).to.not.equal(true);
    const structured = result.structuredContent as { a: { destinations: { bus: boolean[]; mtx: boolean[]; main: boolean[] } } };
    expect(structured).to.include({ assign: "CH40", levelDb: 0 });
    expect(structured.a).to.deep.include({ on: true, mode: "AUTO", mondim: 20, busdim: 10, indiv: false });
    expect(structured.a.destinations.bus[0]).to.equal(true);
    expect(structured.a.destinations.bus[1]).to.equal(false);
    expect(structured.a.destinations.main[0]).to.equal(true);
    expect((result.structuredContent as { b: { on: boolean; mode: string; indiv: boolean } }).b).to.include({
      on: false,
      mode: "PUSH",
      indiv: true,
    });
  });

  it("wing_set_talkback_assign writes the global assign field", async () => {
    const result = await client.callTool({ name: "wing_set_talkback_assign", arguments: { assign: "AUX8" } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/cfg/talk", assignments: { assign: "AUX8" } }]);
  });

  it("wing_set_talkback_source writes only the provided fields under the source's node", async () => {
    const result = await client.callTool({
      name: "wing_set_talkback_source",
      arguments: { source: "A", on: true, mode: "LATCH" },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/cfg/talk/A", assignments: { $on: 1, mode: "LATCH" } }]);
  });

  it("wing_set_talkback_source rejects a call with no fields set", async () => {
    const result = await client.callTool({ name: "wing_set_talkback_source", arguments: { source: "B" } });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_set_talkback_destination bulk-sets the single destination bit", async () => {
    const result = await client.callTool({
      name: "wing_set_talkback_destination",
      arguments: { source: "B", type: "mtx", index: 3, on: true },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/cfg/talk/B", assignments: { MX3: 1 } }]);
  });

  it("wing_set_talkback_destination rejects an out-of-range index", async () => {
    const result = await client.callTool({
      name: "wing_set_talkback_destination",
      arguments: { source: "A", type: "main", index: 5, on: true },
    });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_get_gpio with no index reads the status of all 4 GPIOs", async () => {
    const result = await client.callTool({ name: "wing_get_gpio", arguments: {} });
    expect(result.isError).to.not.equal(true);
    const structured = result.structuredContent as { gpios: { index: number; mode: string; state: boolean; gpstate: boolean }[] };
    expect(structured.gpios).to.have.length(4);
    expect(structured.gpios[0]).to.deep.include({ index: 1, mode: "OUTNC", state: true, gpstate: true });
    expect(structured.gpios[1]).to.deep.include({ index: 2, mode: "TGLNO", state: false, gpstate: false });
  });

  it("wing_get_gpio with an index reads a single GPIO's status", async () => {
    const result = await client.callTool({ name: "wing_get_gpio", arguments: { index: 1 } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.include({ index: 1, mode: "OUTNC", state: true, gpstate: true });
  });

  it("wing_get_gpio rejects an out-of-range index", async () => {
    const result = await client.callTool({ name: "wing_get_gpio", arguments: { index: 5 } });
    expect(result.isError).to.equal(true);
  });

  it("wing_set_gpio_mode writes the mode field", async () => {
    const result = await client.callTool({ name: "wing_set_gpio_mode", arguments: { index: 2, mode: "OUTNO" } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/$ctl/gpio/2", assignments: { mode: "OUTNO" } }]);
  });

  it("wing_set_gpio_state writes the gpstate field", async () => {
    const result = await client.callTool({ name: "wing_set_gpio_state", arguments: { index: 1, on: false } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/$ctl/gpio/1", assignments: { gpstate: 0 } }]);
  });

  it("wing_set_gpio_state rejects an out-of-range index", async () => {
    const result = await client.callTool({ name: "wing_set_gpio_state", arguments: { index: 0, on: true } });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_get_lighting reads all 11 zones", async () => {
    const result = await client.callTool({ name: "wing_get_lighting", arguments: {} });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      btns: 80,
      leds: 60,
      meters: 100,
      rgbleds: 70,
      chlcds: 50,
      chlcdctr: 40,
      chedit: 65,
      main: 90,
      glow: 20,
      patch: 30,
      lamp: 10,
    });
  });

  it("wing_set_lighting writes only the provided zones", async () => {
    const result = await client.callTool({ name: "wing_set_lighting", arguments: { glow: 50, lamp: 0 } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/$ctl/cfg/lights", assignments: { glow: 50, lamp: 0 } }]);
  });

  it("wing_set_lighting rejects a value below a zone's firmware floor", async () => {
    const result = await client.callTool({ name: "wing_set_lighting", arguments: { leds: 2 } });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_set_lighting rejects an empty call", async () => {
    const result = await client.callTool({ name: "wing_set_lighting", arguments: {} });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_get_scribble reads led/col/icon and resolves their names", async () => {
    const result = await client.callTool({ name: "wing_get_scribble", arguments: { type: "channel", index: 1 } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      type: "channel",
      index: 1,
      led: 1,
      col: 4,
      colorName: "Turquoise",
      icon: 101,
      iconName: "Micro main à boule",
    });
  });

  it("wing_set_scribble writes only the provided fields", async () => {
    const result = await client.callTool({ name: "wing_set_scribble", arguments: { type: "dca", index: 3, col: 9, icon: 200 } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/dca/3", assignments: { col: 9, icon: 200 } }]);
  });

  it("wing_set_scribble rejects mutegroup (no scribble/color/icon field exists there)", async () => {
    const result = await client.callTool({ name: "wing_set_scribble", arguments: { type: "mutegroup", index: 1, led: 1 } });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_set_scribble rejects an empty call", async () => {
    const result = await client.callTool({ name: "wing_set_scribble", arguments: { type: "channel", index: 1 } });
    expect(result.isError).to.equal(true);
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_get_source reads a physical input's identity + preamp, decoding col via display", async () => {
    const result = await client.callTool({ name: "wing_get_source", arguments: { group: "B", index: 2 } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      group: "B",
      index: 2,
      name: "Guitar",
      col: 5,
      colorName: "Green",
      icon: 300,
      iconName: "Guitare électrique",
      gain: 12,
      phantom48v: true,
      polarityInverted: false,
      mute: false,
    });
  });

  it("wing_set_source bulk-sets only the provided fields, mapped to the /io/in leaf names", async () => {
    const result = await client.callTool({
      name: "wing_set_source",
      arguments: {
        group: "B",
        index: 2,
        name: "Gtr",
        col: 9,
        icon: 310,
        gain: -3,
        phantom48v: false,
        polarityInverted: true,
        mute: true,
      },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([
      { baseNode: "/io/in/B/2", assignments: { name: "Gtr", col: 9, icon: 310, g: -3, vph: 0, pol: 1, mute: 1 } },
    ]);
  });

  it("wing_set_source passes an unknown group straight through to the console (no client-side enum)", async () => {
    const result = await client.callTool({ name: "wing_set_source", arguments: { group: "ZZ", index: 1, mute: true } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/io/in/ZZ/1", assignments: { mute: 1 } }]);
  });

  it("wing_set_source rejects a call with no fields as a tool-visible error, without writing", async () => {
    const result = await client.callTool({ name: "wing_set_source", arguments: { group: "B", index: 2 } });
    expect(result.isError).to.equal(true);
    const content = result.content as CallToolTextContent[];
    expect(content[0].text).to.include("At least one of");
    expect(handle.bulkSetCalls).to.have.length(0);
  });

  it("wing_get_plugin_model looks up a model by exact id", async () => {
    const result = await client.callTool({ name: "wing_get_plugin_model", arguments: { id: "76LA" } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      models: [
        {
          id: "76LA",
          category: "dynamics",
          name: "76 Limiter Amp",
          emulates: "UREI/Universal Audio 1176 FET Compressor",
          shortDescription:
            "Very fast FET attack/release, punchy and aggressive; timing knobs are reversed (1=slowest, 7=fastest).",
          goodFor: ["drums", "vocals", "bass", "parallel compression"],
        },
      ],
    });
  });

  it("wing_get_plugin_model returns every disjoint match for an id reused across categories", async () => {
    const result = await client.callTool({ name: "wing_get_plugin_model", arguments: { id: "E88" } });
    expect(result.isError).to.not.equal(true);
    const models = (result.structuredContent as { models: { category: string }[] }).models;
    expect(models.map((m) => m.category)).to.deep.equal(["dynamics", "eq", "fx"]);
  });

  it("wing_get_plugin_model rejects an unknown id", async () => {
    const result = await client.callTool({ name: "wing_get_plugin_model", arguments: { id: "NOPE" } });
    expect(result.isError).to.equal(true);
  });

  it("wing_get_plugin_model lists a whole category", async () => {
    const result = await client.callTool({ name: "wing_get_plugin_model", arguments: { category: "eq" } });
    expect(result.isError).to.not.equal(true);
    const { models } = result.structuredContent as { models: { id: string }[] };
    expect(models).to.have.length(7);
    expect(models.map((m) => m.id)).to.include("PULSAR");
  });

  it("wing_get_plugin_model lists the fx category with 63 models across three tiers", async () => {
    const result = await client.callTool({ name: "wing_get_plugin_model", arguments: { category: "fx" } });
    expect(result.isError).to.not.equal(true);
    const { models } = result.structuredContent as { models: { id: string; fxTier?: string }[] };
    expect(models).to.have.length(63);
    expect(models.filter((m) => m.fxTier === "premium")).to.have.length(26);
    expect(models.filter((m) => m.fxTier === "standard")).to.have.length(26);
    expect(models.filter((m) => m.fxTier === "channel")).to.have.length(11);
    expect(models.map((m) => m.id)).to.include.members(["HALL", "GEQ", "*MASTER*"]);
  });

  it("wing_get_plugin_model distinguishes Stereo Chorus and Stereo Flanger by id", async () => {
    const chorus = await client.callTool({ name: "wing_get_plugin_model", arguments: { id: "CHORUS" } });
    const flanger = await client.callTool({ name: "wing_get_plugin_model", arguments: { id: "FLANGER" } });
    expect((chorus.structuredContent as { models: { name: string }[] }).models[0]?.name).to.equal("Stereo Chorus");
    expect((flanger.structuredContent as { models: { name: string }[] }).models[0]?.name).to.equal("Stereo Flanger");
  });

  it("wing_get_plugin_model with no arguments returns the full catalog as a terse summary", async () => {
    const result = await client.callTool({ name: "wing_get_plugin_model", arguments: {} });
    expect(result.isError).to.not.equal(true);
    const { models } = result.structuredContent as { models: { id: string; category: string; name: string }[] };
    expect(models).to.have.length(102);
    expect(Object.keys(models[0]!)).to.deep.equal(["id", "category", "name"]);
  });

  it("wing_list_plugins_by_usage finds models tagged for a given use case", async () => {
    const result = await client.callTool({ name: "wing_list_plugins_by_usage", arguments: { usage: "de-essing" } });
    expect(result.isError).to.not.equal(true);
    const { models } = result.structuredContent as { models: { id: string }[] };
    expect(models.map((m) => m.id)).to.include.members(["DS902", "DEQ"]);
  });

  it("wing_list_plugins_by_usage finds FX models tagged for a given use case", async () => {
    const result = await client.callTool({ name: "wing_list_plugins_by_usage", arguments: { usage: "vintage character" } });
    expect(result.isError).to.not.equal(true);
    const { models } = result.structuredContent as { models: { id: string }[] };
    expect(models.map((m) => m.id)).to.include.members(["V-ROOM", "TAPE-DL"]);
  });

  it("wing_list_plugins_by_usage returns an empty (non-error) list for an unmatched usage", async () => {
    const result = await client.callTool({
      name: "wing_list_plugins_by_usage",
      arguments: { usage: "underwater didgeridoo" },
    });
    expect(result.isError).to.not.equal(true);
    const { models } = result.structuredContent as { models: unknown[] };
    expect(models).to.have.length(0);
  });

  it("wing_get_strip_solo reads solo/led/solosafe/presolo for a channel", async () => {
    const result = await client.callTool({ name: "wing_get_strip_solo", arguments: { type: "channel", index: 1 } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      type: "channel",
      index: 1,
      solo: true,
      soloLed: 2,
      soloSafe: false,
      preSolo: false,
    });
  });

  it("wing_get_strip_solo omits soloSafe/presolo for a strip type that has neither", async () => {
    const result = await client.callTool({ name: "wing_get_strip_solo", arguments: { type: "dca", index: 1 } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({ type: "dca", index: 1, solo: false, soloLed: 0 });
  });

  it("wing_set_strip_solo writes the solo switch", async () => {
    const result = await client.callTool({ name: "wing_set_strip_solo", arguments: { type: "channel", index: 1, solo: false } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/ch/1", assignments: { $solo: 0 } }]);
  });

  it("wing_set_strip_solo rejects soloSafe on a strip type without that field", async () => {
    const result = await client.callTool({ name: "wing_set_strip_solo", arguments: { type: "bus", index: 1, soloSafe: true } });
    expect(result.isError).to.equal(true);
  });

  it("wing_set_strip_solo rejects an empty call", async () => {
    const result = await client.callTool({ name: "wing_set_strip_solo", arguments: { type: "channel", index: 1 } });
    expect(result.isError).to.equal(true);
  });

  it("wing_get_solo_config reads the global solo config", async () => {
    const result = await client.callTool({ name: "wing_get_solo_config", arguments: {} });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      mode: "LIVE",
      monitor: "PH+SPK",
      mute: false,
      dim: true,
      mono: false,
      flip: false,
      channelTap: "PFL",
      busTap: "AFL",
      mainTap: "PFL",
      matrixTap: "PFL",
      sourceSoloAssign: "OFF",
      sourceSoloOn: false,
      sourceSoloGroup: 1,
      sourceSoloIn: 1,
    });
  });

  it("wing_set_solo_config writes only the provided fields", async () => {
    const result = await client.callTool({ name: "wing_set_solo_config", arguments: { mode: "STUDIO", dim: false } });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/cfg/solo", assignments: { mode: "STUDIO", $dim: 0 } }]);
  });

  it("wing_set_solo_config rejects an empty call", async () => {
    const result = await client.callTool({ name: "wing_set_solo_config", arguments: {} });
    expect(result.isError).to.equal(true);
  });

  it("wing_get_monitor_bus reads monitor bus 1 (Monitor A)", async () => {
    const result = await client.callTool({ name: "wing_get_monitor_bus", arguments: { bus: 1 } });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      bus: 1,
      levelDb: -10,
      levelReadOnly: true,
      invert: false,
      pan: 0,
      width: 100,
      limiterDb: -6,
      delayOn: true,
      delayMeters: 3.5,
      dimLevelDb: 20,
      pflDimDb: 15,
      bandSoloTrimDb: 6,
      sourceLevelDb: -3,
      sourceMixDb: 0,
      source: "MAIN.1",
      directIn: "OFF",
      faderLevelDb: -10,
      tags: "MonA",
    });
  });

  it("wing_get_monitor_bus reads monitor bus 2 (Monitor B): distinct fields, and a settable (non-read-only) level since it has no physical knob in this fixture", async () => {
    const result = await client.callTool({ name: "wing_get_monitor_bus", arguments: { bus: 2 } });
    expect(result.isError).to.not.equal(true);
    const status = result.structuredContent as { bus: number; source: string; directIn: string; levelDb: number; levelReadOnly: boolean };
    expect(status.bus).to.equal(2);
    expect(status.source).to.equal("OFF");
    expect(status.directIn).to.equal("CH.5");
    expect(status.levelDb).to.equal(-144);
    expect(status.levelReadOnly).to.equal(false);
  });

  it("wing_set_monitor_bus writes only the provided fields, including a nested delay field alongside top-level ones", async () => {
    const result = await client.callTool({
      name: "wing_set_monitor_bus",
      arguments: { bus: 1, source: "BUS.3", delayOn: false },
    });
    expect(result.isError).to.not.equal(true);
    expect(handle.bulkSetCalls).to.deep.equal([{ baseNode: "/cfg/mon/1", assignments: { src: "BUS.3", "dly.on": 0 } }]);
  });

  it("wing_set_monitor_bus rejects an out-of-range field", async () => {
    const result = await client.callTool({ name: "wing_set_monitor_bus", arguments: { bus: 1, pan: 500 } });
    expect(result.isError).to.equal(true);
  });

  it("wing_set_monitor_bus rejects an empty call", async () => {
    const result = await client.callTool({ name: "wing_set_monitor_bus", arguments: { bus: 1 } });
    expect(result.isError).to.equal(true);
  });

  it("wing_get_osc_mirror_status reports the mirror as off before it's ever configured", async () => {
    const result = await client.callTool({ name: "wing_get_osc_mirror_status", arguments: {} });
    expect(result.isError).to.not.equal(true);
    expect(result.structuredContent).to.deep.equal({
      enabled: false,
      host: "",
      port: 0,
      messagesSent: 0,
      bytesSent: 0,
      lastError: null,
    });
  });

  it("wing_set_osc_mirror enables the shared oscMirror instance on ctx, visible to wing_get_osc_mirror_status", async () => {
    const setResult = await client.callTool({
      name: "wing_set_osc_mirror",
      arguments: { enabled: true, host: "192.168.1.50", port: 9000 },
    });
    expect(setResult.isError).to.not.equal(true);
    expect(setResult.structuredContent).to.deep.include({ enabled: true, host: "192.168.1.50", port: 9000 });
    expect(oscMirror.getStatus()).to.deep.include({ enabled: true, host: "192.168.1.50", port: 9000 });

    const getResult = await client.callTool({ name: "wing_get_osc_mirror_status", arguments: {} });
    expect(getResult.structuredContent).to.deep.include({ enabled: true, host: "192.168.1.50", port: 9000 });
  });

  it("wing_set_osc_mirror rejects enabling without a host configured yet", async () => {
    const result = await client.callTool({ name: "wing_set_osc_mirror", arguments: { enabled: true, port: 9000 } });
    expect(result.isError).to.equal(true);
  });

  it("wing_set_osc_mirror rejects an empty call", async () => {
    const result = await client.callTool({ name: "wing_set_osc_mirror", arguments: {} });
    expect(result.isError).to.equal(true);
  });
});
