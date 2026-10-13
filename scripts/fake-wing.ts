// A fake WING console for working on the dashboard without the real desk: a named, coloured
// 40-channel show with EQ/gate/dynamics, scenes, a USB player, and live metering + RTA that follow
// the faders and mutes you move. Built on the tests' WingMockServer (OSC control plane) plus a
// small metering server speaking the binary protocol of wing-meter-protocol.ts (TCP + UDP).
//
// Run via `npm run fake-wing`, then point the server at it (WING_HOST=127.0.0.1, default ports):
//
//   npm run fake-wing            # one terminal
//   WING_HOST=127.0.0.1 npm run dev   # another
//
// Ports follow the server's own env vars: WING_OSC_PORT (2223), WING_DISCOVERY_PORT (2222, UDP) and
// WING_METER_TCP_PORT (2222, TCP). Nothing here is used by the server or the tests themselves.

/* eslint-disable no-bitwise -- the metering protocol is a bit-packed binary format. */
import dgram from "node:dgram";
import net from "node:net";
import readline from "node:readline";
import { WingMockServer } from "../test/plugins/wing/wing-mock-server.js";
import { METER_GROUP_TABLE, TOKEN_COLLECTION_END, TOKEN_COLLECTION_START, TOKEN_REPORT_ID, TOKEN_UDP_PORT, WingChannelDemuxer } from "../src/plugins/wing/wing-meter-protocol.js";
import type { MeterGroupType } from "../src/plugins/wing/wing-meter-types.js";

const OSC_PORT = Number(process.env.WING_OSC_PORT ?? 2223);
const DISCOVERY_PORT = Number(process.env.WING_DISCOVERY_PORT ?? 2222);
const METER_TCP_PORT = Number(process.env.WING_METER_TCP_PORT ?? 2222);
const METER_CHANNEL_ID = 3;
const METER_INTERVAL_MS = 50;

// --- the show -----------------------------------------------------------------------------------

const CHANNELS: [name: string, color: number, levelDb: number][] = [
  ["Kick In", 9, -12], ["Kick Out", 9, -14], ["Snare Top", 15, -16], ["Snare Bot", 15, -22], ["Hi-Hat", 13, -26],
  ["Tom 1", 8, -30], ["Tom 2", 8, -30], ["Floor Tom", 8, -28], ["OH L", 7, -24], ["OH R", 7, -24],
  ["Bass DI", 3, -14], ["Bass Amp", 3, -16], ["Gtr Elec", 5, -18], ["Gtr Acou", 6, -20], ["Keys L", 12, -20],
  ["Keys R", 12, -20], ["Synth", 11, -22], ["Pad", 11, -26], ["Vox Lead", 2, -12], ["Vox BV1", 14, -18],
  ["Vox BV2", 14, -18], ["Vox BV3", 14, -20], ["Pastor", 1, -14], ["Choir L", 4, -22], ["Choir R", 4, -22],
  ["Click", 17, -10], ["Track L", 10, -16], ["Track R", 10, -16], ["Ambient L", 16, -32], ["Ambient R", 16, -32],
];
// The console icon of each named channel, from the WING icon grid (see ICON_CATEGORIES in the web app).
const CHANNEL_ICONS = [
  200, 201, 202, 203, 205, 206, 207, 209, 211, 212, 300, 501, 300, 304, 401, 401, 405, 402, 100, 113, 113, 114, 105, 112, 112,
  602, 606, 606, 109, 109,
];
const CHANNEL_COUNT = 40;
const AUXES = ["USB 1/2", "USB 3/4", "Playback", "Talkback", "", "", "", ""];
const AUX_ICONS = [608, 608, 606, 603];
const BUSES = ["Mon Drums", "Mon Bass", "Mon Gtr", "Mon Keys", "Mon Vox", "IEM 1", "IEM 2", "IEM 3", "Drum Bus", "Vox Bus", "Rev Hall", "Rev Plate", "Delay", "", "Stream L", "Stream R"];
const MAINS = ["Main LR", "Sub", "Fill", "Lobby"];
const BUS_ICONS = [520, 522, 521, 522, 520, 602, 602, 602, 210, 112, 6, 6, 6, 0, 605, 605];
const MAIN_ICONS = [519, 506, 503, 524];
const MATRIX_ICONS = [609, 104];
const MATRICES = ["Record", "Broadcast", "", "", "", "", "", ""];
const DCAS = ["Drums", "Bass", "Guitars", "Keys", "Vocals", "FX", "Band", "Speech", "", "", "", "", "", "", "", ""];
const MUTEGROUPS = ["All Mics", "Band", "Vocals", "FX", "", "", "", ""];
const SCENES = ["Welcome", "Worship Set 1", "Sermon", "Worship Set 2", "Closing"];
const SONGS = ["01 Intro.wav", "02 Walk-in loop.wav", "03 Countdown.wav", "04 Offering.wav", "05 Outro.wav"];

// A channel EQ as the node tree documents it (docs/wing-protocol/05-node-tree/channel.md).
const EQ_DESCRIBE = [
  "on int [0 .. 1]", "mdl list [STD, SOUL, E88, E84, F110, PULSAR, MACH4]", "mix lin [0.0 .. 125.0 %], 126 steps",
  "lg lin [-15.0 .. +15.0 dB], 301 steps", "lf log [20.0 .. 20k00 Hz], 961 steps", "lq log [0.44 .. 10.0], 100 steps", "leq list [PEQ, SHV]",
  ...[1, 2, 3, 4].flatMap((n) => [`${n}g lin [-15.0 .. +15.0 dB], 301 steps`, `${n}f log [20.0 .. 20k00 Hz], 961 steps`, `${n}q log [0.44 .. 10.0], 100 steps`]),
  "hg lin [-15.0 .. +15.0 dB], 301 steps", "hf log [20.0 .. 20k00 Hz], 961 steps", "hq log [0.44 .. 10.0], 100 steps", "heq list [PEQ, SHV]",
];
const EQ_VALUES: Record<string, number | string> = {
  on: 1, mdl: "STD", mix: 100, lg: 3, lf: 90, lq: 0.7, leq: "SHV",
  "1g": -4, "1f": 320, "1q": 1.6, "2g": 0, "2f": 900, "2q": 1, "3g": 2.5, "3f": 3200, "3q": 1.2, "4g": -2, "4f": 7500, "4q": 3,
  hg: 2, hf: 11000, hq: 0.7, heq: "SHV",
};
const GATE_DESCRIBE = [
  "on int [0 .. 1]", "mdl list [GATE, DUCK, E88, 9000G, D241, DS902, WAVE, DEQ, WARM, 76LA, LA, RIDE, PSE, CMB]",
  "thr lin [-80.0 .. 0.0 dB], 161 steps", "range lin [3.0 .. 60.0 dB], 115 steps", "att lin [0.0 .. 120.0 ms], 121 steps",
  "hld log [1.0 .. 2k000 ms], 100 steps", "rel log [4.0 .. 4k000 ms], 100 steps",
];
const GATE_VALUES: Record<string, number | string> = { on: 1, mdl: "GATE", thr: -42, range: 30, att: 5, hld: 40, rel: 180 };
const DYN_DESCRIBE = [
  "on int [0 .. 1]", "mdl list [COMP, EXP, B160, B560, D241, ECL33, 9000C, SBUS, RED3, 76LA, LA, F670, BLISS, NSTR, WAVE, RIDE, 2250, L100, CMB]",
  "mix lin [0.0 .. 100.0 %], 101 steps", "gain lin [-6.0 .. 12.0 dB], 37 steps", "thr lin [-60.0 .. 0.0 dB], 121 steps",
  "ratio list [1.1, 1.2, 1.3, 1.5, 1.7, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 8.0, 10, 20, 50, 100]",
  "knee int [0 .. 5]", "att lin [0.0 .. 120.0 ms], 121 steps", "rel log [4.0 .. 4k000 ms], 100 steps",
];
const DYN_VALUES: Record<string, number | string> = { on: 1, mdl: "COMP", mix: 100, gain: 3, thr: -18, ratio: "4.0", knee: 2, att: 10, rel: 120 };

// FX slots: a few reverbs and a delay loaded, the rest empty. One describe serves every slot here;
// on the console the parameter list follows the loaded model.
const FX_DESCRIBE = [
  "mdl list [NONE, HALL, ROOM, PLATE, CHAMBER, DELAY, CHORUS, FLANGER, PCORR, GEQ]",
  "fxmix lin [0.0 .. 100.0 %], 101 steps",
  // The Hall reverb's parameters, as the protocol reference lists them.
  "pdel int [0 .. 200]",
  "size int [0 .. 100]",
  "dcy log [0.2 .. 5.0 s], 101 steps",
  "mult log [0.5 .. 2.0], 101 steps",
  "damp log [1k000 .. 20k000 Hz], 51 steps",
  "lc log [20.0 .. 400.0 Hz], 51 steps",
  "hc log [200.0 .. 20k000 Hz], 51 steps",
];
const FX_SLOTS: Record<number, string> = { 1: "HALL", 2: "PLATE", 3: "DELAY", 4: "ROOM" };

// DCA (#Dn) and mute group (#Mn) membership lives in each strip's tags, as on the console.
// DCAs: 1 Drums, 2 Bass, 3 Guitars, 4 Keys, 5 Vocals, 8 Speech. Mute groups: 1 All Mics, 2 Band, 3 Vocals.
const CHANNEL_TAGS: Record<number, string> = {
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [n, "#D1,#M1,#M2"])),
  11: "#D2,#M2", 12: "#D2,#M2", 13: "#D3,#M2", 14: "#D3,#M2",
  15: "#D4,#M2", 16: "#D4,#M2", 17: "#D4,#M2", 18: "#D4,#M2",
  19: "#D5,#M1,#M3", 20: "#D5,#M1,#M3", 21: "#D5,#M1,#M3", 22: "#D5,#M1,#M3",
  23: "#D8,#M1", 24: "#M1", 25: "#M1",
};

const mock = new WingMockServer({ port: OSC_PORT, discoveryPort: DISCOVERY_PORT, applyPlainSets: true, answerUnknownAddresses: true });

/** Switches, enums and indices are ints on the console; levels, frequencies and times are floats. */
const INT_KEY = /\/(on|mute|col|icon|clink|knee|repeat|usbstate|in|altin|altsrc|solosafe|inv|\$act\w*|\$activeid|\$dim|\$mono|\$flip|\$srcsolo|\$srcsgrp|\$srcsin)$/;

function leaf(path: string, value: number | string): void {
  mock.defineLeaf(path, typeof value === "string" ? "s" : INT_KEY.test(path) ? "i" : "f", value);
}

function strip(base: string, name: string, color: number, fader: number, muted = false, icon = 0): void {
  leaf(`${base}/name`, name);
  leaf(`${base}/col`, color);
  leaf(`${base}/icon`, icon);
  leaf(`${base}/fdr`, fader);
  leaf(`${base}/mute`, muted ? 1 : 0);
}

function block(base: string, values: Record<string, number | string>): void {
  for (const [key, value] of Object.entries(values)) leaf(`${base}/${key}`, value);
}

for (let n = 1; n <= CHANNEL_COUNT; n++) {
  const [name, color] = CHANNELS[n - 1] ?? ["", 17];
  strip(`/ch/${n}`, name, color, name ? -5 - ((n * 7) % 11) : -144, n === 7 || n === 14, CHANNEL_ICONS[n - 1] ?? 0);
  leaf(`/ch/${n}/pan`, name.endsWith(" L") ? -60 : name.endsWith(" R") ? 60 : 0);
  leaf(`/ch/${n}/clink`, 0);
  leaf(`/ch/${n}/proc`, "GEDI");
  leaf(`/ch/${n}/tags`, CHANNEL_TAGS[n] ?? "");
  // Click and the pastor's mic stay audible through a solo in place.
  leaf(`/ch/${n}/solosafe`, n === 23 || n === 26 ? 1 : 0);
  // Patched from the stage box's local inputs, which carry the same names.
  block(`/ch/${n}/in/conn`, { grp: "LCL", in: n, altgrp: "OFF", altin: 1 });
  leaf(`/ch/${n}/in/set/altsrc`, 0);
  block(`/io/in/LCL/${n}`, { name: name, col: color, icon: 0, mute: 0 });
  block(`/ch/${n}/eq`, EQ_VALUES);
  block(`/ch/${n}/gate`, { ...GATE_VALUES, on: n <= 8 ? 1 : 0 });
  block(`/ch/${n}/dyn`, { ...DYN_VALUES, on: name ? 1 : 0 });
}
AUXES.forEach((name, i) => {
  strip(`/aux/${i + 1}`, name, 10, name ? -10 : -144, false, AUX_ICONS[i] ?? 0);
  leaf(`/aux/${i + 1}/pan`, 0);
  block(`/aux/${i + 1}/eq`, EQ_VALUES);
  block(`/aux/${i + 1}/dyn`, DYN_VALUES);
});
for (const [prefix, names, color, fader, icons] of [
  ["/bus", BUSES, 13, -4, BUS_ICONS],
  ["/main", MAINS, 18, -2, MAIN_ICONS],
  ["/mtx", MATRICES, 4, -6, MATRIX_ICONS],
] as const) {
  names.forEach((name, i) => {
    strip(`${prefix}/${i + 1}`, name, color, name ? fader : -144, false, (icons as readonly number[])[i] ?? 0);
    block(`${prefix}/${i + 1}/eq`, EQ_VALUES);
    block(`${prefix}/${i + 1}/dyn`, DYN_VALUES);
  });
}
DCAS.forEach((name, i) => strip(`/dca/${i + 1}`, name, 2, name ? 0 : -144));
MUTEGROUPS.forEach((name, i) => {
  leaf(`/mgrp/${i + 1}/name`, name);
  leaf(`/mgrp/${i + 1}/mute`, 0);
});

mock.defineDescribe(/^\/(ch|aux|bus|main|mtx)\/\d+\/eq$/, EQ_DESCRIBE);
mock.defineDescribe(/^\/(ch|aux)\/\d+\/gate$/, GATE_DESCRIBE);
mock.defineDescribe(/^\/(ch|aux|bus|main|mtx)\/\d+\/dyn$/, DYN_DESCRIBE);
mock.defineDescribe(/^\/fx\/\d+$/, FX_DESCRIBE);
for (let n = 1; n <= 16; n++) {
  block(`/fx/${n}`, { mdl: FX_SLOTS[n] ?? "NONE", fxmix: 100, pdel: 20, size: 60, dcy: n === 2 ? 1.4 : 2.2, mult: 1, damp: 8000, lc: 100, hc: 8000 });
}
// Solo behaviour and the two control-room monitor buses (wing-solo-monitor.ts). The "$" fields are
// read one by one on the console, never in a dump.
block("/cfg/solo", { mode: "LIVE", mon: "PH", mute: 0, chtap: "PFL", bustap: "AFL", maintap: "AFL", mtxtap: "AFL", srcsolo: "OFF" });
block("/cfg/solo", { $dim: 0, $mono: 0, $flip: 0, $srcsolo: 0, $srcsgrp: 1, $srcsin: 1 });
for (const bus of [1, 2]) {
  block(`/cfg/mon/${bus}`, {
    inv: 0, pan: 0, wid: 100, lim: 0, dim: 20, pfldim: 10, eqbdtrim: 6,
    srclvl: 0, srcmix: -144, src: bus === 1 ? "MAIN.1" : "BUS.6", dirin: "OFF", tags: "",
  });
  block(`/cfg/mon/${bus}/dly`, { on: 0, m: 10 });
  leaf(`/cfg/mon/${bus}/$lvlact`, -10);
}
leaf("/cfg/mon/1/$lvl", -12); // Monitor A follows its knob; B's level is plain and settable.
leaf("/cfg/mon/2/lvl", -6);
// Every strip's solo switch, off; the dashboard reads them all, then follows the pushes.
for (const [prefix, count] of [["/ch", CHANNEL_COUNT], ["/aux", 8], ["/bus", 16], ["/main", 4], ["/mtx", 8], ["/dca", 16]] as const) {
  for (let n = 1; n <= count; n++) mock.defineLeaf(`${prefix}/${n}/$solo`, "i", 0);
}
// The effect returns (buses 11–13) sit in DCA 6 "FX" and mute group 4 "FX".
for (const n of [11, 12, 13]) leaf(`/bus/${n}/tags`, "#D6,#M4");
// A strip's input patch: the source group is an enum on the console (the I/O tab's Source picker).
const SOURCE_GROUP_LIST = "OFF, LCL, AUX, A, B, C, SC, USB, CRD, MOD, PLAY, AES, USR, OSC, BUS, MAIN, MTX";
mock.defineDescribe(/^\/(ch|aux)\/\d+\/in\/conn$/, [
  `grp list [${SOURCE_GROUP_LIST}]`,
  "in int [1 .. 64]",
  `altgrp list [${SOURCE_GROUP_LIST}]`,
  "altin int [1 .. 64]",
]);

// Scenes: the list is only reachable by describing the parent branch, as on hardware (wing-scenes.ts).
mock.defineDescribe("/$ctl/lib", [`$scenes list [${SCENES.join(", ")}]`, "$actidx int [0 .. 999]"]);
block("/$ctl/lib", { $actidx: 2, $active: SCENES[2], $actshow: "Sunday Service", $activeid: 3, $action: "", $actionidx: 0, $actionid: 0 });

// USB player / recorder (wing-usb-player.ts).
mock.defineDescribe("/play", [`$songs list [${SONGS.join(", ")}]`]);
block("/$stat", { usbstate: "MOUNTED", usbvolname: "SUNDAY" });
block("/play", {
  $actstate: "STOP", $actidx: 1, $actfile: SONGS[0], $song: "Intro", $album: "Sunday Service", $artist: "Worship Team",
  $pos: 0, $total: 214, $resolution: "24", $channels: "2", $rate: "48", $format: "WAV", repeat: 0, $action: "", $actionidx: 0, $playfile: "",
});
block("/rec", { $actstate: "STOP", $actfile: "", $path: "/REC", $time: 0, resolution: "24", channels: "2", $action: "" });

// The bulk-set "actions" (scene GO/NEXT/PREV, player PLAY/STOP…) only store a value here; this
// loop turns them into the state change the console would make.
setInterval(() => {
  const sceneAction = mock.getParam("/$ctl/lib/$action");
  if (sceneAction) {
    const current = Number(mock.getParam("/$ctl/lib/$actidx") ?? 0);
    const target =
      sceneAction === "NEXT" ? current + 1 : sceneAction === "PREV" ? current - 1 : Number(mock.getParam("/$ctl/lib/$actionidx") ?? current);
    const index = Math.max(0, Math.min(SCENES.length - 1, target));
    mock.setParam("/$ctl/lib/$actidx", index);
    mock.setParam("/$ctl/lib/$active", SCENES[index]);
    mock.setParam("/$ctl/lib/$action", "");
  }
  const playAction = mock.getParam("/play/$action");
  if (playAction) {
    const state = playAction === "PAUSE" ? "PAUSE" : playAction === "STOP" ? "STOP" : "PLAY";
    const idx = Number(mock.getParam("/play/$actionidx") || mock.getParam("/play/$actidx") || 1);
    const next = playAction === "NEXT" ? idx + 1 : playAction === "PREV" ? idx - 1 : idx;
    const track = Math.max(1, Math.min(SONGS.length, next));
    mock.setParam("/play/$actidx", track);
    mock.setParam("/play/$actfile", SONGS[track - 1]);
    mock.setParam("/play/$song", SONGS[track - 1].replace(/^\d+ |\.wav$/g, ""));
    mock.setParam("/play/$actstate", state);
    if (playAction === "STOP") mock.setParam("/play/$pos", 0);
    mock.setParam("/play/$action", "");
    mock.setParam("/play/$actionidx", 0);
  }
  if (mock.getParam("/play/$actstate") === "PLAY") {
    mock.setParam("/play/$pos", (Number(mock.getParam("/play/$pos")) + 0.25) % 214);
  }
  const recAction = mock.getParam("/rec/$action");
  if (recAction) {
    mock.setParam("/rec/$actstate", recAction === "REC" ? "REC" : recAction === "PAUSE" ? "PAUSE" : "STOP");
    if (recAction === "NEWFILE" || recAction === "REC") mock.setParam("/rec/$actfile", `REC_${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.wav`);
    mock.setParam("/rec/$action", "");
  }
  if (mock.getParam("/rec/$actstate") === "REC") mock.setParam("/rec/$time", Number(mock.getParam("/rec/$time")) + 0.25);
}, 250).unref();

// --- metering -----------------------------------------------------------------------------------

/** What a channel's source is playing right now, in dBFS: drums hit on the beat, the rest breathe. */
function sourceLevelDb(index: number, t: number): number {
  const [name, , level] = CHANNELS[index - 1] ?? ["", 0, -90];
  if (!name) return -90 + Math.random() * 4;
  const beat = (t * 2) % 1; // 120 BPM
  if (/Kick|Snare|Tom/.test(name)) {
    const onBeat = name.startsWith("Snare") ? Math.abs(beat - 0.5) : beat;
    return level - Math.min(40, onBeat * 60) + Math.random() * 2;
  }
  if (name === "Click") return beat < 0.05 ? level : -90;
  const phrase = Math.sin(t * 0.7 + index) * 0.5 + 0.5;
  return level - 12 * (1 - phrase) + Math.sin(t * 9 + index * 3) * 2 + Math.random() * 1.5;
}

function stripOutputDb(path: string, inputDb: number): number {
  if (Number(mock.getParam(`${path}/mute`)) === 1) return -144;
  const fader = Number(mock.getParam(`${path}/fdr`) ?? -144);
  return fader <= -144 ? -144 : Math.min(10, inputDb + fader);
}

/** The level words (1/256 dB) a strip-like group reports, gate/dyn reduction included. */
function stripWords(type: MeterGroupType, index: number, t: number): number[] {
  const prefix = { channel: "/ch", aux: "/aux", bus: "/bus", main: "/main", matrix: "/mtx" }[type.replace("V2", "")] ?? "/ch";
  const path = `${prefix}/${index}`;
  const input =
    type.startsWith("channel") ? sourceLevelDb(index, t) : type.startsWith("aux") ? -24 + Math.sin(t + index) * 6 : -18 + Math.sin(t * 0.8 + index) * 5;
  const output = stripOutputDb(path, input);
  const gateThr = Number(mock.getParam(`${path}/gate/thr`) ?? -80);
  const gateOn = Number(mock.getParam(`${path}/gate/on`) ?? 0) === 1;
  const gateRatio = gateOn && input < gateThr ? 1 : 0;
  const dynThr = Number(mock.getParam(`${path}/dyn/thr`) ?? 0);
  const dynOn = Number(mock.getParam(`${path}/dyn/on`) ?? 0) === 1;
  const reductionDb = dynOn && input > dynThr ? (input - dynThr) * 0.75 : 0;
  const db = (value: number) => Math.round(value * 256);
  const levels = [db(input), db(input - 0.5), db(output), db(output - 0.5), db(input)];
  if (type.endsWith("V2")) {
    return [...levels, Math.round(gateRatio * 256), gateRatio ? 1 : 0, db(input), Math.round((reductionDb / 20) * 256), reductionDb > 0 ? 1 : 0, 0];
  }
  return [...levels, Math.round(gateRatio * 256), db(input), Math.round((reductionDb / 20) * 256)];
}

/** 120 RTA bands (1/128 dB) from 20 Hz to 20 kHz: a pinkish mix with the kick pumping the lows. */
function rtaWords(t: number): number[] {
  const kick = Math.max(0, 1 - ((t * 2) % 1) * 4);
  return Array.from({ length: 120 }, (_, band) => {
    const lows = band < 25 ? kick * 18 * (1 - band / 25) : 0;
    const db = -38 - band * 0.12 + lows + Math.sin(t * 3 + band * 0.4) * 3 + Math.random() * 3;
    return Math.round(db * 128);
  });
}

function groupWords(type: MeterGroupType, index: number | undefined, t: number): number[] {
  const count = METER_GROUP_TABLE[type].wordCount;
  if (type === "rta") return rtaWords(t);
  if (type === "dca") {
    const pre = -20 + Math.sin(t + (index ?? 0)) * 4;
    const post = stripOutputDb(`/dca/${index}`, pre);
    return [pre, pre, post, post].map((v) => Math.round(v * 256));
  }
  if (["channel", "aux", "bus", "main", "matrix", "channelV2", "auxV2", "busV2", "mainV2", "matrixV2"].includes(type)) {
    return stripWords(type, index ?? 1, t);
  }
  return Array.from({ length: count }, () => Math.round((-30 + Math.random() * 6) * 256));
}

interface MeterSession {
  udpPort: number | null;
  reportId: number | null;
  groups: { type: MeterGroupType; index?: number }[];
}

const TOKEN_TO_TYPE = new Map(Object.entries(METER_GROUP_TABLE).map(([type, meta]) => [meta.token, type as MeterGroupType]));
const udp = dgram.createSocket("udp4");

/** Reads the meter channel's tokens: UDP port, report id, and the collection of groups to stream. */
function meterParser(session: MeterSession): (byte: number) => void {
  let pending: { token: number; bytes: number[]; need: number } | null = null;
  let collection: MeterSession["groups"] | null = null;
  let currentType: MeterGroupType | null = null;
  return (byte) => {
    if (pending) {
      pending.bytes.push(byte);
      if (pending.bytes.length === pending.need) {
        const buf = Buffer.from(pending.bytes);
        if (pending.token === TOKEN_UDP_PORT) session.udpPort = buf.readUInt16BE(0);
        else session.reportId = buf.readUInt32BE(0);
        pending = null;
      }
      return;
    }
    if (collection) {
      if (byte === TOKEN_COLLECTION_END) {
        session.groups = collection;
        collection = null;
        currentType = null;
      } else if (TOKEN_TO_TYPE.has(byte)) {
        currentType = TOKEN_TO_TYPE.get(byte) ?? null;
        if (currentType && !METER_GROUP_TABLE[currentType].hasIndex) collection.push({ type: currentType });
      } else if (currentType && byte < 128) {
        collection.push({ type: currentType, index: byte + 1 });
      }
      return;
    }
    if (byte === TOKEN_UDP_PORT) pending = { token: byte, bytes: [], need: 2 };
    else if (byte === TOKEN_REPORT_ID) pending = { token: byte, bytes: [], need: 4 };
    else if (byte === TOKEN_COLLECTION_START) collection = [];
  };
}

const meterServer = net.createServer((socket) => {
  const session: MeterSession = { udpPort: null, reportId: null, groups: [] };
  const demuxer = new WingChannelDemuxer();
  const parse = meterParser(session);
  const host = (socket.remoteAddress ?? "127.0.0.1").replace(/^::ffff:/, "");
  const started = Date.now();
  const timer = setInterval(() => {
    if (session.udpPort === null || session.reportId === null || session.groups.length === 0) return;
    const t = (Date.now() - started) / 1000;
    const words = session.groups.flatMap((group) => groupWords(group.type, group.index, t));
    const packet = Buffer.alloc(4 + words.length * 2);
    packet.writeUInt32BE(session.reportId >>> 0, 0);
    words.forEach((word, i) => packet.writeInt16BE(Math.max(-32768, Math.min(32767, word)), 4 + i * 2));
    udp.send(packet, session.udpPort, host);
  }, METER_INTERVAL_MS);
  socket.on("data", (chunk: Buffer) => demuxer.feed(chunk, (channel, byte) => channel === METER_CHANNEL_ID && parse(byte)));
  socket.on("close", () => clearInterval(timer));
  socket.on("error", () => clearInterval(timer));
});

const { oscPort, discoveryPort } = await mock.start();
await new Promise<void>((resolve) => meterServer.listen(METER_TCP_PORT, resolve));
console.log(`Fake WING console up — OSC udp/${oscPort}, discovery udp/${discoveryPort}, metering tcp/${METER_TCP_PORT}.`);
console.log("Point the server at it with WING_HOST=127.0.0.1. Ctrl+C to stop.");
console.log('Type "set <path> <value>" (e.g. "set /ch/3/mute 1") to act as if from the desk itself.');

// What a press on the desk does: the value changes and every subscriber gets the push, on the "$"
// address as from the real console. Lets the dashboard's live updates be tried without hardware.
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const match = /^set\s+(\S+)\s+(.+)$/.exec(line.trim());
  if (!match) {
    if (line.trim()) console.log('Expected "set <path> <value>".');
    return;
  }
  const raw = match[2].trim();
  const value = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  mock.setParam(match[1], value);
  console.log(`${match[1]} = ${value}`);
});

process.on("SIGINT", () => {
  meterServer.close();
  udp.close();
  void mock.stop().then(() => process.exit(0));
});
