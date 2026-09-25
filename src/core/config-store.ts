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
  server: {
    authToken?: string;
    publicUrl?: string;
    oauthClients?: Record<string, unknown>;
    oauthTokens?: unknown;
    passkeys?: unknown;
    security?: unknown;
    transports?: unknown;
    tools?: unknown;
  };
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
    // Dynamically-registered OAuth clients (core/oauth.ts) — kept loosely typed rather than
    // mirroring the SDK's OAuthClientInformationFull shape here, same rationale as `plugins` below.
    oauthClients: z.record(z.unknown()).optional(),
    // Access and refresh tokens issued to those clients (core/oauth.ts), stored hashed. Validated
    // entry by entry over there, for the same reason as `passkeys` below.
    oauthTokens: z.unknown().optional(),
    // Registered passkeys + the web sessions they opened (core/passkeys.ts). Validated entry by
    // entry over there instead: one malformed entry must not make this whole file look corrupt and
    // get reset to defaults — that would also throw away the auth token above.
    passkeys: z.unknown().optional(),
    // Opt-in hardening (core/security-config.ts). Kept loosely typed here for the same reason as
    // `passkeys` above: a block that fails its own validation must be reported and skipped, not
    // make this whole file look corrupt and take the auth token down with it.
    security: z.unknown().optional(),
    // Which transports to serve MCP over (core/transport-config.ts). Loosely typed for the same
    // reason as the two above.
    transports: z.unknown().optional(),
    // Which tools are advertised to MCP clients (core/tool-visibility.ts). Same rationale as
    // `security` above: absent means every tool is exposed, and a block that fails its own
    // validation is reported and skipped rather than condemning the whole file.
    tools: z.unknown().optional(),
  }),
  plugins: z.record(z.unknown()),
});

function defaultConfig(): PersistedConfigFile {
  return { version: 1, server: {}, plugins: {} };
}

/**
 * This file holds the master auth token, the client secrets of every dynamically-registered OAuth
 * client, and the passkey/session state — i.e. everything needed to take over the console. Node
 * defaults new files to 0o666 & ~umask, which is 0644 under the usual umask 022, so any local
 * account could read it. Not configurable: no deployment legitimately wants a world-readable
 * secrets file. Both are no-ops on Windows, where the file inherits the directory's ACL instead.
 */
const SECRET_FILE_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;

// JSON-file-backed config store. Writes are atomic (write to a temp file in
// the same directory, fsync, then rename) and serialized through a single
// write queue so concurrent callers never interleave writes.
export class ConfigStore {
  /** Where this store persists — named in messages that send an operator to the file. */
  readonly filePath: string;
  private data: PersistedConfigFile = defaultConfig();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(opts: { filePath: string }) {
    this.filePath = opts.filePath;
  }

  async load(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: SECRET_DIR_MODE });

    let raw: string;
    try {
      raw = await fs.promises.readFile(this.filePath, "utf8");
      await this.restrictExistingFileMode();
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

  /**
   * Tightens the permissions of a config file written before this server enforced them, so an
   * upgrade actually protects existing installs rather than only new ones. Best-effort: a
   * filesystem that does not support chmod (a Windows share, some bind mounts) must not stop the
   * server from starting over a permission bit.
   */
  private async restrictExistingFileMode(): Promise<void> {
    try {
      const stats = await fs.promises.stat(this.filePath);
      if ((stats.mode & 0o777) !== SECRET_FILE_MODE) {
        await fs.promises.chmod(this.filePath, SECRET_FILE_MODE);
      }
    } catch (err) {
      console.error("Could not restrict the config file's permissions (it holds the auth token):", err);
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

  // Survives restarts so a remote OAuth client (e.g. claude.ai's connector) that already completed
  // dynamic client registration doesn't get an InvalidClientError — and get treated as fully
  // unauthorized, forcing the user to redo the connect/approve dance — just because the process
  // restarted and an in-memory-only registry would otherwise have forgotten its client_id.
  getOAuthClients(): Record<string, unknown> {
    return this.data.server.oauthClients ?? {};
  }

  async setOAuthClients(clients: Record<string, unknown>): Promise<void> {
    this.data.server.oauthClients = clients;
    await this.persist();
  }

  getOAuthTokens(): unknown {
    return this.data.server.oauthTokens;
  }

  async setOAuthTokens(tokens: unknown): Promise<void> {
    this.data.server.oauthTokens = tokens;
    await this.persist();
  }

  getServerSecurity(): unknown {
    return this.data.server.security;
  }

  async setServerSecurity(security: unknown): Promise<void> {
    this.data.server.security = security;
    await this.persist();
  }

  /**
   * Read-only on purpose: nothing in this server writes `server.transports`, and a setter would
   * invite persisting a choice that belongs to a single invocation. A stored `stdio: true` would
   * make every later `node dist/index.js` — the container's CMD — start reading stdin, which is the
   * failure `resolveTransportConfig`'s environment-wins precedence exists to prevent. Editing the
   * file by hand is the supported way to set a default, and a flag still overrides it.
   */
  getServerTransports(): unknown {
    return this.data.server.transports;
  }

  getServerTools(): unknown {
    return this.data.server.tools;
  }

  async setServerTools(tools: unknown): Promise<void> {
    this.data.server.tools = tools;
    await this.persist();
  }

  getPasskeyState(): unknown {
    return this.data.server.passkeys;
  }

  async setPasskeyState(state: unknown): Promise<void> {
    this.data.server.passkeys = state;
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
    await fs.promises.mkdir(dir, { recursive: true, mode: SECRET_DIR_MODE });
    const tmpPath = path.join(dir, path.basename(this.filePath) + ".tmp-" + crypto.randomBytes(8).toString("hex"));
    const json = JSON.stringify(this.data, null, 2);

    // Mode on the *temp* file, before any secret is written to it: open() applies it at creation,
    // whereas a chmod after the fact leaves a window where the content is already on disk and
    // world-readable. The mode survives the rename below.
    const handle = await fs.promises.open(tmpPath, "w", SECRET_FILE_MODE);
    try {
      await handle.writeFile(json, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.promises.rename(tmpPath, this.filePath);
  }
}
