import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MenuAction {
  kind?: "action";
  label: string;
  /** The key that does the same from the strip list ("M", "F2"), shown on the right. */
  shortcut?: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Set for an on/off item: drawn with a check and announced as a checkbox. */
  checked?: boolean;
  /** A second, quieter line: why the item is disabled, or what it acts on. */
  hint?: string;
}

/** A row of colour swatches, picked with ←/→ once ↑/↓ has reached it. */
export interface MenuSwatches {
  kind: "swatches";
  label: string;
  options: readonly { value: number; name: string; hex: string }[];
  value: number;
  onSelect: (value: number) => void;
  disabled?: boolean;
  hint?: string;
}

export type MenuEntry = MenuAction | MenuSwatches | "separator";

/** Keeps the menu this far inside the viewport's edges. */
const EDGE_PX = 8;

/**
 * A menu at a point of the viewport, as a right-click or the keyboard's menu key opens it: the
 * first item takes focus, ↑/↓ (Home/End) move between items, ←/→ along a swatch row, Enter picks,
 * Escape or a click elsewhere closes it and gives focus back to where it was.
 */
export function ContextMenu({
  at,
  label,
  title,
  subtitle,
  entries,
  onClose,
}: {
  at: { x: number; y: number };
  label: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  entries: MenuEntry[];
  onClose: () => void;
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  // Laid out first in the top-left corner, where nothing squeezes it: measured at a point near the
  // right edge it would come out narrower than it ends up. Moved before the first paint.
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Opened near the right or bottom edge, the menu moves back in rather than spilling off-screen.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPosition({
      x: Math.max(EDGE_PX, Math.min(at.x, window.innerWidth - width - EDGE_PX)),
      y: Math.max(EDGE_PX, Math.min(at.y, window.innerHeight - height - EDGE_PX)),
    });
  }, [at.x, at.y]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rows(menuRef.current)[0]?.[0]?.focus({ preventScroll: true });

    const close = () => onCloseRef.current();
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    // The page moving under it would leave the menu pointing at the wrong row.
    const onScroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      // Back to the row (or button) it was opened from, unless something else took focus since.
      if (opener && (document.activeElement === document.body || menuRef.current?.contains(document.activeElement))) opener.focus();
    };
  }, []);

  function pick(action: () => void): void {
    onClose();
    action();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const all = rows(menuRef.current);
    const focused = event.target as HTMLElement;
    const r = all.findIndex((row) => row.includes(focused));
    const c = r >= 0 ? all[r].indexOf(focused) : -1;
    const focusRow = (next: number) => {
      const row = all[(next + all.length) % all.length];
      (row.find((el) => el.getAttribute("aria-checked") === "true") ?? row[0])?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        focusRow(r + 1);
        break;
      case "ArrowUp":
        focusRow(r < 0 ? all.length - 1 : r - 1);
        break;
      case "Home":
        focusRow(0);
        break;
      case "End":
        focusRow(all.length - 1);
        break;
      case "ArrowRight":
      case "ArrowLeft":
        if (r < 0 || all[r].length < 2) return;
        all[r][(c + (event.key === "ArrowRight" ? 1 : -1) + all[r].length) % all[r].length]?.focus();
        break;
      case "Escape":
        onClose();
        break;
      case "Tab":
        onClose();
        event.stopPropagation();
        return;
      default:
        event.stopPropagation();
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  let nextRow = 0;
  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={label}
      style={{ left: position.x, top: position.y }}
      onKeyDown={onKeyDown}
      // A portal still bubbles through the React tree: the row it was opened from must not see
      // a right-click (or a key) meant for the menu.
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {(title || subtitle) && (
        <div className="context-menu__header">
          {title && <div className="context-menu__title">{title}</div>}
          {subtitle && <div className="context-menu__subtitle">{subtitle}</div>}
        </div>
      )}
      {entries.map((entry, i) => {
        if (entry === "separator") return <div key={i} className="context-menu__separator" role="separator" />;
        const rowIndex = nextRow++;
        if (entry.kind === "swatches") {
          return (
            <div key={i} className="context-menu__swatches" role="group" aria-label={entry.label}>
              <span className="context-menu__label">{entry.label}</span>
              <span className="context-menu__swatch-row">
                {entry.options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    data-menu-row={rowIndex}
                    tabIndex={-1}
                    aria-checked={option.value === entry.value}
                    aria-disabled={entry.disabled || undefined}
                    aria-label={`${entry.label}: ${option.name}`}
                    title={option.name}
                    className={option.value === entry.value ? "context-menu__swatch context-menu__swatch--on" : "context-menu__swatch"}
                    style={{ background: option.hex }}
                    onClick={() => !entry.disabled && pick(() => entry.onSelect(option.value))}
                  />
                ))}
              </span>
              {entry.hint && <span className="context-menu__hint">{entry.hint}</span>}
            </div>
          );
        }
        return (
          <button
            key={i}
            type="button"
            role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={entry.checked}
            aria-disabled={entry.disabled || undefined}
            data-menu-row={rowIndex}
            tabIndex={-1}
            className="context-menu__item"
            onClick={() => !entry.disabled && pick(entry.onSelect)}
          >
            <span className="context-menu__check" aria-hidden="true">
              {entry.checked ? "✓" : ""}
            </span>
            <span className="context-menu__text">
              <span className="context-menu__label">{entry.label}</span>
              {entry.hint && <span className="context-menu__hint">{entry.hint}</span>}
            </span>
            {entry.shortcut && <kbd className="context-menu__shortcut">{entry.shortcut}</kbd>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

/** The menu's focusable items, grouped by row: one per item, a swatch row being one row. */
function rows(menu: HTMLElement | null): HTMLElement[][] {
  const grouped: HTMLElement[][] = [];
  for (const el of menu?.querySelectorAll<HTMLElement>("[data-menu-row]") ?? []) {
    const r = Number(el.dataset.menuRow);
    (grouped[r] ??= []).push(el);
  }
  return grouped.filter(Boolean);
}
