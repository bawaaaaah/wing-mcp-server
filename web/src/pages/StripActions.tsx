import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { WingAck } from "../api/queries.js";
import { useUrlStrip, type StripKind, type StripRef } from "../api/useUrlStrip.js";
import { ContextMenu, type MenuEntry } from "../components/ContextMenu.js";
import { WING_COLORS } from "../components/ParamPanel.js";
import { faderDbToPosition, faderPositionToDb } from "../components/SliderControl.js";

const KIND_LABEL: Record<StripKind, string> = { ch: "Ch", aux: "Aux", bus: "Bus", main: "Main", mtx: "Mtx", dca: "DCA" };
const KIND_NOUN: Record<StripKind, string> = { ch: "channel", aux: "aux", bus: "bus", main: "main", mtx: "matrix", dca: "DCA" };
// Protocol reference: a DCA's name holds 8 characters, every other strip's 16.
const NAME_MAX: Record<StripKind, number> = { ch: 16, aux: 16, bus: 16, main: 16, mtx: 16, dca: 8 };

/** Which of the strip's other views exist for it: a matrix has no sends page, a DCA none of these. */
const OPENS: Record<StripKind, { processing: boolean; routing: boolean; identity: boolean }> = {
  ch: { processing: true, routing: true, identity: true },
  aux: { processing: true, routing: true, identity: true },
  bus: { processing: true, routing: true, identity: true },
  main: { processing: true, routing: true, identity: true },
  mtx: { processing: true, routing: false, identity: true },
  dca: { processing: false, routing: false, identity: false },
};

/** Source groups as the console's own patch screen names them. */
const SOURCE_GROUP_LABEL: Record<string, string> = {
  LCL: "Local",
  AUX: "Aux In",
  A: "AES50-A",
  B: "AES50-B",
  C: "AES50-C",
  SC: "StageConnect",
  USB: "USB",
  CRD: "Card",
  MOD: "Module",
  PLAY: "Player",
  AES: "AES/EBU",
  USR: "User",
  OSC: "Oscillator",
  BUS: "Bus",
  MAIN: "Main",
  MTX: "Matrix",
};

/** "AES50-A 12" — a patched source, the way the console's patch screen names it. */
export function sourceLabel(source: { group: string; index: number }): string {
  return `${SOURCE_GROUP_LABEL[source.group] ?? source.group} ${source.index}`;
}

/** One press of + or −: a fortieth of the travel, so 1 dB around unity and more lower down, as on the desk. */
const FADER_STEP = 1 / 40;

function nudgedFader(db: number, direction: 1 | -1): number {
  // Back onto the step grid first, so repeated presses land on the same values whatever the start.
  const steps = faderDbToPosition(db) / FADER_STEP;
  const next = direction > 0 ? Math.floor(steps + 1e-6) + 1 : Math.ceil(steps - 1e-6) - 1;
  return faderPositionToDb(Math.max(0, Math.min(1, next * FADER_STEP)));
}

/** What a strip row can do, for its menu and its keys. Optional parts only exist on some strips. */
export interface StripControls {
  strip: StripRef;
  name: string;
  col: number;
  muted: boolean;
  soloed: boolean;
  fader: number;
  toggleMute: () => void;
  toggleSolo: () => void;
  setFader: (db: number) => void;
  setColor: (col: number) => void;
  /** Writes the strip's own name; resolves to the console's ack. */
  rename: (name: string) => Promise<WingAck>;
  /** Channel / aux: centre the pan. */
  centrePan?: () => void;
  /** Channel / aux: whether name, colour and icon follow the patched source (`clink`), and that source. */
  link?: { linked: boolean; source: { group: string; index: number } | null; toggle: () => void };
  /** Channel / aux with a source patched: renames that source — which every strip following it shows. */
  renameSource?: (name: string) => Promise<WingAck>;
}

interface StripActionsApi {
  notify: (message: string) => void;
  toggleHelp: () => void;
}

const StripActionsContext = createContext<StripActionsApi | null>(null);

/**
 * Around the mixer's strip lists: the one place a refused shortcut or a write that did not take
 * says why (a status line that fades out), and the list of shortcuts that "?" or the toolbar's
 * Shortcuts button shows.
 */
export function StripActionsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [notice, setNotice] = useState<{ text: string; at: number } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const api = useMemo<StripActionsApi>(
    () => ({
      notify: (text) => setNotice({ text, at: Date.now() }),
      toggleHelp: () => setHelpOpen((open) => !open),
    }),
    [],
  );

  return (
    <StripActionsContext.Provider value={api}>
      {helpOpen && <StripShortcutsHelp onClose={() => setHelpOpen(false)} />}
      {children}
      <div className={notice ? "strip-notice strip-notice--shown" : "strip-notice"} role="status" aria-live="polite">
        {notice?.text}
      </div>
    </StripActionsContext.Provider>
  );
}

function useStripActions(): StripActionsApi {
  const api = useContext(StripActionsContext);
  if (!api) throw new Error("useStripActions outside StripActionsProvider");
  return api;
}

/** Says something in the mixer's status line: a write that did not take, say. */
export function useStripNotice(): (message: string) => void {
  return useStripActions().notify;
}

/** "Ch 3", "Bus 12" — a strip as its row and the status line name it. */
export function stripTitle(strip: StripRef): string {
  return `${KIND_LABEL[strip.kind]} ${strip.index}`;
}

/** The toolbar's button for the shortcut list. */
export function StripShortcutsButton(): JSX.Element {
  const { toggleHelp } = useStripActions();
  return (
    <button type="button" className="mixer-refresh strip-shortcuts-button" onClick={toggleHelp} title="Keyboard shortcuts (?)" aria-keyshortcuts="?">
      Shortcuts
    </button>
  );
}

const SHORTCUTS: readonly (readonly [string, string])[] = [
  ["↑ ↓ · Home End", "Move between strips"],
  ["M", "Mute"],
  ["S", "Solo"],
  ["0", "Fader to 0 dB"],
  ["+ / −", "Fader up / down a step"],
  ["C", "Pan to centre"],
  ["Enter · F2 · double-click the name", "Rename"],
  ["Shift+F2", "Rename the source a linked strip follows"],
  ["L", "Link name, colour and icon to the source"],
  ["E · R · I", "Open its EQ / Gate / Dyn, Sends, Identity"],
  ["Right-click · ⋯ · Shift+F10", "All of the strip's actions"],
  ["?", "Show or hide this list"],
];

function StripShortcutsHelp({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <section
      className="strip-shortcuts"
      aria-label="Keyboard shortcuts"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="strip-shortcuts__header">
        <h3>Keyboard shortcuts</h3>
        <button type="button" className="mixer-refresh" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
      <p className="card-hint">Click a strip (or Tab to the list), then:</p>
      <dl className="strip-shortcuts__list">
        {SHORTCUTS.map(([keys, action]) => (
          <div key={keys} className="strip-shortcuts__row">
            <dt>
              <kbd>{keys}</kbd>
            </dt>
            <dd>{action}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export interface StripList {
  kind: StripKind;
  isSelected: (index: number) => boolean;
  /** Only one row of a list is a Tab stop: the selected one, else the first. */
  tabIndexFor: (index: number) => 0 | -1;
  rowRef: (index: number) => (el: HTMLElement | null) => void;
  select: (index: number) => void;
  move: (from: number, to: 1 | -1 | "first" | "last") => void;
  /** Opens another view of a strip: `{ section: "processing" }`, `{ tab: "identity" }`. */
  openIn: (index: number, params: Record<string, string>) => void;
}

/**
 * Selection and arrow-key movement for one list of strips (the channels, the buses…). The selected
 * strip is the URL's `strip`, shared with EQ / Gate / Dyn, Routing and Identity.
 */
export function useStripList(kind: StripKind, indices: readonly number[]): StripList {
  const [selected, setSelected] = useUrlStrip();
  const rows = useRef(new Map<number, HTMLElement>());
  const selectedIndex = selected?.kind === kind && indices.includes(selected.index) ? selected.index : null;
  const tabStop = selectedIndex ?? indices[0];

  function select(index: number) {
    if (index !== selectedIndex) setSelected({ kind, index });
  }

  return {
    kind,
    isSelected: (index) => index === selectedIndex,
    tabIndexFor: (index) => (index === tabStop ? 0 : -1),
    rowRef: (index) => (el) => {
      if (el) rows.current.set(index, el);
      else rows.current.delete(index);
    },
    select,
    move: (from, to) => {
      const at = indices.indexOf(from);
      const next = to === "first" ? 0 : to === "last" ? indices.length - 1 : Math.max(0, Math.min(indices.length - 1, at + to));
      const index = indices[next];
      if (index === undefined) return;
      select(index);
      rows.current.get(index)?.focus();
    },
    openIn: (index, params) => setSelected({ kind, index }, params),
  };
}

/** The strip's name, edited in place: Enter or leaving the field keeps it, Escape drops it. */
function RenameInput({ initial, maxLength, label, onDone }: { initial: string; maxLength: number; label: string; onDone: (name: string | null, viaKey: boolean) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null, viaKey: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(name, viaKey);
  };
  return (
    <input
      className="strip-rename"
      type="text"
      value={value}
      maxLength={maxLength}
      aria-label={label}
      autoFocus
      onFocus={(event) => event.target.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(value, false)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(value, true);
        else if (event.key === "Escape") finish(null, true);
        // The row's own keys (M, S, arrows…) are letters typed into the name here.
        event.stopPropagation();
      }}
    />
  );
}

/** A small chain link: this strip's name, colour and icon come from its source. */
function LinkGlyph(): JSX.Element {
  return (
    <svg className="strip-link__glyph" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7l1.2-1.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

type Renaming = "strip" | "source" | null;

/**
 * One strip of a list, with everything a mouse or keyboard can do to it besides its own controls:
 * click to select it, right-click (or ⋯, or Shift+F10) for its menu, the shortcuts of SHORTCUTS,
 * and renaming in place. A strip whose name follows its source (`clink`) cannot be renamed — the
 * name written would be the strip's own, which the console doesn't show while linked — so Rename
 * says why and points at renaming the source instead.
 */
export function StripRow({
  list,
  controls,
  className,
  style,
  children,
}: {
  list: StripList;
  controls: StripControls;
  className: string;
  style?: CSSProperties;
  /** The row's cells, given its name (or the rename field) and its ⋯ button to place. */
  children: (parts: { name: ReactNode; menuButton: ReactNode }) => ReactNode;
}): JSX.Element {
  const { notify, toggleHelp } = useStripActions();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<Renaming>(null);
  const { strip, link } = controls;
  const index = strip.index;
  const title = stripTitle(strip);
  const noun = KIND_NOUN[strip.kind];
  const opens = OPENS[strip.kind];
  const source = link?.source ?? null;
  const locked = link?.linked === true && source !== null;
  const lockedHint = locked && source ? `Follows ${sourceLabel(source)} — unlink (L) to name this ${noun} itself` : undefined;

  function startRename(which: Exclude<Renaming, null>) {
    if (which === "strip" && locked && source) {
      notify(`${title}'s name follows ${sourceLabel(source)}. Rename the source (Shift+F2), or unlink it (L) first.`);
      return;
    }
    if (which === "source" && !(locked && controls.renameSource)) {
      notify(`${title} doesn't follow a source's name.`);
      return;
    }
    setRenaming(which);
  }

  function finishRename(name: string | null, viaKey: boolean) {
    const which = renaming;
    setRenaming(null);
    if (viaKey) rowRef.current?.focus();
    if (name === null || name === controls.name) return;
    const write = which === "source" ? controls.renameSource : controls.rename;
    if (!write) return;
    const what = which === "source" && source ? sourceLabel(source) : title;
    write(name).then(
      (ack) => {
        if (!ack.ok) notify(`${what} was not renamed: the console answered ${ack.status}.`);
      },
      (err: unknown) => notify(`${what} was not renamed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  function openMenuAtRow() {
    const rect = rowRef.current?.getBoundingClientRect();
    if (rect) setMenuAt({ x: rect.left + 32, y: rect.top + Math.min(rect.height, 40) });
  }

  const goTo = (params: Record<string, string>) => list.openIn(index, params);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || renaming || menuAt) return;
    const target = event.target as HTMLElement;
    // A text field takes every key; a slider keeps its arrows (and Home/End/Page keys) to itself.
    if (target.matches("input:not([type=range]), select, textarea")) return;
    const onSlider = target.matches("input[type=range]");
    const onButton = target.matches("button");
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const arrows = !onSlider;

    if (key === "ContextMenu" || (key === "F10" && event.shiftKey)) openMenuAtRow();
    else if (arrows && key === "ArrowDown") list.move(index, 1);
    else if (arrows && key === "ArrowUp") list.move(index, -1);
    else if (arrows && key === "Home") list.move(index, "first");
    else if (arrows && key === "End") list.move(index, "last");
    else if (key === "F2") startRename(event.shiftKey ? "source" : "strip");
    else if (key === "Enter" && !onButton) startRename("strip");
    else if (key === "m") controls.toggleMute();
    else if (key === "s") controls.toggleSolo();
    else if (key === "l" && link) link.toggle();
    else if (key === "c" && controls.centrePan) controls.centrePan();
    // By the key's place as well as its character: on AZERTY the 0 key types "à" unshifted.
    else if (key === "0" || event.code === "Digit0" || event.code === "Numpad0") controls.setFader(0);
    else if (key === "+" || key === "=" || event.code === "NumpadAdd") controls.setFader(nudgedFader(controls.fader, 1));
    else if (key === "-" || key === "_" || event.code === "NumpadSubtract") controls.setFader(nudgedFader(controls.fader, -1));
    else if (key === "e" && opens.processing) goTo({ section: "processing" });
    else if (key === "r" && opens.routing) goTo({ section: "routing" });
    else if (key === "i" && opens.identity) goTo({ tab: "identity" });
    else if (key === "?") toggleHelp();
    else return;
    event.preventDefault();
  }

  function onContextMenu(event: MouseEvent<HTMLDivElement>) {
    // The rename field keeps the browser's own menu (paste, spelling).
    if ((event.target as HTMLElement).matches("input:not([type=range])")) return;
    event.preventDefault();
    list.select(index);
    setMenuAt({ x: event.clientX, y: event.clientY });
  }

  const entries: MenuEntry[] = [
    { label: "Mute", shortcut: "M", checked: controls.muted, onSelect: controls.toggleMute },
    { label: "Solo", shortcut: "S", checked: controls.soloed, onSelect: controls.toggleSolo },
    "separator",
    { label: "Fader to 0 dB", shortcut: "0", onSelect: () => controls.setFader(0) },
    { label: "Fader to −∞", onSelect: () => controls.setFader(-144) },
    ...(controls.centrePan ? [{ label: "Pan to centre", shortcut: "C", onSelect: controls.centrePan }] : []),
    "separator",
    { label: "Rename…", shortcut: "F2", disabled: locked, hint: lockedHint, onSelect: () => startRename("strip") },
    ...(locked && source && controls.renameSource
      ? [{ label: `Rename source ${sourceLabel(source)}…`, shortcut: "⇧F2", hint: "Every strip that follows it shows the new name", onSelect: () => startRename("source") }]
      : []),
    {
      kind: "swatches",
      label: "Colour",
      options: WING_COLORS.map((c, i) => ({ value: i + 1, name: c.name, hex: c.hex })),
      value: controls.col,
      disabled: locked,
      hint: locked && source ? `Follows ${sourceLabel(source)}` : undefined,
      onSelect: controls.setColor,
    },
    ...(link
      ? [
          {
            label: "Link name & colour to source",
            shortcut: "L",
            checked: link.linked,
            disabled: !link.linked && !source,
            hint: source ? sourceLabel(source) : "Nothing is patched to it",
            onSelect: link.toggle,
          },
        ]
      : []),
  ];
  const views: MenuEntry[] = [
    ...(opens.processing ? [{ label: "EQ / Gate / Dyn", shortcut: "E", onSelect: () => goTo({ section: "processing" }) }] : []),
    ...(opens.routing ? [{ label: "Sends", shortcut: "R", onSelect: () => goTo({ section: "routing" }) }] : []),
    ...(opens.identity ? [{ label: "Name, colour & icon", shortcut: "I", onSelect: () => goTo({ tab: "identity" }) }] : []),
  ];
  if (views.length > 0) entries.push("separator", ...views);

  const selected = list.isSelected(index);
  const nameNode =
    renaming !== null ? (
      <RenameInput
        initial={controls.name}
        maxLength={renaming === "source" ? 16 : NAME_MAX[strip.kind]}
        label={renaming === "source" && source ? `New name for ${sourceLabel(source)}` : `New name for ${title}`}
        onDone={finishRename}
      />
    ) : (
      <>
        <span
          className={controls.name ? "mixer-strip__name" : "mixer-strip__name mixer-strip__name--empty"}
          title={controls.name || undefined}
          onDoubleClick={() => startRename("strip")}
        >
          {controls.name || "Unnamed"}
        </span>
        {locked && source && (
          <span className="strip-link" title={`Name, colour and icon follow ${sourceLabel(source)}`}>
            <LinkGlyph />
            {source.group}
            {source.index}
          </span>
        )}
      </>
    );

  const menuButton = (
    <button
      type="button"
      className="mixer-solo strip-menu-button"
      aria-label={`${title} actions`}
      aria-haspopup="menu"
      aria-expanded={menuAt !== null}
      title="Actions (right-click the strip)"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setMenuAt({ x: rect.left, y: rect.bottom + 4 });
      }}
    >
      ⋯
    </button>
  );

  return (
    <div
      ref={(el) => {
        rowRef.current = el;
        list.rowRef(index)(el);
      }}
      className={selected ? `${className} mixer-strip--selected` : className}
      style={style}
      role="group"
      aria-label={`${title}${controls.name ? `, ${controls.name}` : ""}`}
      aria-current={selected || undefined}
      tabIndex={list.tabIndexFor(index)}
      onFocus={() => list.select(index)}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
    >
      {children({ name: nameNode, menuButton })}
      {menuAt && (
        <ContextMenu
          at={menuAt}
          label={`${title} actions`}
          title={
            <>
              {title} · {controls.name || "Unnamed"}
            </>
          }
          subtitle={locked && source ? `Name, colour and icon follow ${sourceLabel(source)}` : undefined}
          entries={entries}
          onClose={() => setMenuAt(null)}
        />
      )}
    </div>
  );
}
