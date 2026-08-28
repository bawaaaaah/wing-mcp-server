/**
 * Static introspection catalog for the gate/dyn/EQ/FX processing models WING can load into a
 * channel's (or bus/main/matrix's) processing chain, or into one of the 16 `fx.n` insert-effect
 * engine slots. `wing-param-catalog.ts` deliberately types `gate/mdl`, `dyn/mdl`, and `eq/mdl` as
 * free-form strings — "30+ models in firmware; not individually enumerated" — because the OSC
 * protocol reference never names them beyond a `describe()` enum of short codes (e.g. "76LA",
 * "SBUS", "DEQ2"). This file transcribes that enum against the plugin name list in
 * docs/WING_Remote-Protocols-3.1-03.pdf ("Effects and Plugins" section, p.129 — the `mdl` short-code
 * enum and the human-readable plugin name list are given in the same order, so position-matched 1:1)
 * plus the per-model appendix (p.150-170) for a one-line description and a few "good for" usage
 * tags. This is a pure data/lookup layer — no OSC calls, nothing console-side to get out of sync —
 * so it never needs a live test, only that lookups return what's written here.
 *
 * Gate and Dyn slots share the exact same 32-model enum (confirmed identical in the PDF for
 * `/ch/1/gate/mdl` and `/ch/1/dyn/mdl`) and are already treated as interchangeable elsewhere in this
 * codebase (see wing-dynamics-models.ts's header) — so this catalogs them once as category
 * "dynamics" rather than splitting into separate "gate"/"dyn" lists that would just duplicate every
 * entry. EQ models (category "eq") are a separate, disjoint 7-model enum for `eq/mdl`.
 *
 * FX models (category "fx", `fx.n/mdl` — see tools/insert.ts for the slot on/off/patch side of
 * this) come in three enums the PDF calls Premium/Standard/Channel (p.131), tracked here as
 * `fxTier`: Premium effects (mostly reverbs/delays/modulation) only load into FX engine slots 1-8;
 * Standard and Channel effects load into any of FX1-16 (p.169/footnote). Six of the "eq" category's
 * models (SOUL, E88, E84, F110, PULSAR, MACH4) double as Channel-tier FX models too — same
 * underlying engine, reused as a standalone insert rather than a strip's own EQ block — plus five
 * Channel-tier-only "full channel strip" composites (*EVEN*, *SOUL*, *VINTAGE*, *BUS*, *MASTER* —
 * the asterisks are literally part of the OSC value, confirmed against a real captured
 * `describe()` trace in the PDF at p.24/931). That same trace also caught a transcription error in
 * the printed appendix table: it lists Stereo Flanger's `mdl` as "CHORUS", identical to Stereo
 * Chorus's — the live-captured enum at p.24 shows them as two distinct codes, "CHORUS" and
 * "FLANGER"; this catalog uses the live-confirmed "FLANGER".
 */

export type WingPluginCategory = "dynamics" | "eq" | "fx";

/** Only meaningful for category "fx" — which of the three insert-effect engine enums a model
 * belongs to. Premium effects load only into FX engine slots 1-8; Standard and Channel effects
 * load into any of FX1-16 (PDF p.131/169). */
export type WingFxTier = "premium" | "standard" | "channel";

export interface WingPluginModel {
  /** Exact OSC `mdl` short code, e.g. "76LA". Not globally unique across categories (both the gate/dyn
   * and EQ enums separately define an "E88" model, and several EQ models double as Channel-tier FX
   * models under the same code), so lookups must be scoped by category when exact. */
  id: string;
  category: WingPluginCategory;
  /** Full human-readable plugin name as shown in the WING app, e.g. "76 Limiter Amp". */
  name: string;
  /** Real-world hardware/plugin this model emulates, when the console's own docs say so. */
  emulates?: string;
  shortDescription: string;
  goodFor: readonly string[];
  /** Set only for category "fx" — see WingFxTier. */
  fxTier?: WingFxTier;
}

/**
 * The 32 gate/dyn models, in the exact order both `/ch/1/gate/mdl` and `/ch/1/dyn/mdl` enumerate
 * them (PDF p.48-49), position-matched against the plugin name list (p.129).
 */
export const WING_DYNAMICS_MODELS: readonly WingPluginModel[] = [
  {
    id: "GATE",
    category: "dynamics",
    name: "WING Gate",
    shortDescription: "WING's native gate/expander — adjustable range, attack/hold/release, and an accent control that briefly boosts the transient as the gate opens.",
    goodFor: ["general gating", "drums", "percussion", "noise reduction"],
  },
  {
    id: "DUCK",
    category: "dynamics",
    name: "WING Ducker",
    shortDescription: "Standard sidechain-triggered ducker — attenuates a signal while a keyed source is active.",
    goodFor: ["ducking", "voice-over", "background music attenuation"],
  },
  {
    id: "E88",
    category: "dynamics",
    name: "Even 88 Gate",
    emulates: "Neve 88RS Gate",
    shortDescription: "Transparent, musical gating with hysteresis to prevent chattering on fluctuating signals.",
    goodFor: ["vocals", "drums", "general gating"],
  },
  {
    id: "9000G",
    category: "dynamics",
    name: "Soul 9000 Gate",
    emulates: "SSL 9000 Channel Gate",
    shortDescription: "Acts as an infinite:1 gate or a 2:1 expander; fast/slow attack switch and hold time.",
    goodFor: ["drums", "channel-strip gating"],
  },
  {
    id: "D241G",
    category: "dynamics",
    name: "Draw More 241 (Gate)",
    emulates: "Drawmer DL241 Expander/Gate",
    shortDescription: "Dual-channel expander/gate with precise per-channel threshold and sidechain high-pass filtering.",
    goodFor: ["drums", "multi-channel gating", "mastering-grade gating"],
  },
  {
    id: "DS902",
    category: "dynamics",
    name: "BDX 902 De-Esser",
    emulates: "dbx 902",
    shortDescription: "Dedicated de-esser targeting sibilance ('s'/'sh' sounds) in vocal recordings.",
    goodFor: ["de-essing", "vocals"],
  },
  {
    id: "DEQ",
    category: "dynamics",
    name: "Dynamic EQ",
    shortDescription: "Frequency-targeted dynamic processing that can boost or cut a band only once it crosses a threshold — a parametric EQ, compressor, and de-esser in one. Bidirectional: unlike every other model here, a positive gain-reduction reading is a real boost, not idle noise (see isBidirectionalDynModel).",
    goodFor: ["de-essing", "resonance control", "dynamic tone shaping"],
  },
  {
    id: "DEQ2",
    category: "dynamics",
    name: "Dual Dynamic EQ",
    shortDescription: "Two-band variant of the Dynamic EQ model above, also bidirectional.",
    goodFor: ["multi-band de-essing", "dynamic tone shaping"],
  },
  {
    id: "WAVE",
    category: "dynamics",
    name: "Wave Designer",
    emulates: "SPL Transient Designer",
    shortDescription: "Independently shapes a sound's attack and sustain regardless of its absolute level — not a level-dependent compressor.",
    goodFor: ["drums", "percussion", "transient shaping"],
  },
  {
    id: "PSE",
    category: "dynamics",
    name: "Source Extractor",
    emulates: "Rupert Neve PSE-545",
    shortDescription: "Attenuates a source once it falls below threshold, with a depth control and a fast/slow response switch — built for feedback and spill control.",
    goodFor: ["vocal clarity", "feedback reduction", "spill control"],
  },
  {
    id: "CMB",
    category: "dynamics",
    name: "PSE/LA Combo",
    shortDescription: "Blends LA-style optical leveling with combo compression stages for warm glue and cohesion.",
    goodFor: ["vocals", "bus glue", "vintage character"],
  },
  {
    id: "RIDE",
    category: "dynamics",
    name: "Auto Rider",
    emulates: "Waves Vocal Rider",
    shortDescription: "Automatically rides a source's level to keep it consistently present in the mix, without manual fader automation.",
    goodFor: ["vocal leveling", "automatic mixing"],
  },
  {
    id: "WARM",
    category: "dynamics",
    name: "Soul Warmth Pre",
    emulates: "SSL console preamp coloration",
    shortDescription: "Adds SSL-console-style punch and warmth/coloration rather than heavy gain reduction.",
    goodFor: ["adding character", "vocals", "drums"],
  },
  {
    id: "COMP",
    category: "dynamics",
    name: "WING Compressor",
    shortDescription: "WING's native general-purpose compressor, with an optional crossover (multiband) mode.",
    goodFor: ["general compression", "vocals", "mix bus"],
  },
  {
    id: "EXP",
    category: "dynamics",
    name: "WING Expander",
    shortDescription: "WING's native downward expander — gentler, more gradual noise reduction than a gate.",
    goodFor: ["noise reduction", "dynamic range expansion"],
  },
  {
    id: "B160",
    category: "dynamics",
    name: "BDX 160 Comp",
    emulates: "dbx 160",
    shortDescription: "Punchy, aggressive VCA compression with variable ratio and sidechain input; a drum/bass staple.",
    goodFor: ["drums", "bass", "vocals", "punch"],
  },
  {
    id: "B560",
    category: "dynamics",
    name: "BDX 560 Easy",
    emulates: "dbx 560 VCA Overeasy",
    shortDescription: "Smooth soft-knee ('Overeasy') VCA compression that preserves clarity and punch.",
    goodFor: ["vocals", "drums", "mix bus"],
  },
  {
    id: "D241C",
    category: "dynamics",
    name: "Draw More Comp",
    emulates: "Drawmer DL241 (compressor mode)",
    shortDescription: "Dual-channel compressor with a very wide ratio range (1:1 to 20:1) and switchable limiter mode.",
    goodFor: ["mastering", "precise dynamic control"],
  },
  {
    id: "ECL33",
    category: "dynamics",
    name: "Even Comp/Lim",
    emulates: "Neve 33609",
    shortDescription: "Classic warm Neve-style compressor/limiter combo with sidechain high-pass filtering.",
    goodFor: ["vocals", "drums", "mix bus", "mastering", "broadcast"],
  },
  {
    id: "9000C",
    category: "dynamics",
    name: "Soul 9000",
    emulates: "SSL 9000 Channel Compressor",
    shortDescription: "Transparent SSL-style channel compression with the classic SSL 'glue' character.",
    goodFor: ["vocals", "drums", "mix bus glue"],
  },
  {
    id: "SBUS",
    category: "dynamics",
    name: "Soul G Bus Comp",
    emulates: "SSL 9000 G Bus Compressor",
    shortDescription: "The classic SSL mix-bus glue compressor — cohesive, musical compression across a full mix.",
    goodFor: ["mix bus", "master bus glue"],
  },
  {
    id: "RED3",
    category: "dynamics",
    name: "Red3 Compressor",
    emulates: "Focusrite Red 3",
    shortDescription: "Clean VCA compression that adds a touch of high-mid lift; suited to mix-bus and vocal work.",
    goodFor: ["vocals", "mix bus"],
  },
  {
    id: "76LA",
    category: "dynamics",
    name: "76 Limiter Amp",
    emulates: "UREI/Universal Audio 1176 FET Compressor",
    shortDescription: "Very fast FET attack/release, punchy and aggressive; timing knobs are reversed (1=slowest, 7=fastest).",
    goodFor: ["drums", "vocals", "bass", "parallel compression"],
  },
  {
    id: "LA",
    category: "dynamics",
    name: "LA Leveler",
    emulates: "Teletronix LA-2A",
    shortDescription: "Slow, musical optical leveling with a fixed 3:1 ratio and program-dependent release.",
    goodFor: ["vocals", "bass", "gentle leveling"],
  },
  {
    id: "F670",
    category: "dynamics",
    name: "Fairkid Model 670",
    emulates: "Fairchild 670",
    shortDescription: "Legendary opto-triode compression prized for its smooth, musical, high-fidelity gain reduction.",
    goodFor: ["vocals", "drums", "mastering", "vintage character"],
  },
  {
    id: "BLISS",
    category: "dynamics",
    name: "Eternal Bliss",
    emulates: "Elysia Mpressor",
    shortDescription: "Transparent high-end VCA compression with negative-ratio, auto-fast attack, and gain-reduction limiting.",
    goodFor: ["mastering", "mix bus", "transparent compression"],
  },
  {
    id: "NSTR",
    category: "dynamics",
    name: "No Stressor",
    emulates: "Empirical Labs EL8 Distressor",
    shortDescription: "Highly versatile — from transparent leveling to heavily colored ('Nuke') compression; can emulate 1176/LA-2A response curves.",
    goodFor: ["drums", "vocals", "bass", "guitars", "mix bus"],
  },
  {
    id: "2250",
    category: "dynamics",
    name: "PIA2250 Rack",
    emulates: "API 225L",
    shortDescription: "Output gain stays at unity regardless of threshold/ratio settings, so compression amount can be dialed in real time without a level jump.",
    goodFor: ["broadcast", "live sound", "studio tracking"],
  },
  {
    id: "L100",
    category: "dynamics",
    name: "LTA100 Leveler",
    emulates: "Summit Audio TLA-100",
    shortDescription: "Warm tube-style compression with soft knee and a sidechain high-pass filter.",
    goodFor: ["vocals", "bass", "acoustic instruments"],
  },
  {
    id: "E88C",
    category: "dynamics",
    name: "Even 88 Comp",
    emulates: "Neve 88RS Compressor",
    shortDescription: "Neve-style compressor section companion to the Even 88 Gate model, for the same warm, musical character.",
    goodFor: ["vocals", "drums", "general compression"],
  },
  {
    id: "LMT",
    category: "dynamics",
    name: "LMT Compressor",
    shortDescription: "General-purpose brickwall-style limiter for peak control.",
    goodFor: ["peak limiting", "protection", "mastering"],
  },
  {
    id: "ONEC",
    category: "dynamics",
    name: "One Knob Comp",
    shortDescription: "Simplified single-knob compressor for quick, low-fuss dynamics control.",
    goodFor: ["quick setup", "live sound", "simple compression"],
  },
];

/** The 7 EQ models `/ch/1/eq/mdl` (and bus/main/matrix equivalents) can be set to, PDF p.129/189-193. */
export const WING_EQ_MODELS: readonly WingPluginModel[] = [
  {
    id: "STD",
    category: "eq",
    name: "WING EQ",
    shortDescription: "WING's native high-resolution parametric/shelving EQ, including a 'Tilt' filter type.",
    goodFor: ["general EQ", "corrective EQ"],
  },
  {
    id: "SOUL",
    category: "eq",
    name: "Soul Analog",
    emulates: "SSL Channel EQ (4000 Series)",
    shortDescription: "Punchy, characterful midrange EQ with combined high-pass/low-pass filtering.",
    goodFor: ["vocals", "drums", "guitars", "mix bus"],
  },
  {
    id: "E88",
    category: "eq",
    name: "Even 88-Formant",
    emulates: "Neve 88 EQ",
    shortDescription: "Smooth, musical EQ curves with classic Neve warmth and clarity.",
    goodFor: ["vocals", "guitars", "drums"],
  },
  {
    id: "E84",
    category: "eq",
    name: "Even 84",
    emulates: "AMS Neve 1084 EQ",
    shortDescription: "Rich, musical midrange boost/cut in the classic Neve 1084 style.",
    goodFor: ["vocals", "guitars", "warmth"],
  },
  {
    id: "F110",
    category: "eq",
    name: "Fortissimo 110",
    emulates: "Focusrite ISA 110 EQ",
    shortDescription: "Classic British-console warmth with high- and low-frequency EQ bands.",
    goodFor: ["vocals", "instruments", "vintage character"],
  },
  {
    id: "PULSAR",
    category: "eq",
    name: "Pulsar",
    emulates: "Pultec EQP-1A + MEQ-5",
    shortDescription: "Simultaneous boost and cut at the same frequency for a musical, resonant 'Pultec bump'.",
    goodFor: ["vocals", "bass", "drums", "vintage warmth"],
  },
  {
    id: "MACH4",
    category: "eq",
    name: "Mach EQ4",
    emulates: "Mäag EQ4",
    shortDescription: "Adds high-frequency 'air'/shine without harshness; a mastering-grade air band.",
    goodFor: ["mastering", "adding air", "vocals"],
  },
];

/**
 * The 63 insert-effect models loadable into one of the 16 `fx.n` engine slots (PDF p.131-134
 * authorized-values overview, p.150-169 per-model appendix, cross-checked against the live
 * `describe()` trace at p.24). Excludes "NONE"/"EXTERNAL", which are slot states rather than models
 * (mirroring WING_DYNAMICS_MODELS/WING_EQ_MODELS, which likewise don't list an "off" entry).
 */
export const WING_FX_MODELS: readonly WingPluginModel[] = [
  // Premium tier — FX engine slots 1-8 only.
  {
    id: "HALL",
    category: "fx",
    fxTier: "premium",
    name: "Hall Reverb",
    shortDescription: "Simulates a large hall's early reflections and long, smooth decay; pre-delay, size, damping, and a mod-speed control.",
    goodFor: ["vocals", "orchestral", "long ambient tails"],
  },
  {
    id: "ROOM",
    category: "fx",
    fxTier: "premium",
    name: "Room Reverb",
    shortDescription: "Natural small/medium room decay with its own stereo echo-left/right feed network for a denser character than Ambience.",
    goodFor: ["drums", "vocals", "natural room ambience"],
  },
  {
    id: "CHAMBER",
    category: "fx",
    fxTier: "premium",
    name: "Chamber Reverb",
    shortDescription: "Emulates a small, hard-walled echo chamber — tighter and more colored than a room, with its own echo-left/right feed.",
    goodFor: ["drums", "vocals", "vintage chamber character"],
  },
  {
    id: "PLATE",
    category: "fx",
    fxTier: "premium",
    name: "Plate Reverb",
    shortDescription: "Classic dense, bright plate-style reverb with an attack control and echo feed network.",
    goodFor: ["vocals", "snare", "bright metallic decay"],
  },
  {
    id: "CONCERT",
    category: "fx",
    fxTier: "premium",
    name: "Concert Reverb",
    shortDescription: "Large concert-hall reverb with independent early-reflection left/right levels, a built-in chorus/spin modulation, and depth control.",
    goodFor: ["orchestral", "large venue simulation", "choir"],
  },
  {
    id: "AMBI",
    category: "fx",
    fxTier: "premium",
    name: "Ambience",
    shortDescription: "Short-to-medium decay with a tail-gain control and no distinct early reflections — adds space without an obvious reverb tail.",
    goodFor: ["drums", "subtle room glue", "close-mic'd sources"],
  },
  {
    id: "VSS3",
    category: "fx",
    fxTier: "premium",
    name: "VSS3 Reverb",
    shortDescription: "High-end algorithmic reverb with 100+ built-in space presets, independently tunable early reflections and reverb tail, and a multi-band decay/crossover section.",
    goodFor: ["mastering-grade reverb", "vocals", "detailed space design"],
  },
  {
    id: "V-ROOM",
    category: "fx",
    fxTier: "premium",
    name: "Vintage Room",
    shortDescription: "Vintage-voiced room reverb with a freeze function and separate low/high decay multipliers for an aged, darker character.",
    goodFor: ["vocals", "vintage character", "drums"],
  },
  {
    id: "V-REV",
    category: "fx",
    fxTier: "premium",
    name: "Vintage Reverb",
    shortDescription: "Emulates an early digital reverb unit, including a front/rear output switch and a transformer-saturation option.",
    goodFor: ["vintage character", "lo-fi textures"],
  },
  {
    id: "V-PLATE",
    category: "fx",
    fxTier: "premium",
    name: "Vintage Plate",
    shortDescription: "Simplified, colored plate reverb — just decay, low cut, and a color control — for a fast vintage plate sound.",
    goodFor: ["vocals", "drums", "quick vintage plate"],
  },
  {
    id: "BPLATE",
    category: "fx",
    fxTier: "premium",
    name: "Blue Plate",
    shortDescription: "Plate reverb with an added crossover and a modulation depth/speed stage for a richer, less static plate tail.",
    goodFor: ["vocals", "drums", "modulated plate"],
  },
  {
    id: "GATED",
    category: "fx",
    fxTier: "premium",
    name: "Gated Reverb",
    shortDescription: "Dense reverb that's abruptly cut off after a set decay time, with density/diffusion and a high-frequency shelf.",
    goodFor: ["80s-style drums", "snare", "gated ambience"],
  },
  {
    id: "REVERSE",
    category: "fx",
    fxTier: "premium",
    name: "Reverse Reverb",
    shortDescription: "Reverb that swells up to a peak instead of decaying, with a rise-time control.",
    goodFor: ["risers", "transitions", "reverse vocal/cymbal swells"],
  },
  {
    id: "DEL/REV",
    category: "fx",
    fxTier: "premium",
    name: "Delay/Reverb",
    shortDescription: "Combines a tempo-independent delay with a reverb tail, including a delay-to-reverb feed and an input-to-reverb send.",
    goodFor: ["vocals", "combined delay+reverb sends", "ambient guitar"],
  },
  {
    id: "SHIMMER",
    category: "fx",
    fxTier: "premium",
    name: "Shimmer Reverb",
    shortDescription: "Reverb with a pitch-shifted 'shimmer'/'shine' layer for ethereal, pitched-up tails.",
    goodFor: ["ambient pads", "ethereal vocals", "cinematic textures"],
  },
  {
    id: "SPRING",
    category: "fx",
    fxTier: "premium",
    name: "Spring Reverb",
    shortDescription: "Classic boingy spring-tank reverb with bass/treble tone controls and density.",
    goodFor: ["guitar", "vintage character", "surf/rockabilly tones"],
  },
  {
    id: "DIMCRS",
    category: "fx",
    fxTier: "premium",
    name: "Dimension CRS",
    shortDescription: "Multi-switch chorus-style stereo expander (Dimension-D-style) with mono/stereo input, independent effect switches, and a dry-signal switch.",
    goodFor: ["stereo widening", "subtle chorus-like movement", "keys/pads"],
  },
  {
    id: "CHORUS",
    category: "fx",
    fxTier: "premium",
    name: "Stereo Chorus",
    shortDescription: "Classic stereo chorus with independent left/right delay time and depth, plus waveform and phase shaping.",
    goodFor: ["guitars", "keys", "stereo widening"],
  },
  {
    id: "FLANGER",
    category: "fx",
    fxTier: "premium",
    name: "Stereo Flanger",
    shortDescription: "Stereo flanger with independent left/right delay/depth, feedback, and a dedicated feed high/low-cut filter.",
    goodFor: ["guitars", "drums", "sweeping stereo motion"],
  },
  {
    id: "ST-DL",
    category: "fx",
    fxTier: "premium",
    name: "Stereo Delay",
    shortDescription: "Tempo-syncable stereo delay with independent stereo/cross/mono mode, tap-ratio factor and pattern, plus feedback tone shaping.",
    goodFor: ["vocals", "guitars", "rhythmic delay"],
  },
  {
    id: "TAP-DL",
    category: "fx",
    fxTier: "premium",
    name: "UltraTap Delay",
    shortDescription: "Multi-tap delay (1-16 repeats) with slope, movement modes (move/jump/focus/spread), and stereo width control.",
    goodFor: ["creative rhythmic delays", "vocals", "percussion"],
  },
  {
    id: "TAPE-DL",
    category: "fx",
    fxTier: "premium",
    name: "Tape Delay",
    shortDescription: "Tape-echo emulation with saturation drive, sustain (feedback), and wow/flutter.",
    goodFor: ["dub-style delay", "vintage character", "guitars"],
  },
  {
    id: "OILCAN",
    category: "fx",
    fxTier: "premium",
    name: "OilCan Delay",
    shortDescription: "Emulates an oil-can-style delay/echo device — sustain, wobble, and tone controls for a lo-fi, unstable echo.",
    goodFor: ["lo-fi textures", "vintage character", "experimental delay"],
  },
  {
    id: "BBD-DL",
    category: "fx",
    fxTier: "premium",
    name: "BBD Delay",
    shortDescription: "Bucket-brigade-style analog delay emulation — a single delay-time and feedback control for a warm, degraded echo.",
    goodFor: ["guitars", "vintage analog delay character"],
  },
  {
    id: "PITCH",
    category: "fx",
    fxTier: "premium",
    name: "Stereo Pitch",
    shortDescription: "Fixed pitch shifter (semitone/cent) with its own delay and mix, for doubling or harmony effects.",
    goodFor: ["pitch doubling", "harmonies", "detuned thickening"],
  },
  {
    id: "D-PITCH",
    category: "fx",
    fxTier: "premium",
    name: "Dual Pitch",
    shortDescription: "Two independently pitch-shifted voices, each with its own semitone/cent, delay, pan, and level, for stacked harmonies.",
    goodFor: ["harmonies", "vocal doubling", "stacked pitch effects"],
  },
  // Standard tier — any of FX engine slots 1-16.
  {
    id: "GEQ",
    category: "fx",
    fxTier: "standard",
    name: "Graphic EQ",
    shortDescription: "31-band (ISO third-octave) graphic EQ with a standard/'true' (constant-Q) mode switch.",
    goodFor: ["system EQ", "monitor tuning", "corrective EQ"],
  },
  {
    id: "PIA",
    category: "fx",
    fxTier: "standard",
    name: "PIA 560 GEQ",
    emulates: "API 560 Graphic EQ",
    shortDescription: "10-band musical graphic EQ with a dedicated mix and gain control, in the style of a classic API rack graphic EQ.",
    goodFor: ["mix bus", "drum bus", "musical broad-stroke EQ"],
  },
  {
    id: "DEQ3",
    category: "fx",
    fxTier: "standard",
    name: "Triple Dynamic EQ",
    shortDescription: "Three independently threshold/ratio/frequency-targeted dynamic EQ bands, each low or high mode, for multi-band dynamic tone shaping.",
    goodFor: ["multi-band de-essing", "mastering", "dynamic tone shaping"],
  },
  {
    id: "C5-CMB",
    category: "fx",
    fxTier: "standard",
    name: "Combinator",
    shortDescription: "5-band multiband dynamics processor with per-band threshold/gain/bypass and crossover width, plus band solo — a full multiband compressor.",
    goodFor: ["mastering", "multiband compression", "mix bus glue"],
  },
  {
    id: "LIMITER",
    category: "fx",
    fxTier: "standard",
    name: "Precision Limiter",
    shortDescription: "Transparent brickwall peak limiter with squeeze/knee shaping and optional auto makeup gain.",
    goodFor: ["mastering", "peak protection", "broadcast limiting"],
  },
  {
    id: "SPKMAN",
    category: "fx",
    fxTier: "standard",
    name: "Speaker Manager",
    shortDescription: "Loudspeaker-management tool: high/low-pass crossover filters with selectable slopes, tilt EQ, phase, delay/distance alignment, and a built-in dynamic-EQ + limiter section.",
    goodFor: ["speaker system tuning", "delay/time alignment", "system protection"],
  },
  {
    id: "DE-S2",
    category: "fx",
    fxTier: "standard",
    name: "2-Band DeEsser",
    shortDescription: "Dual-band (low/high) de-esser with independent sibilance thresholds, a gender (male/female) preset, and a stereo/mid-side mode.",
    goodFor: ["de-essing", "vocals"],
  },
  {
    id: "ENHANCE",
    category: "fx",
    fxTier: "standard",
    name: "Ultra Enhancer",
    shortDescription: "Stereo-image and tonal enhancer — separately reshapes stereo width/pan and low/mid/high harmonic content, with a solo-listen mode.",
    goodFor: ["stereo widening", "mix bus polish", "adding presence"],
  },
  {
    id: "EXCITER",
    category: "fx",
    fxTier: "standard",
    name: "Exciter",
    shortDescription: "Harmonic exciter that adds tuned high-frequency harmonics above a set frequency, with peak/zfill/timbre shaping and a dry-blend option.",
    goodFor: ["adding brightness/air", "vocals", "mix bus sheen"],
  },
  {
    id: "P-BASS",
    category: "fx",
    fxTier: "standard",
    name: "Psycho Bass",
    shortDescription: "Psychoacoustic bass enhancer — generates perceived low-end harmonics above a crossover point instead of boosting raw sub bass.",
    goodFor: ["small-speaker bass perception", "bass", "kick"],
  },
  {
    id: "SUB",
    category: "fx",
    fxTier: "standard",
    name: "Sub Octaver",
    shortDescription: "Generates a sub-harmonic (one or two octaves down) from the input, with a selectable frequency range and independent octave-1/octave-2 mix.",
    goodFor: ["bass", "kick", "adding sub-harmonic weight"],
  },
  {
    id: "SUB-M",
    category: "fx",
    fxTier: "standard",
    name: "Sub Monster",
    shortDescription: "Five-band sub/bass enhancement with a tunable low-end frequency focus, for heavier low end than a simple octaver.",
    goodFor: ["bass", "kick", "EDM/hip-hop low end"],
  },
  {
    id: "V-IMG",
    category: "fx",
    fxTier: "standard",
    name: "Velvet Imager",
    shortDescription: "Stereo width and gain imaging tool with a 'Velvet'-style smoothing mode and a deep-widening option.",
    goodFor: ["stereo widening", "mix bus", "mastering"],
  },
  {
    id: "DOUBLE",
    category: "fx",
    fxTier: "standard",
    name: "Double Vocal",
    shortDescription: "Automatic vocal doubler with selectable character (tight/loose/group/detune/thick) and spread.",
    goodFor: ["vocal doubling", "vocal thickening", "background vocals"],
  },
  {
    id: "PCORR",
    category: "fx",
    fxTier: "standard",
    name: "Pitch Fix",
    shortDescription: "Real-time pitch correction with adjustable speed/amount, reference A4 tuning, and a per-note (chromatic) scale mask.",
    goodFor: ["vocal pitch correction", "live tuning correction"],
  },
  {
    id: "ROTARY",
    category: "fx",
    fxTier: "standard",
    name: "Rotary Speaker",
    shortDescription: "Leslie-style rotary speaker emulation with independent slow/fast horn and drum speeds, acceleration, balance, and distance.",
    goodFor: ["organ", "guitar", "vintage rotary character"],
  },
  {
    id: "PHASER",
    category: "fx",
    fxTier: "standard",
    name: "Phaser",
    shortDescription: "Multi-stage (2-12) phaser with LFO speed/waveform/phase, envelope-follow modulation, and resonance.",
    goodFor: ["guitars", "keys", "sweeping phase movement"],
  },
  {
    id: "PANNER",
    category: "fx",
    fxTier: "standard",
    name: "Tremolo/Panner",
    shortDescription: "Combined tremolo and auto-panner — LFO speed/waveform/phase plus an envelope-triggered attack/hold/release mode.",
    goodFor: ["guitars", "keys", "rhythmic level/pan movement"],
  },
  {
    id: "TAPE",
    category: "fx",
    fxTier: "standard",
    name: "Tape Machine",
    shortDescription: "Analog tape saturation with drive, tape speed, low-bump/high-shelf toggles, and output trim.",
    goodFor: ["adding warmth", "mix bus glue", "vintage character"],
  },
  {
    id: "MOOD",
    category: "fx",
    fxTier: "standard",
    name: "Mood Filter",
    shortDescription: "Resonant multi-mode (LP/HP/BP/notch) filter with an envelope follower and its own tremolo-style LFO for filter movement.",
    goodFor: ["synth/bass filter sweeps", "creative filtering", "movement effects"],
  },
  {
    id: "BODY",
    category: "fx",
    fxTier: "standard",
    name: "Bodyrez",
    shortDescription: "Single-knob resonance/'body' enhancer — adds perceived low-mid body to thin sources.",
    goodFor: ["adding body/warmth", "thin vocals or instruments"],
  },
  {
    id: "RACKAMP",
    category: "fx",
    fxTier: "standard",
    name: "Rack Amp",
    shortDescription: "Direct-recording amp/preamp simulator with buzz, punch, crunch, drive, a 2-band EQ, and an optional cabinet simulator.",
    goodFor: ["guitars", "bass", "DI amp tone"],
  },
  {
    id: "UKROCK",
    category: "fx",
    fxTier: "standard",
    name: "UK Rock Amp",
    shortDescription: "British rock amp voicing — gain, 3-band EQ, presence, master, sag, and cabinet sim.",
    goodFor: ["rock guitar", "crunch/lead tones"],
  },
  {
    id: "ANGEL",
    category: "fx",
    fxTier: "standard",
    name: "Angel Amp",
    shortDescription: "High-gain amp voicing with mid-boost/bright/bottom switches on top of the standard gain/EQ/presence/sag/cab controls.",
    goodFor: ["high-gain guitar", "metal/hard rock tones"],
  },
  {
    id: "JAZZC",
    category: "fx",
    fxTier: "standard",
    name: "Jazz Clean Amp",
    shortDescription: "Clean, headroom-forward amp voicing with volume, 3-band EQ, bright switch, and cabinet sim.",
    goodFor: ["clean guitar", "jazz/pop tones"],
  },
  {
    id: "DELUXE",
    category: "fx",
    fxTier: "standard",
    name: "Deluxe Amp",
    shortDescription: "Small American combo-style amp voicing with volume/bass/treble, sag, and cabinet sim.",
    goodFor: ["classic clean/breakup guitar tones"],
  },
  // Channel tier — any of FX engine slots 1-16. SOUL/E88/E84/F110/PULSAR/MACH4 are the same engines
  // as their "eq" category counterparts, reused here as a standalone FX-slot insert.
  {
    id: "SOUL",
    category: "fx",
    fxTier: "channel",
    name: "Soul Analog EQ",
    emulates: "SSL Channel EQ (4000 Series)",
    shortDescription: "Punchy, characterful midrange EQ with combined high-pass/low-pass filtering, usable as a standalone FX-slot insert.",
    goodFor: ["vocals", "drums", "guitars", "mix bus"],
  },
  {
    id: "E88",
    category: "fx",
    fxTier: "channel",
    name: "Even 88-Formant EQ",
    emulates: "Neve 88 EQ",
    shortDescription: "Smooth, musical EQ curves with classic Neve warmth and clarity, usable as a standalone FX-slot insert.",
    goodFor: ["vocals", "guitars", "drums"],
  },
  {
    id: "E84",
    category: "fx",
    fxTier: "channel",
    name: "Even 84 EQ",
    emulates: "AMS Neve 1084 EQ",
    shortDescription: "Rich, musical midrange boost/cut in the classic Neve 1084 style, usable as a standalone FX-slot insert.",
    goodFor: ["vocals", "guitars", "warmth"],
  },
  {
    id: "F110",
    category: "fx",
    fxTier: "channel",
    name: "Focusrite ISA 110 EQ",
    emulates: "Focusrite ISA 110 EQ",
    shortDescription: "Classic British-console warmth with high- and low-frequency EQ bands, usable as a standalone FX-slot insert.",
    goodFor: ["vocals", "instruments", "vintage character"],
  },
  {
    id: "PULSAR",
    category: "fx",
    fxTier: "channel",
    name: "Pulsar P1a/M5 EQ",
    emulates: "Pultec EQP-1A + MEQ-5",
    shortDescription: "Simultaneous boost and cut at the same frequency for a musical, resonant 'Pultec bump', usable as a standalone FX-slot insert.",
    goodFor: ["vocals", "bass", "drums", "vintage warmth"],
  },
  {
    id: "MACH4",
    category: "fx",
    fxTier: "channel",
    name: "Mach EQ4",
    emulates: "Mäag EQ4",
    shortDescription: "Adds high-frequency 'air'/shine without harshness, usable as a standalone FX-slot insert.",
    goodFor: ["mastering", "adding air", "vocals"],
  },
  {
    id: "*EVEN*",
    category: "fx",
    fxTier: "channel",
    name: "Even Channel",
    shortDescription: "Full channel strip combining an Even 88-style gate, Even 88 Formant EQ, and an Even compressor/limiter in a single FX-slot insert.",
    goodFor: ["full channel strip processing", "vocals", "drums"],
  },
  {
    id: "*SOUL*",
    category: "fx",
    fxTier: "channel",
    name: "Soul Channel",
    shortDescription: "Full channel strip combining a Soul 9000-style gate/expander, Soul Analogue EQ, and a Soul 9000 channel compressor in a single FX-slot insert.",
    goodFor: ["full channel strip processing", "vocals", "drums"],
  },
  {
    id: "*VINTAGE*",
    category: "fx",
    fxTier: "channel",
    name: "Vintage Channel",
    shortDescription: "Full channel strip combining a 76-style limiting amplifier, Pulsar P1A/M5 EQ, and a Model 2A-style leveling amplifier in a single FX-slot insert.",
    goodFor: ["full channel strip processing", "vocals", "vintage character"],
  },
  {
    id: "*BUS*",
    category: "fx",
    fxTier: "channel",
    name: "Bus Channel",
    shortDescription: "Full bus-processing chain combining Soul Warmth coloration, Even 84 EQ, and a Soul G Bus Compressor in a single FX-slot insert.",
    goodFor: ["mix bus", "submix glue", "bus processing"],
  },
  {
    id: "*MASTER*",
    category: "fx",
    fxTier: "channel",
    name: "Mastering",
    shortDescription: "Full mastering chain combining tape saturation, Mach EQ4, a stereo enhancer, and a Precision Limiter in a single FX-slot insert.",
    goodFor: ["mastering", "master bus chain", "final polish"],
  },
];

export const WING_PLUGIN_MODELS: readonly WingPluginModel[] = [...WING_DYNAMICS_MODELS, ...WING_EQ_MODELS, ...WING_FX_MODELS];

/** All models whose `id` matches (case-insensitive) — usually one, except codes like "E88" that are
 * reused across the disjoint dynamics and eq enums; callers should also check `category` when it matters. */
export function findPluginModelsById(id: string): WingPluginModel[] {
  const upper = id.toUpperCase();
  return WING_PLUGIN_MODELS.filter((m) => m.id.toUpperCase() === upper);
}

/** All models in a category, or the full catalog if `category` is omitted. */
export function listPluginModels(category?: WingPluginCategory): readonly WingPluginModel[] {
  if (!category) return WING_PLUGIN_MODELS;
  return WING_PLUGIN_MODELS.filter((m) => m.category === category);
}

/** Models whose `goodFor` tags (or name/emulates, as a fallback) mention `usage` as a substring, case-insensitive. */
export function listPluginModelsByUsage(usage: string): WingPluginModel[] {
  const needle = usage.trim().toLowerCase();
  if (!needle) return [];
  return WING_PLUGIN_MODELS.filter(
    (m) =>
      m.goodFor.some((tag) => tag.toLowerCase().includes(needle)) ||
      m.name.toLowerCase().includes(needle) ||
      (m.emulates?.toLowerCase().includes(needle) ?? false),
  );
}
