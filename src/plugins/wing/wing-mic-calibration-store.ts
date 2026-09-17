import { z } from "zod";
import { WingValueError } from "./wing-errors.js";
import { JsonDirectoryStore } from "./wing-json-dir-store.js";

/** Saved measurement mics ("presets par micro"): a name, serial/notes, and a 0° and/or 90° calibration curve. */

export const MIC_CALIBRATION_FORMAT_VERSION = 1 as const;
export const MIC_ORIENTATIONS = [0, 90] as const;
export type MicOrientation = (typeof MIC_ORIENTATIONS)[number];

const CurveSchema = z.object({
  sourceFiles: z.array(z.string()),
  points: z.array(z.object({ hz: z.number(), db: z.number() })).min(1),
});

export const MicCalibrationFileSchema = z
  .object({
    formatVersion: z.literal(1),
    name: z.string().min(1),
    serial: z.string(),
    notes: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    curves: z.object({ deg0: CurveSchema.nullable(), deg90: CurveSchema.nullable() }),
  })
  .refine((f) => f.curves.deg0 !== null || f.curves.deg90 !== null, { message: "at least one curve is required" });

export type MicCalibrationCurve = z.infer<typeof CurveSchema>;
export type MicCalibrationFile = z.infer<typeof MicCalibrationFileSchema>;

export interface MicCalibrationSummary {
  name: string;
  serial: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  orientations: MicOrientation[];
  /** Covered frequency range of each available curve. */
  ranges: Partial<Record<"deg0" | "deg90", { minHz: number; maxHz: number; pointCount: number }>>;
}

export function curveKey(orientation: MicOrientation): "deg0" | "deg90" {
  return orientation === 90 ? "deg90" : "deg0";
}

export function summarizeMicCalibration(file: MicCalibrationFile): MicCalibrationSummary {
  const ranges: MicCalibrationSummary["ranges"] = {};
  for (const orientation of MIC_ORIENTATIONS) {
    const curve = file.curves[curveKey(orientation)];
    if (curve) ranges[curveKey(orientation)] = { minHz: curve.points[0].hz, maxHz: curve.points[curve.points.length - 1].hz, pointCount: curve.points.length };
  }
  return {
    name: file.name,
    serial: file.serial,
    notes: file.notes,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    orientations: MIC_ORIENTATIONS.filter((o) => file.curves[curveKey(o)] !== null),
    ranges,
  };
}

export class WingMicCalibrationStore {
  private readonly files: JsonDirectoryStore<MicCalibrationFile>;

  constructor(opts: { dir: string }) {
    this.files = new JsonDirectoryStore({
      dir: opts.dir,
      schema: MicCalibrationFileSchema,
      logName: "wing-mic-calibration-store",
      what: "Mic",
    });
  }

  async list(): Promise<MicCalibrationSummary[]> {
    return (await this.files.readAll()).map(summarizeMicCalibration).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<MicCalibrationFile | null> {
    return this.files.get(name);
  }

  async save(
    input: {
      name: string;
      serial?: string;
      notes?: string;
      curves: { deg0: MicCalibrationCurve | null; deg90: MicCalibrationCurve | null };
    },
    opts: { overwrite?: boolean } = {},
  ): Promise<MicCalibrationFile> {
    if (!input.name.trim()) throw new WingValueError("A mic needs a name.");
    if (!input.curves.deg0 && !input.curves.deg90) {
      throw new WingValueError(`Mic "${input.name}" needs at least one calibration curve (0° or 90°).`);
    }
    return this.files.save(input.name, (existing, slug) => {
      if (existing && !opts.overwrite) {
        throw new WingValueError(`A mic named "${existing.name}" already exists (${slug}.json) — pass overwrite: true to replace it.`);
      }
      const now = new Date().toISOString();
      return {
        formatVersion: MIC_CALIBRATION_FORMAT_VERSION,
        name: input.name.trim(),
        serial: input.serial?.trim() ?? "",
        notes: input.notes?.trim() ?? "",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        curves: input.curves,
      };
    });
  }

  async delete(name: string): Promise<boolean> {
    return this.files.delete(name);
  }
}
