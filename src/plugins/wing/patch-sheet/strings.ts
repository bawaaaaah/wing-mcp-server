/** The words printed on the sheet, French (default) or English. Names taken from the console stay as they are. */
export type Lang = "fr" | "en";

export interface Strings {
  title: string;
  overviewSubtitle: string;
  console: string;
  computers: string;
  localPorts: string;
  consoleInputs: string;
  unused: string;
  counts: (inputs: number, outputs: number) => string;
  tracks: string;
  cardsHeading: string;
  cardUnused: string;
  cardUsed: (n: number) => string;
  legendBus: string;
  legendMain: string;
  legendFree: string;
  wingColour: string;
  boxCount: (n: number) => string;
  pluggedInto: string;
  inputs: string;
  outputs: string;
  inputsRange: (a: number, b: number) => string;
  portsTitle: string;
  portsSubtitle: string;
  nothingPlugged: string;
  free: string;
  legendStagebox: string;
  legendConverter: string;
  legendUser: string;
  colChannel: string;
  cont: string;
  ultranetPort: string;
  outputsOn: (group: string, first: number, last: number) => string;
  splitterNote: string;
  backPanel: string;
  hubStrip: (group: string, first: number, last: number) => string;
  cardNone: string;
  cardRecord: string;
  // Tables.
  colInput: string;
  colOutput: string;
  tableInputs: string;
  tableOutputs: string;
  tableChannels: string;
  boxes: string;
  colBox: string;
  colLink: string;
  colInputsUsed: string;
  colOutputsUsed: string;
  via: (host: string) => string;
  on: string;
  scOf: string;
  /** "StageConnect du HUB4" / "port 2 du HUB4". */
  scOfHub: (hub: string) => string;
  portOfHub: (port: number, hub: string) => string;
  consolePorts: string;
  colPluggedIn: string;
  consoleSources: string;
  colName: string;
  locale: string;
}

const fr: Strings = {
  title: "Patch plateau",
  overviewSubtitle: "Vue d'ensemble du câblage",
  console: "Régie",
  computers: "Ordinateurs / sources",
  localPorts: "Ports locaux",
  consoleInputs: "Entrées console",
  unused: "non utilisé",
  counts: (i, o) => `${i} entrées · ${o} sorties`,
  tracks: "pistes 1-16",
  cardsHeading: "CARTES D'EXTENSION",
  cardUnused: "non utilisée",
  cardUsed: (n) => `${n} voie${n > 1 ? "s" : ""} utilisée${n > 1 ? "s" : ""}`,
  legendBus: "Retours in-ear (bus)",
  legendMain: "Façade (main / matrix)",
  legendFree: "Libre / non utilisé",
  wingColour: "Couleur WING",
  boxCount: (n) => `${n} boîtiers`,
  pluggedInto: "branché sur",
  inputs: "ENTRÉES",
  outputs: "SORTIES",
  inputsRange: (a, b) => `ENTRÉES ${a}-${b}`,
  portsTitle: "Ports de la console",
  portsSubtitle: "Matériel branché sur chaque port",
  nothingPlugged: "rien de branché",
  free: "libre",
  legendStagebox: "Boîtier de scène",
  legendConverter: "Convertisseur / hub / P16",
  legendUser: "User signals",
  colChannel: "Voie",
  cont: "(suite)",
  ultranetPort: "ULTRANET (face arrière)",
  outputsOn: (g, a, b) => `sorties XLR = ${g} ${a}-${b}`,
  splitterNote: "splitter : Ultranet = entrées 1-16 du boîtier",
  backPanel: "FACE ARRIÈRE",
  hubStrip: (g, a, b) => `${g} ${a}-${b} · SORTIES LOCALES ET STAGECONNECT DU HUB (4 PORTS x 4 SIGNAUX)`,
  cardNone: "Aucune voie utilisée sur cette carte.",
  cardRecord: "enregistrement / lecture SD (2 x 32 pistes)",
  colInput: "Entrée",
  colOutput: "Sortie",
  tableInputs: "ENTRÉES (boîtier -> console)",
  tableOutputs: "SORTIES (console -> boîtier)",
  tableChannels: "VOIES (console -> boîtier)",
  boxes: "BOÎTIERS",
  colBox: "Boîtier",
  colLink: "Liaison",
  colInputsUsed: "Entrées utilisées",
  colOutputsUsed: "Sorties utilisées",
  via: (h) => `via ${h}`,
  on: "sur",
  scOf: "StageConnect de",
  scOfHub: (h) => `StageConnect du ${h}`,
  portOfHub: (p, h) => `port ${p} du ${h}`,
  consolePorts: "PORTS DE LA CONSOLE",
  colPluggedIn: "Matériel branché",
  consoleSources: "SOURCES RÉGIE (Local, USB...)",
  colName: "Nom",
  locale: "fr-FR",
};

const en: Strings = {
  title: "Stage patch",
  overviewSubtitle: "Cabling overview",
  console: "FOH",
  computers: "Computers / sources",
  localPorts: "Local ports",
  consoleInputs: "Console inputs",
  unused: "unused",
  counts: (i, o) => `${i} inputs · ${o} outputs`,
  tracks: "tracks 1-16",
  cardsHeading: "EXPANSION CARDS",
  cardUnused: "unused",
  cardUsed: (n) => `${n} channel${n > 1 ? "s" : ""} in use`,
  legendBus: "In-ear returns (bus)",
  legendMain: "House (main / matrix)",
  legendFree: "Free / unused",
  wingColour: "WING colour",
  boxCount: (n) => `${n} boxes`,
  pluggedInto: "plugged into",
  inputs: "INPUTS",
  outputs: "OUTPUTS",
  inputsRange: (a, b) => `INPUTS ${a}-${b}`,
  portsTitle: "Console ports",
  portsSubtitle: "What is plugged into each port",
  nothingPlugged: "nothing plugged in",
  free: "free",
  legendStagebox: "Stage box",
  legendConverter: "Converter / hub / P16",
  legendUser: "User signals",
  colChannel: "Channel",
  cont: "(cont.)",
  ultranetPort: "ULTRANET (back panel)",
  outputsOn: (g, a, b) => `XLR outputs = ${g} ${a}-${b}`,
  splitterNote: "splitter: Ultranet = the box's own inputs 1-16",
  backPanel: "BACK PANEL",
  hubStrip: (g, a, b) => `${g} ${a}-${b} · HUB LOCAL OUTPUTS AND STAGECONNECT (4 PORTS x 4 SIGNALS)`,
  cardNone: "No channel in use on this card.",
  cardRecord: "SD recording / playback (2 x 32 tracks)",
  colInput: "Input",
  colOutput: "Output",
  tableInputs: "INPUTS (box -> console)",
  tableOutputs: "OUTPUTS (console -> box)",
  tableChannels: "CHANNELS (console -> box)",
  boxes: "BOXES",
  colBox: "Box",
  colLink: "Link",
  colInputsUsed: "Inputs used",
  colOutputsUsed: "Outputs used",
  via: (h) => `via ${h}`,
  on: "on",
  scOf: "StageConnect of",
  scOfHub: (h) => `StageConnect of ${h}`,
  portOfHub: (p, h) => `port ${p} of ${h}`,
  consolePorts: "CONSOLE PORTS",
  colPluggedIn: "Plugged in",
  consoleSources: "CONSOLE SOURCES (Local, USB...)",
  colName: "Name",
  locale: "en-GB",
};

export function strings(lang: Lang | undefined): Strings {
  return lang === "en" ? en : fr;
}
