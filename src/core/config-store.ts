import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export interface ScopedConfigStore {
  get(): unknown;
  set(config: unknown): Promise<void>;
}

export interface PersistedConfigFile {
  version: 1;
  server: { authToken?: string; publicUrl?: string };
  plugins: Record<string, unknown>;
}

// Validates the parsed JSON has the shape callers rely on (server.authToken as a
// string, plugins as a plain object), so a syntactically valid but malformed file
// (e.g. `{}`) falls back to defaults instead of crashing later — e.g.
// resolveAuthToken() dereferencing `server.authToken` on a config with no `server`.
const persistedConfigSchema: z.ZodType<PersistedConfigFile> = z.object({
  version: z.literal(1),
  server: z.object({
    authToken: z.string().optional(),
    publicUrl: z.string().optional(),
  }),
  plugins: z.record(z.unknown()),
});

function defaultConfig(): PersistedConfigFile {
  return { version: 1, server: {}, plugins: {} };
}

// JSON-file-backed config store. Writes are atomic (write to a temp file in
// the same directory, fsync, then rename) and serialized through a single
// write queue so concurrent callers never interleave writes.
export class ConfigStore {
  private readonly filePath: string;
  private data: PersistedConfigFile = defaultConfig();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(opts: { filePath: string }) {
    this.filePath = opts.filePath;
  }

  async load(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });

    let raw: string;
    try {
      raw = await fs.promises.readFile(this.filePath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error("Failed to read config file, starting with defaults:", err);
      }
      this.data = defaultConfig();
      return;
    }

    try {
      this.data = persistedConfigSchema.parse(JSON.parse(raw));
    } catch (err) {
      const corruptPath = this.filePath + ".corrupt-" + Date.now();
      try {
        await fs.promises.rename(this.filePath, corruptPath);
      } catch (renameErr) {
        console.error("Failed to rename corrupt config file:", renameErr);
      }
      console.error("Config file contained invalid JSON or an unexpected shape, resetting to defaults:", err);
      this.data = defaultConfig();
    }
  }

  getServerAuthToken(): string | undefined {
    return this.data.server.authToken;
  }

  async setServerAuthToken(token: string): Promise<void> {
    this.data.server.authToken = token;
    await this.persist();
  }

  getServerPublicUrl(): string | undefined {
    return this.data.server.publicUrl;
  }

  async setServerPublicUrl(url: string): Promise<void> {
    this.data.server.publicUrl = url;
    await this.persist();
  }

  getPluginConfig(id: string): unknown {
    return this.data.plugins[id];
  }

  async setPluginConfig(id: string, config: unknown): Promise<void> {
    this.data.plugins[id] = config;
    await this.persist();
  }

  scoped(id: string): ScopedConfigStore {
    return {
      get: () => this.getPluginConfig(id),
      set: (config: unknown) => this.setPluginConfig(id, config),
    };
  }

  private persist(): Promise<void> {
    const result = this.writeQueue.then(() => this.writeNow());
    // Keep the queue alive even if this write fails, so later writes aren't
    // permanently blocked behind a rejected promise.
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  private async writeNow(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmpPath = path.join(dir, path.basename(this.filePath) + ".tmp-" + crypto.randomBytes(8).toString("hex"));
    const json = JSON.stringify(this.data, null, 2);

    const handle = await fs.promises.open(tmpPath, "w");
    try {
      await handle.writeFile(json, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.promises.rename(tmpPath, this.filePath);
  }
}
