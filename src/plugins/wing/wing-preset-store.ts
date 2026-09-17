import { z } from "zod";
import { STRIP_TYPES } from "./wing-node-paths.js";
import { JsonDirectoryStore, slugifyStoreName } from "./wing-json-dir-store.js";
import { WingValueError } from "./wing-errors.js";

export const PRESET_FILE_FORMAT_VERSION = 1 as const;

const PresetSlotSchema = z.object({
  sourceIndex: z.number().int().min(1),
  raw: z.record(z.union([z.number(), z.string()])),
  corrected: z.object({
    tags: z.string(),
    inConnGrp: z.string().nullable(),
    inConnIn: z.number().nullable(),
    inSetTrim: z.number().nullable(),
    inSetSrcauto: z.boolean().nullable(),
    ownName: z.string(),
    effectiveName: z.string(),
  }),
  preampGain: z
    .object({
      value: z.number(),
      capturedFromSource: z.object({ group: z.string(), index: z.number() }),
    })
    .nullable(),
});

export const PresetFileSchema = z.object({
  formatVersion: z.literal(1),
  name: z.string().min(1),
  type: z.enum(STRIP_TYPES),
  createdAt: z.string(),
  updatedAt: z.string(),
  slots: z.array(PresetSlotSchema).min(1),
});

export type PresetSlot = z.infer<typeof PresetSlotSchema>;
export type PresetFile = z.infer<typeof PresetFileSchema>;

export interface PresetSummary {
  name: string;
  type: PresetFile["type"];
  createdAt: string;
  updatedAt: string;
  slotCount: number;
  sourceIndices: number[];
}

/**
 * Filesystem-safe, human-readable slug for a preset's display name, e.g. "Morgane Micro KSM9" ->
 * "morgane-micro-ksm9" (see `slugifyStoreName`).
 */
export function slugifyPresetName(name: string): string {
  return slugifyStoreName(name, "Preset");
}

/**
 * JSON-file-backed preset store: one file per named preset under `dir`, with atomic writes, per-preset
 * write serialization and per-file quarantine of corrupt files — see `JsonDirectoryStore`.
 */
export class WingPresetStore {
  private readonly files: JsonDirectoryStore<PresetFile>;

  constructor(opts: { dir: string }) {
    this.files = new JsonDirectoryStore({ dir: opts.dir, schema: PresetFileSchema, logName: "wing-preset-store" });
  }

  async list(): Promise<PresetSummary[]> {
    const summaries = (await this.files.readAll()).map((file) => ({
      name: file.name,
      type: file.type,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      slotCount: file.slots.length,
      sourceIndices: file.slots.map((s) => s.sourceIndex),
    }));
    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<PresetFile | null> {
    return this.files.get(name);
  }

  async save(
    input: { name: string; type: PresetFile["type"]; slots: PresetSlot[] },
    opts: { overwrite?: boolean } = {},
  ): Promise<PresetFile> {
    return this.files.save(input.name, (existing, slug) => {
      if (existing && !opts.overwrite) {
        throw new WingValueError(
          `A preset named "${existing.name}" already exists (${slug}.json) — pass overwrite: true to replace it.`,
        );
      }
      const now = new Date().toISOString();
      return {
        formatVersion: PRESET_FILE_FORMAT_VERSION,
        name: input.name,
        type: input.type,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        slots: input.slots,
      };
    });
  }

  async delete(name: string): Promise<boolean> {
    return this.files.delete(name);
  }
}
