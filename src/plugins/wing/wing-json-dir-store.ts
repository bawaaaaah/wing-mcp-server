import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { WingValueError } from "./wing-errors.js";

/**
 * Filesystem-safe, human-readable slug for a display name, e.g. "Morgane Micro KSM9" ->
 * "morgane-micro-ksm9". Accented characters are normalized away rather than dropped, so names like
 * "Basse Réverbe" still produce a stable ASCII filename.
 */
export function slugifyStoreName(name: string, what = "Preset"): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new WingValueError(`${what} name "${name}" has no usable characters for a filename`);
  }
  return slug;
}

/**
 * JSON-file-backed store: one file per named item under `dir`. Writes are atomic (temp file in the
 * same directory, fsync, then rename) — the same technique as `ConfigStore` (src/core/config-store.ts),
 * adapted for "many independently-writable files" instead of one shared blob. A per-slug write queue
 * keeps concurrent writes to the SAME item serialized without blocking writes to a DIFFERENT one. A
 * corrupt/invalid file is quarantined individually (renamed aside) rather than resetting the whole
 * store — there is no sensible default to fall back to, and one bad file should never take down every
 * other saved item.
 */
export class JsonDirectoryStore<T> {
  private readonly dir: string;
  private readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  private readonly logName: string;
  private readonly what: string;
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  constructor(opts: { dir: string; schema: z.ZodType<T, z.ZodTypeDef, unknown>; logName: string; what?: string }) {
    this.dir = opts.dir;
    this.schema = opts.schema;
    this.logName = opts.logName;
    this.what = opts.what ?? "Preset";
  }

  slugify(name: string): string {
    return slugifyStoreName(name, this.what);
  }

  /** Every valid item, in directory order (invalid files are quarantined and skipped). */
  async readAll(): Promise<T[]> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }

    const items: T[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const item = await this.readFile(path.join(this.dir, entry));
      if (item) {
        items.push(item);
      }
    }
    return items;
  }

  async get(name: string): Promise<T | null> {
    return this.readFile(path.join(this.dir, `${this.slugify(name)}.json`));
  }

  /**
   * Builds the new item from the existing one (null if none) and writes it, serialized per slug.
   * `build` may throw (e.g. to refuse an overwrite) — nothing is written then.
   */
  async save(name: string, build: (existing: T | null, slug: string) => T): Promise<T> {
    const slug = this.slugify(name);
    return this.runQueued(slug, async () => {
      const filePath = path.join(this.dir, `${slug}.json`);
      const item = build(await this.readFile(filePath), slug);
      await this.writeFile(filePath, item);
      return item;
    });
  }

  async delete(name: string): Promise<boolean> {
    const slug = this.slugify(name);
    return this.runQueued(slug, async () => {
      try {
        await fs.promises.unlink(path.join(this.dir, `${slug}.json`));
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw err;
      }
    });
  }

  /**
   * Reads+validates one file. Quarantines it (renamed aside with a `.corrupt-<timestamp>` suffix) and
   * returns null if unparseable or schema-invalid, without affecting any other item.
   */
  private async readFile(filePath: string): Promise<T | null> {
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

    const result = this.schema.safeParse(parsed);
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
      console.error(`[${this.logName}] quarantined ${filePath} (${reason}), renamed to ${quarantinePath}`);
    } catch (renameErr) {
      console.error(`[${this.logName}] failed to quarantine ${filePath} (${reason}):`, renameErr);
    }
  }

  private async writeFile(filePath: string, item: T): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const tmpPath = path.join(this.dir, path.basename(filePath) + ".tmp-" + crypto.randomBytes(8).toString("hex"));
    const json = JSON.stringify(item, null, 2);

    const handle = await fs.promises.open(tmpPath, "w");
    try {
      await handle.writeFile(json, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.promises.rename(tmpPath, filePath);
  }

  /** Serializes concurrent operations on the same slug; different slugs never block each other. */
  private runQueued<R>(slug: string, fn: () => Promise<R>): Promise<R> {
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
