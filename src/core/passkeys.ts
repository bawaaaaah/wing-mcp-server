import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { z } from "zod";
import type { AuthMiddleware } from "./auth.js";
import type { ConfigStore } from "./config-store.js";
import { HttpError } from "./http-errors.js";

// A WebAuthn ceremony is a human-scale round trip (a Touch ID prompt, a phone QR scan) — a few
// minutes is plenty, and anything unanswered after that is abandoned.
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// Login options are reachable pre-auth, so the pending-challenge map is bounded by size too, not
// just by TTL, evicting the oldest once full.
const CHALLENGES_MAX_SIZE = 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSIONS_MAX_SIZE = 100;
const PASSKEY_NAME_MAX_LENGTH = 64;

const RP_NAME = "Wing MCP Server";
// This server has a single administrator, so every passkey belongs to the same WebAuthn "user".
// A stable handle (rather than a random one per registration) lets an authenticator that already
// holds one of this server's passkeys recognize the excludeCredentials list and refuse a duplicate.
const USER_HANDLE = new Uint8Array(Buffer.from("wing-mcp-admin", "utf8"));
const USER_NAME = "wing-admin";

const storedPasskeySchema = z.object({
  id: z.string(),
  publicKey: z.string(),
  counter: z.number(),
  transports: z.array(z.string()).optional(),
  name: z.string(),
  rpId: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
});

const storedSessionSchema = z.object({
  tokenHash: z.string(),
  passkeyId: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
});

type StoredPasskey = z.infer<typeof storedPasskeySchema>;
type StoredSession = z.infer<typeof storedSessionSchema>;

export interface PasskeySummary {
  id: string;
  name: string;
  rpId: string;
  createdAt: string;
  lastUsedAt?: string;
}

/** The WebAuthn relying party a request is talking to: its RP ID (a bare hostname) and origin. */
export interface RelyingParty {
  id: string;
  origin: string;
}

/** A ceremony failure caused by the caller (bad/expired/replayed response, unknown passkey…). */
export class PasskeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasskeyError";
  }
}

function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function parseEntries<T>(raw: unknown, schema: z.ZodType<T>, label: string): T[] {
  if (!Array.isArray(raw)) return [];
  const entries: T[] = [];
  for (const entry of raw) {
    const parsed = schema.safeParse(entry);
    if (parsed.success) entries.push(parsed.data);
    else console.error("Ignoring malformed persisted " + label + ":", parsed.error.message);
  }
  return entries;
}

function requireResponseObject(response: unknown): void {
  if (!response || typeof response !== "object") throw new PasskeyError("Missing passkey response");
}

function summarize(passkey: StoredPasskey): PasskeySummary {
  return {
    id: passkey.id,
    name: passkey.name,
    rpId: passkey.rpId,
    createdAt: passkey.createdAt,
    lastUsedAt: passkey.lastUsedAt,
  };
}

/**
 * Passkey (WebAuthn) sign-in for the dashboard and the OAuth approval page, as an alternative to
 * pasting the static server token. A successful passkey login never hands out that static token:
 * it opens a separate, revocable, expiring web session instead, so what ends up in a browser's
 * localStorage is not the master secret MCP clients use. The static token keeps working everywhere,
 * and stays the only option where WebAuthn can't run (plain-http LAN addresses aren't a secure
 * context, and an IP address can't be a WebAuthn RP ID).
 *
 * Passkeys and sessions are persisted through the config store, so neither a registered passkey nor
 * an open dashboard session is lost on restart.
 */
export class PasskeyService {
  private readonly passkeys: StoredPasskey[];
  private readonly sessions = new Map<string, StoredSession>();
  private readonly challenges = new Map<string, { purpose: "register" | "login"; expiresAt: number }>();

  constructor(
    private readonly configStore: ConfigStore,
    private readonly publicUrl: URL,
  ) {
    const state = configStore.getPasskeyState() as { credentials?: unknown; sessions?: unknown } | undefined;
    this.passkeys = parseEntries(state?.credentials, storedPasskeySchema, "passkey");
    const now = Date.now();
    for (const session of parseEntries(state?.sessions, storedSessionSchema, "web session")) {
      if (session.expiresAt > now) this.sessions.set(session.tokenHash, session);
    }
  }

  /**
   * Passkeys are bound to a hostname, so they only work on origins we deliberately recognize: the
   * configured public URL (which must be HTTPS — WebAuthn requires a secure context), plus
   * localhost on any port for local use and the Vite dev server. Anything else — notably a LAN IP —
   * is refused rather than guessed at.
   */
  resolveRelyingParty(origin: string | undefined): RelyingParty | undefined {
    if (!origin) return undefined;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return undefined;
    }
    if (url.hostname === "localhost" && (url.protocol === "http:" || url.protocol === "https:")) {
      return { id: url.hostname, origin: url.origin };
    }
    if (url.origin === this.publicUrl.origin && url.protocol === "https:") {
      return { id: url.hostname, origin: url.origin };
    }
    return undefined;
  }

  /** Ceremonies are always POSTs, on which browsers always send Origin — deliberately not guessed
   * from Host, which a reverse proxy may well have rewritten. */
  relyingPartyFor(req: Request): RelyingParty | undefined {
    return this.resolveRelyingParty(req.headers.origin);
  }

  /** Any passkey at all, or only those bound to `rpId` when given. */
  hasPasskeys(rpId?: string): boolean {
    return this.passkeys.some((passkey) => rpId === undefined || passkey.rpId === rpId);
  }

  list(): PasskeySummary[] {
    return this.passkeys.map(summarize);
  }

  async registrationOptions(rp: RelyingParty): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rp.id,
      userName: USER_NAME,
      userDisplayName: RP_NAME,
      userID: USER_HANDLE,
      attestationType: "none",
      excludeCredentials: this.passkeys
        .filter((passkey) => passkey.rpId === rp.id)
        .map((passkey) => ({ id: passkey.id, transports: passkey.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    this.rememberChallenge(options.challenge, "register");
    return options;
  }

  async register(rp: RelyingParty, response: RegistrationResponseJSON, name: string): Promise<PasskeySummary> {
    requireResponseObject(response);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: this.challengeChecker("register"),
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: true,
      });
    } catch (err) {
      throw new PasskeyError(err instanceof Error ? err.message : String(err));
    }
    if (!verification.verified) throw new PasskeyError("Passkey registration could not be verified");

    const { credential } = verification.registrationInfo;
    if (this.passkeys.some((passkey) => passkey.id === credential.id)) {
      throw new PasskeyError("This passkey is already registered");
    }
    const passkey: StoredPasskey = {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: credential.transports ?? response.response.transports,
      name: name.trim().slice(0, PASSKEY_NAME_MAX_LENGTH) || "Passkey",
      rpId: rp.id,
      createdAt: new Date().toISOString(),
    };
    this.passkeys.push(passkey);
    await this.persist();
    return summarize(passkey);
  }

  async authenticationOptions(rp: RelyingParty): Promise<PublicKeyCredentialRequestOptionsJSON> {
    if (!this.hasPasskeys(rp.id)) throw new PasskeyError("No passkey is registered for " + rp.id);
    // No allowCredentials: every passkey here is discoverable, so the browser offers whichever of
    // them the user has without the server first having to ask "who are you".
    const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: "required" });
    this.rememberChallenge(options.challenge, "login");
    return options;
  }

  /** Verifies a login assertion and returns the passkey it was made with (its counter bumped). */
  async authenticate(rp: RelyingParty, response: AuthenticationResponseJSON): Promise<PasskeySummary> {
    requireResponseObject(response);
    const passkey = this.passkeys.find((candidate) => candidate.id === response.id);
    if (!passkey) throw new PasskeyError("Unknown passkey");

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: this.challengeChecker("login"),
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")),
          counter: passkey.counter,
          transports: passkey.transports,
        },
        requireUserVerification: true,
      });
    } catch (err) {
      throw new PasskeyError(err instanceof Error ? err.message : String(err));
    }
    if (!verification.verified) throw new PasskeyError("Passkey assertion could not be verified");

    passkey.counter = verification.authenticationInfo.newCounter;
    passkey.lastUsedAt = new Date().toISOString();
    await this.persist();
    return summarize(passkey);
  }

  /** Removes a passkey and closes every web session that was opened with it. */
  async remove(id: string): Promise<boolean> {
    const index = this.passkeys.findIndex((passkey) => passkey.id === id);
    if (index === -1) return false;
    this.passkeys.splice(index, 1);
    for (const [hash, session] of this.sessions) {
      if (session.passkeyId === id) this.sessions.delete(hash);
    }
    await this.persist();
    return true;
  }

  async createSession(passkeyId: string): Promise<{ token: string; expiresAt: string }> {
    this.sweepSessions();
    if (this.sessions.size >= SESSIONS_MAX_SIZE) {
      // Map preserves insertion order — the first key is the oldest session.
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    const session: StoredSession = {
      tokenHash: hashSessionToken(token),
      passkeyId,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.sessions.set(session.tokenHash, session);
    await this.persist();
    return { token, expiresAt: new Date(session.expiresAt).toISOString() };
  }

  /** Synchronous, so the regular Bearer middleware can accept a session token alongside the static one. */
  isValidSession(token: string): boolean {
    const session = this.sessions.get(hashSessionToken(token));
    return session !== undefined && Date.now() <= session.expiresAt;
  }

  async revokeSession(token: string): Promise<boolean> {
    if (!this.sessions.delete(hashSessionToken(token))) return false;
    await this.persist();
    return true;
  }

  private sweepSessions(): void {
    const now = Date.now();
    for (const [hash, session] of this.sessions) {
      if (now > session.expiresAt) this.sessions.delete(hash);
    }
  }

  private rememberChallenge(challenge: string, purpose: "register" | "login"): void {
    const now = Date.now();
    for (const [key, entry] of this.challenges) {
      if (now > entry.expiresAt) this.challenges.delete(key);
    }
    if (this.challenges.size >= CHALLENGES_MAX_SIZE) {
      const oldest = this.challenges.keys().next().value;
      if (oldest !== undefined) this.challenges.delete(oldest);
    }
    this.challenges.set(challenge, { purpose, expiresAt: now + CHALLENGE_TTL_MS });
  }

  // Challenges are single-use: consumed on the first verification attempt whatever its outcome, so a
  // captured response can never be replayed — and a challenge issued for registration can't be spent
  // on a login or vice versa.
  private challengeChecker(purpose: "register" | "login"): (challenge: string) => boolean {
    return (challenge: string) => {
      const entry = this.challenges.get(challenge);
      this.challenges.delete(challenge);
      return entry !== undefined && entry.purpose === purpose && Date.now() <= entry.expiresAt;
    };
  }

  private persist(): Promise<void> {
    return this.configStore.setPasskeyState({
      credentials: this.passkeys,
      sessions: [...this.sessions.values()],
    });
  }
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

function requireRelyingParty(passkeys: PasskeyService, req: Request): RelyingParty {
  const rp = passkeys.relyingPartyFor(req);
  if (!rp) {
    throw new HttpError(400, "Passkeys aren't available from this address — use the server's public HTTPS URL or localhost");
  }
  return rp;
}

// Express 5 forwards a rejected promise to the error handler, but PasskeyError needs mapping to a
// 400 first rather than surfacing as a 500.
function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err instanceof PasskeyError ? new HttpError(400, err.message) : err);
    }
  };
}

/**
 * /api/auth/passkeys/* — login is public (it's how you get in), everything that lists or changes the
 * registered passkeys requires being signed in already, with either the static token or a session.
 */
export function createPasskeyRouter(passkeys: PasskeyService, auth: AuthMiddleware): express.Router {
  const router = express.Router();
  const requireAuth = auth.requireAuth();

  // Only decides whether to offer the passkey button at all. Whether this particular origin can use
  // one is left to the ceremony itself, which answers with an explicit error when it can't.
  router.get("/api/auth/passkeys/status", (_req, res) => {
    res.status(200).json({ available: passkeys.hasPasskeys() });
  });

  router.post(
    "/api/auth/passkeys/login/options",
    handle(async (req, res) => {
      res.status(200).json(await passkeys.authenticationOptions(requireRelyingParty(passkeys, req)));
    }),
  );

  router.post(
    "/api/auth/passkeys/login/verify",
    express.json(),
    handle(async (req, res) => {
      const rp = requireRelyingParty(passkeys, req);
      const passkey = await passkeys.authenticate(rp, req.body?.response);
      res.status(200).json(await passkeys.createSession(passkey.id));
    }),
  );

  router.post(
    "/api/auth/logout",
    requireAuth,
    handle(async (req, res) => {
      const token = bearerToken(req);
      // Signing out with the static token has nothing server-side to revoke — that token is shared
      // with every MCP client and only changes by editing the config.
      if (token) await passkeys.revokeSession(token);
      res.status(204).end();
    }),
  );

  router.get("/api/auth/passkeys", requireAuth, (_req, res) => {
    res.status(200).json({ passkeys: passkeys.list() });
  });

  router.post(
    "/api/auth/passkeys/register/options",
    requireAuth,
    handle(async (req, res) => {
      res.status(200).json(await passkeys.registrationOptions(requireRelyingParty(passkeys, req)));
    }),
  );

  router.post(
    "/api/auth/passkeys/register/verify",
    requireAuth,
    express.json(),
    handle(async (req, res) => {
      const rp = requireRelyingParty(passkeys, req);
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      res.status(201).json(await passkeys.register(rp, req.body?.response, name));
    }),
  );

  router.delete(
    "/api/auth/passkeys/:id",
    requireAuth,
    handle(async (req, res) => {
      const id = String(req.params.id);
      if (!(await passkeys.remove(id))) throw new HttpError(404, "Unknown passkey");
      res.status(204).end();
    }),
  );

  return router;
}
