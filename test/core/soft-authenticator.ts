import crypto from "node:crypto";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

// Just enough CBOR to build an attestation object and a COSE key: unsigned/negative ints, byte
// strings, text strings and maps (callers pass map keys already in canonical order).
type CborValue = number | string | Uint8Array | Map<number | string, CborValue>;

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) {
    const head = Buffer.alloc(3);
    head[0] = (major << 5) | 25;
    head.writeUInt16BE(length, 1);
    return head;
  }
  const head = Buffer.alloc(5);
  head[0] = (major << 5) | 26;
  head.writeUInt32BE(length, 1);
  return head;
}

function cbor(value: CborValue): Buffer {
  if (typeof value === "number") return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), value]);
  const parts = [cborHead(5, value.size)];
  for (const [key, entry] of value) parts.push(cbor(key), cbor(entry));
  return Buffer.concat(parts);
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;

function sha256(data: Buffer | string): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

/**
 * A software stand-in for a platform authenticator (Touch ID, a phone…): a single ES256 passkey
 * producing real "none"-attestation registrations and signed assertions, so tests exercise the
 * server's actual WebAuthn verification instead of mocking it out.
 */
export class SoftAuthenticator {
  readonly credentialId = crypto.randomBytes(16);
  private readonly keys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  private signCount = 0;
  private userHandle: string | undefined;

  constructor(private readonly opts: { userVerified?: boolean } = {}) {}

  get id(): string {
    return this.credentialId.toString("base64url");
  }

  private flags(): number {
    return FLAG_USER_PRESENT | (this.opts.userVerified === false ? 0 : FLAG_USER_VERIFIED);
  }

  create(options: PublicKeyCredentialCreationOptionsJSON, origin: string): RegistrationResponseJSON {
    this.userHandle = options.user.id;
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    const coseKey = new Map<number, CborValue>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x as string, "base64url")],
      [-3, Buffer.from(jwk.y as string, "base64url")],
    ]);
    const credentialIdLength = Buffer.alloc(2);
    credentialIdLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(options.rp.id as string),
      Buffer.from([this.flags() | FLAG_ATTESTED_CREDENTIAL_DATA]),
      Buffer.alloc(4), // signCount 0
      Buffer.alloc(16), // AAGUID
      credentialIdLength,
      this.credentialId,
      cbor(coseKey),
    ]);
    const attestationObject = cbor(
      new Map<string, CborValue>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        attestationObject: attestationObject.toString("base64url"),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  get(options: PublicKeyCredentialRequestOptionsJSON, origin: string): AuthenticationResponseJSON {
    this.signCount += 1;
    const signCount = Buffer.alloc(4);
    signCount.writeUInt32BE(this.signCount);
    const authData = Buffer.concat([sha256(options.rpId as string), Buffer.from([this.flags()]), signCount]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }),
    );
    const signature = crypto.sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    };
  }
}
