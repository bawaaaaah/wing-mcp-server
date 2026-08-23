import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { STRIP_TYPES } from "./wing-node-paths.js";
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
 * "morgane-micro-ksm9". Accented characters are normalized away rather than dropped, so names like
 * "Basse Réverbe" still produce a stable ASCII filename.
 */
export function slugifyPresetName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new WingValueError(`Preset name "${name}" has no usable characters for a filename`);
  }
  return slug;
}

/**
 * JSON-file-backed preset store: one file per named preset under `dir`. Writes are atomic (temp
 * file in the same directory, fsync, then rename) — the same technique as `ConfigStore`
 * (src/core/config-store.ts), adapted for "many independently-writable files" instead of one shared
 * blob. A per-slug write queue keeps concurrent writes to the SAME preset serialized without
 * blocking writes to a DIFFERENT one. A corrupt/invalid file is quarantined individually (renamed
 * aside) rather than resetting the whole store — there is no sensible "default preset" to fall back
 * to, and one bad file should never take down every other saved preset.
 */
export class WingPresetStore {
  private readonly dir: string;
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  constructor(opts: { dir: string }) {
    this.dir = opts.dir;
  }

  async list(): Promise<PresetSummary[]> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }

    const summaries: PresetSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const file = await this.readFile(path.join(this.dir, entry));
      if (!file) {
        continue;
      }
      summaries.push({
        name: file.name,
        type: file.type,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        slotCount: file.slots.length,
        sourceIndices: file.slots.map((s) => s.sourceIndex),
      });
    }
    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<PresetFile | null> {
    return this.readFile(this.filePathFor(name));
  }

  async save(
    input: { name: string; type: PresetFile["type"]; slots: PresetSlot[] },
    opts: { overwrite?: boolean } = {},
  ): Promise<PresetFile> {
    const slug = slugifyPresetName(input.name);
    return this.runQueued(slug, async () => {
      const filePath = path.join(this.dir, `${slug}.json`);
      const existing = await this.readFile(filePath);
      if (existing && !opts.overwrite) {
        throw new WingValueError(
          `A preset named "${existing.name}" already exists (${slug}.json) — pass overwrite: true to replace it.`,
        );
      }

      const now = new Date().toISOString();
      const file: PresetFile = {
        formatVersion: PRESET_FILE_FORMAT_VERSION,
        name: input.name,
        type: input.type,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        slots: input.slots,
      };

      await this.writeFile(filePath, file);
      return file;
    });
  }

  async delete(name: string): Promise<boolean> {
    const slug = slugifyPresetName(name);
    return this.runQueued(slug, async () => {
      const filePath = path.join(this.dir, `${slug}.json`);
      try {
        await fs.promises.unlink(filePath);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw err;
      }
    });
  }

  private filePathFor(name: string): string {
    return path.join(this.dir, `${slugifyPresetName(name)}.json`);
  }

  /**
   * Reads+validates one preset file. Quarantines it (renamed aside with a `.corrupt-<timestamp>`
   * suffix) and returns null if unparseable or schema-invalid, without affecting any other preset.
   */
  private async readFile(filePath: string): Promise<PresetFile | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      await this.quarantine(filePath, `invalid JSON: ${(err as Error).message}`);
      return null;
    }

    const result = PresetFileSchema.safeParse(parsed);
    if (!result.success) {
      await this.quarantine(filePath, `schema validation failed: ${result.error.message}`);
      return null;
    }
    return result.data;
  }

  private async quarantine(filePath: string, reason: string): Promise<void> {
    const quarantinePath = filePath + ".corrupt-" + Date.now();
    try {
      await fs.promises.rename(filePath, quarantinePath);
      console.error(`[wing-preset-store] quarantined ${filePath} (${reason}), renamed to ${quarantinePath}`);
    } catch (renameErr) {
      console.error(`[wing-preset-store] failed to quarantine ${filePath} (${reason}):`, renameErr);
    }
  }

  private async writeFile(filePath: string, file: PresetFile): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const tmpPath = path.join(this.dir, path.basename(filePath) + ".tmp-" + crypto.randomBytes(8).toString("hex"));
    const json = JSON.stringify(file, null, 2);

    const handle = await fs.promises.open(tmpPath, "w");
    try {
      await handle.writeFile(json, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.promises.rename(tmpPath, filePath);
  }

  /** Serializes concurrent operations on the same preset slug; different slugs never block each other. */
  private runQueued<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(slug) ?? Promise.resolve();
    const settled = previous.then(
      () => undefined,
      () => undefined,
    );
    const result = settled.then(fn);
    this.writeQueues.set(
      slug,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}
