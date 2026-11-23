import { z } from 'zod';

/**
 * Strict shapes of what a browser sends back from a passkey prompt (plan
 * 2.4). Every level is `.strict()`: an unknown key, a case-variant duplicate
 * (`authenticatordata`) or a value of the wrong type is refused before the
 * WebAuthn library sees anything. Every binary field is base64url with no
 * padding and no stray character, with a length cap. The parsed object, not
 * the raw one, is what the library checks.
 *
 * Client-safe (no server import): the passkey button reuses the name rule.
 */

const b64u = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/, 'not base64url');

/** A credential id: base64url, 22 characters (16 bytes) at least, as 0475's check. */
const credentialId = b64u(1366).min(22);

/** What the browser reported for the extensions: an object, its content ignored. */
const extensionResults = z.record(z.string(), z.unknown());

const attachment = z.enum(['platform', 'cross-platform']);

export const PASSKEY_TRANSPORTS = [
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
] as const;

export const registrationResponseSchema = z
  .object({
    id: credentialId,
    rawId: credentialId,
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: b64u(4096),
        attestationObject: b64u(16384),
        authenticatorData: b64u(16384).optional(),
        transports: z.array(z.string().max(32)).max(16).optional(),
        publicKeyAlgorithm: z.number().int().optional(),
        publicKey: b64u(4096).optional(),
      })
      .strict(),
    clientExtensionResults: extensionResults,
    authenticatorAttachment: attachment.optional(),
  })
  .strict();

export const authenticationResponseSchema = z
  .object({
    id: credentialId,
    rawId: credentialId,
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: b64u(4096),
        authenticatorData: b64u(1024),
        signature: b64u(1024),
        userHandle: b64u(1024).optional(),
      })
      .strict(),
    clientExtensionResults: extensionResults,
    authenticatorAttachment: attachment.optional(),
  })
  .strict();

export type ParsedRegistrationResponse = z.infer<typeof registrationResponseSchema>;
export type ParsedAuthenticationResponse = z.infer<typeof authenticationResponseSchema>;

/** A passkey's name: the table's rule (no dot, no control character), trimmed. */
export const PASSKEY_NAME_RE = /^[A-Za-z0-9 ()+'_-]{1,60}$/;
export const passkeyNameSchema = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(1, 'Give this passkey a name.')
      .max(60, 'Use 60 characters or fewer.')
      .regex(
        PASSKEY_NAME_RE,
        "Use letters, numbers, spaces and ( ) + ' _ - only.",
      ),
  );

/** A challenge id handed back by the browser: a uuid. */
export const challengeIdSchema = z.string().uuid();

/** Only the transports the table allows, each once, in a fixed order. */
export function cleanTransports(raw: readonly string[] | undefined): string[] {
  const sent = new Set(raw ?? []);
  return PASSKEY_TRANSPORTS.filter((t) => sent.has(t));
}
