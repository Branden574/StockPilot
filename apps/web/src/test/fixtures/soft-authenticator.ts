import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * A software WebAuthn authenticator for the repository's own tests (plan
 * section 7, Q27): P-256 keys made inside the test, attestation "none", and
 * every flag the caller chooses, so the real `@simplewebauthn/server` can be
 * fed answers with user verification on or off, a backup-eligible flag that
 * changes, another origin, a cross-origin frame, a counter that goes back.
 * Ported from the spike's softauthn.mjs. Made-up keys only; nothing leaves
 * the test.
 */

export const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 } as const;

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');
const sha256 = (b: Uint8Array | Buffer | string) => createHash('sha256').update(b).digest();

/** The CBOR WebAuthn needs: ints, byte and text strings, maps. */
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

type Cbor = number | string | Buffer | Map<Cbor, Cbor>;

export function cborEncode(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, s.length), s]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, val] of v) parts.push(cborEncode(k), cborEncode(val));
  return Buffer.concat(parts);
}

interface StoredCredential {
  privateKey: KeyObject;
  rpId: string;
  userHandle: Buffer;
  signCount: number;
}

export interface SoftOptions {
  uv?: boolean;
  be?: boolean;
  bs?: boolean;
  origin?: string;
}

export interface CreateKnobs {
  uv?: boolean;
  origin?: string;
  crossOrigin?: boolean;
  type?: string;
}

export interface GetKnobs {
  uv?: boolean;
  be?: boolean;
  origin?: string;
  rpId?: string;
  signCount?: number;
  crossOrigin?: boolean;
  userHandle?: string | null;
  type?: string;
}

/** The JSON a browser hands back (what our schemas parse). */
export interface SoftRegistration {
  id: string;
  rawId: string;
  type: 'public-key';
  response: { attestationObject: string; clientDataJSON: string; transports: string[] };
  clientExtensionResults: Record<string, never>;
  authenticatorAttachment: 'platform';
}

export interface SoftAssertion {
  id: string;
  rawId: string;
  type: 'public-key';
  response: { authenticatorData: string; clientDataJSON: string; signature: string; userHandle?: string };
  clientExtensionResults: Record<string, never>;
  authenticatorAttachment: 'platform';
}

export class SoftAuthenticator {
  uv: boolean;
  be: boolean;
  bs: boolean;
  origin: string;
  readonly creds = new Map<string, StoredCredential>();

  constructor({ uv = true, be = true, bs = true, origin = 'http://localhost:3000' }: SoftOptions = {}) {
    this.uv = uv;
    this.be = be;
    this.bs = bs;
    this.origin = origin;
  }

  private flags(extra: number, uv = this.uv, be = this.be): number {
    let f = FLAG.UP | extra;
    if (uv) f |= FLAG.UV;
    if (be) f |= FLAG.BE;
    if (be && this.bs) f |= FLAG.BS;
    return f;
  }

  /** navigator.credentials.create(): `options` is the server's optionsJSON. */
  create(options: { challenge: string; rp: { id?: string }; user: { id: string } }, knobs: CreateKnobs = {}): SoftRegistration {
    const rpId = options.rp.id ?? 'localhost';
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const cose = cborEncode(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromB64u(jwk.x)],
        [-3, fromB64u(jwk.y)],
      ]),
    );
    const credId = randomBytes(32);
    const cnt = Buffer.alloc(4);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(credId.length);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.flags(FLAG.AT, knobs.uv ?? this.uv)]),
      cnt,
      Buffer.alloc(16),
      idLen,
      credId,
      cose,
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: knobs.type ?? 'webauthn.create',
        challenge: options.challenge,
        origin: knobs.origin ?? this.origin,
        crossOrigin: knobs.crossOrigin ?? false,
      }),
    );
    const attestationObject = cborEncode(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    this.creds.set(b64u(credId), { privateKey, rpId, userHandle: fromB64u(options.user.id), signCount: 0 });
    return {
      id: b64u(credId),
      rawId: b64u(credId),
      type: 'public-key',
      response: { attestationObject: b64u(attestationObject), clientDataJSON: b64u(clientDataJSON), transports: ['internal'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** navigator.credentials.get(): `options` is the server's optionsJSON. */
  get(options: { challenge: string; rpId?: string }, credId?: string, knobs: GetKnobs = {}): SoftAssertion {
    const id = credId ?? [...this.creds.keys()][0];
    const c = id ? this.creds.get(id) : undefined;
    if (!id || !c) throw new Error('soft authenticator: no such credential');
    const rpId = knobs.rpId ?? options.rpId ?? c.rpId;
    c.signCount = knobs.signCount ?? c.signCount + 1;
    const cnt = Buffer.alloc(4);
    cnt.writeUInt32BE(c.signCount);
    const authenticatorData = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.flags(0, knobs.uv ?? this.uv, knobs.be ?? this.be)]),
      cnt,
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: knobs.type ?? 'webauthn.get',
        challenge: options.challenge,
        origin: knobs.origin ?? this.origin,
        crossOrigin: knobs.crossOrigin ?? false,
      }),
    );
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), c.privateKey);
    const userHandle = knobs.userHandle === undefined ? b64u(c.userHandle) : knobs.userHandle;
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        authenticatorData: b64u(authenticatorData),
        clientDataJSON: b64u(clientDataJSON),
        signature: b64u(signature),
        ...(userHandle === null ? {} : { userHandle }),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
