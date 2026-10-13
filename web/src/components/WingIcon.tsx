import type { JSX } from "react";
import { wingGlyph } from "../wing-icons/index.js";

/**
 * A strip's console icon, drawn in the current text colour. Renders an empty slot of the same size
 * for "no icon" (0) so rows stay aligned, unless `hideEmpty`.
 */
export function WingIcon({ id, title, hideEmpty = false }: { id: number; title?: string; hideEmpty?: boolean }): JSX.Element | null {
  const glyph = wingGlyph(id);
  if (!glyph) return hideEmpty ? null : <span className="wing-icon wing-icon--empty" aria-hidden="true" />;
  return (
    <span className="wing-icon" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} title={title}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {glyph.fill && <path d={glyph.fill} fill="currentColor" fillRule={glyph.evenodd ? "evenodd" : undefined} />}
        {glyph.stroke && (
          <path d={glyph.stroke} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </span>
  );
}
