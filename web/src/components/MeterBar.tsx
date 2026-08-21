interface MeterBarProps {
  label: string;
  db: number;
  min?: number;
  max?: number;
  /** dB level where the fixed color scale switches from green to orange. */
  orangeAt?: number;
  /** dB level where the fixed color scale switches from orange to red. */
  redAt?: number;
}

function pctOf(value: number, min: number, max: number): number {
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

/**
 * The color scale is fixed to the track's absolute min..max range (green below orangeAt, orange
 * between orangeAt and redAt, red above redAt) rather than stretched over the current reading —
 * painting the gradient directly on the fill (whose height changes with the signal) would restretch
 * its own percentage stops every time, so the same pixel row shows a different color depending on
 * how loud the signal happens to be. Instead the gradient image is rendered at the track's fixed
 * height and anchored to the bottom (see .meter-bar__fill's background-size/-position in
 * styles.css), so only how much of that fixed image is revealed changes, never its colors.
 */
export function MeterBar({ label, db, min = -60, max = 6, orangeAt = -18, redAt = -3 }: MeterBarProps) {
  const safeDb = Number.isFinite(db) ? db : -144;
  const clamped = Math.min(max, Math.max(min, safeDb));
  const pct = pctOf(clamped, min, max);
  const orangePct = pctOf(orangeAt, min, max);
  const redPct = pctOf(redAt, min, max);
  const gradient = `linear-gradient(to top, #3aa657 0%, #3aa657 ${orangePct}%, #d69e2e ${orangePct}%, #d69e2e ${redPct}%, #e05252 ${redPct}%, #e05252 100%)`;

  return (
    <div className="meter-bar">
      <div className="meter-bar__label">{label}</div>
      <div className="meter-bar__track">
        <div className="meter-bar__fill" style={{ height: pct + "%", backgroundImage: gradient }} />
      </div>
      <div className="meter-bar__value">{safeDb <= -144 ? "-inf" : safeDb.toFixed(1)}</div>
    </div>
  );
}
