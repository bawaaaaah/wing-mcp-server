interface RtaSpectrumProps {
  bandsDb: number[];
  min?: number;
  max?: number;
}

/**
 * The console's protocol reference gives the RTA's band count (120) but not each band's center
 * frequency, so bands are rendered in raw wire order (ascending frequency, unlabeled) rather than
 * with Hz ticks — labeling them would mean guessing a frequency mapping never confirmed against
 * hardware.
 */
export function RtaSpectrum({ bandsDb, min = -80, max = 0 }: RtaSpectrumProps) {
  return (
    <div className="rta-spectrum">
      {bandsDb.map((db, i) => {
        const safeDb = Number.isFinite(db) ? db : min;
        const clamped = Math.min(max, Math.max(min, safeDb));
        const pct = ((clamped - min) / (max - min)) * 100;
        return <div key={i} className="rta-spectrum__band" style={{ height: pct + "%" }} />;
      })}
    </div>
  );
}
