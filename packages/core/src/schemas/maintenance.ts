import { z } from 'zod';

import { MAINTENANCE_PRIORITIES } from '../maintenance/constants';
import { sanitizeDescriptionBlock, sanitizeSubjectLine } from '../maintenance/text';

/**
 * Shared by the web RHF form, the mobile form, and BOTH server create
 * paths (server action + /api/v1). The server is the authority — it
 * re-parses with this same schema and then snapshots requester identity
 * from the SESSION, never from these values.
 *
 * `.strict()` at every object depth (there is exactly one depth here — no
 * nested `z.object`) so an unrecognized key is a hard rejection, never
 * silently stripped. This is the whole reason a recipient-shaped key
 * (`to`, `cc`, `bcc`, `recipient(s)`, ...) can never reach the server
 * through this schema: there is no field for one to land in, and `.strict()`
 * refuses the payload outright instead of quietly dropping the extra key
 * (the export-builder program's tautology — Global Constraint 19/plan
 * lesson — was exactly this failure mode at a DIFFERENT object depth).
 * Recipients are compile-time constants (`L4L_MAINTENANCE_EMAIL`) read
 * server-side; they are never client input and must never become one.
 *
 * Fix wave 1 (owner §7 gap): `sanitizeSubjectLine`/`sanitizeDescriptionBlock`
 * (packages/core/src/maintenance/text.ts) used to run ONLY at email-build
 * time (email.ts) — raw control bytes (BEL, NUL, a stray bare CR, ...)
 * persisted to `maintenance_requests.description`/`subject` untouched and
 * would render as-is in the list, the detail page, notes, and any export.
 * Sanitizing HERE means every writer (the web form via zodResolver on this
 * exact object, the future mobile form, and both server create paths, which
 * all re-parse with this same schema) gets it for free, automatically, with
 * no per-caller opt-in.
 *
 * ORDERING DECISION — sanitize-then-check, not check-then-sanitize:
 * `.transform()` runs BEFORE the length/meaningful-content checks below (via
 * `.pipe()`), on both fields. Two reasons, not one:
 *   1. Description: a description whose *raw* length is 5,001 chars but
 *      whose control bytes sanitize away to exactly 5,000 must be ACCEPTED
 *      — the 5,000 cap describes the value that gets persisted, not
 *      whatever the client happened to paste. Check-then-sanitize would
 *      reject that description for a length it will never actually have.
 *   2. Subject: the "at least 3 consecutive meaningful characters" refine
 *      strips \s (whitespace) before testing for a run of letters/digits —
 *      but raw C0 control bytes like BEL/NUL are NOT \s, so a subject like
 *      "<NUL>A<BEL>B<NUL>C<BEL>D<NUL>E<BEL>" (5 real letters, separated by
 *      control bytes) would FAIL that check on the raw value, because the
 *      letters are never consecutive. Sanitizing first turns each control
 *      byte into a space — which the refine's own \s-strip then removes —
 *      so real content is judged correctly regardless of what control noise
 *      surrounded it.
 * The one EXCEPTION: the subject's "no interior line break" refine runs
 * BEFORE `sanitizeSubjectLine`, not after — see the inline comment on that
 * refine for why (sanitizing first would make the check permanently
 * unreachable, silently turning a reject into a strip, which is not what
 * brief §7's "no line breaks" validation rule for subject asks for).
 */
export const maintenanceRequestFormSchema = z
  .object({
    subject: z
      .string()
      .trim()
      // Runs on the RAW/trimmed value, BEFORE sanitizeSubjectLine — brief
      // §7 makes "no line breaks" a REJECTION rule for the subject (unlike
      // the description, where line breaks are intentional content to
      // preserve). sanitizeSubjectLine folds every C0 control byte
      // (including \n and \r) into a space, so if this refine ran on the
      // SANITIZED value it could never fire — there would be no literal
      // \n/\r left to find. Running it here keeps "a subject containing a
      // line break is rejected" exactly as it behaved before this fix.
      .refine((v) => !/[\r\n]/.test(v), 'The subject cannot contain line breaks.')
      .transform(sanitizeSubjectLine)
      .pipe(
        z
          .string()
          .min(5, 'Describe the issue in a few words (at least 5 characters).')
          .max(120, 'Keep the subject under 120 characters.')
          .refine(
            (v) => /[\p{L}\p{N}]{3,}/u.test(v.replace(/\s/g, '')),
            'Add a few words describing the issue.',
          ),
      ),
    description: z
      .string()
      .trim()
      // sanitizeDescriptionBlock is the newline-PRESERVING variant — never
      // sanitizeSubjectLine, which would collapse the description's
      // intentional line breaks (brief §7) into spaces. Sanitize BEFORE the
      // length checks below (see the ORDERING DECISION doc comment above).
      .transform(sanitizeDescriptionBlock)
      .pipe(
        z
          .string()
          .min(10, 'Explain what is happening so the maintenance team can prepare.')
          .max(5000, 'Keep the description under 5,000 characters.'),
      ),
    category: z.string().trim().max(80).nullish(),
    priority: z.enum(MAINTENANCE_PRIORITIES).default('normal'),
    charterId: z.string().uuid().nullish(),
    warehouseId: z.string().uuid().nullish(),
    building: z.string().trim().max(200).nullish(),
    roomOrArea: z.string().trim().max(200).nullish(),
    department: z.string().trim().max(200).nullish(),
    accessInstructions: z.string().trim().max(2000).nullish(),
    requesterPhone: z.string().trim().max(40).nullish(),
    relatedItemId: z.string().uuid().nullish(),
    relatedOrderRequestId: z.string().uuid().nullish(),
    relatedRentalId: z.string().uuid().nullish(),
    relatedLocationId: z.string().uuid().nullish(),
  })
  .strict();

export type MaintenanceRequestFormValues = z.infer<typeof maintenanceRequestFormSchema>;
