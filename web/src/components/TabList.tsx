import { useRef, type JSX, type KeyboardEvent } from "react";

interface TabListProps<T extends string> {
  tabs: readonly (readonly [T, string])[];
  value: T;
  onChange: (next: T) => void;
  className?: string;
  label?: string;
  /**
   * Ties the tabs to the panel they switch (`aria-controls`): pass the same base to tabPanelProps()
   * on the element that holds the selected tab's content.
   */
  idBase?: string;
}

/** The attributes for the element showing the selected tab's content: role, id and its tab's name. */
export function tabPanelProps(idBase: string, value: string): { id: string; role: "tabpanel"; "aria-labelledby": string } {
  return { id: `${idBase}-panel`, role: "tabpanel", "aria-labelledby": `${idBase}-tab-${value}` };
}

/**
 * A row of tabs that behaves like one control from the keyboard: Tab enters it on the selected
 * tab, the arrow keys (and Home/End) move and select, as in the WAI-ARIA tabs pattern.
 */
export function TabList<T extends string>({ tabs, value, onChange, className = "tabs", label, idBase }: TabListProps<T>): JSX.Element {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // From the focused tab, not `value`: two quick presses must not both start from a selection
    // that hasn't re-rendered yet.
    const focused = buttons.current.indexOf(event.target as HTMLButtonElement);
    const current = focused >= 0 ? focused : tabs.findIndex(([id]) => id === value);
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight" ? (current + 1) % tabs.length
      : event.key === "ArrowLeft" ? (current - 1 + tabs.length) % tabs.length
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(tabs[next][0]);
    buttons.current[next]?.focus();
  }

  return (
    <div className={className} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map(([id, text], i) => (
        <button
          key={id}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          role="tab"
          id={idBase ? `${idBase}-tab-${id}` : undefined}
          aria-controls={idBase && id === value ? `${idBase}-panel` : undefined}
          aria-selected={id === value}
          tabIndex={id === value ? 0 : -1}
          className={id === value ? "tabs__button tabs__button--active" : "tabs__button"}
          onClick={() => onChange(id)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
