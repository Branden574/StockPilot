import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { codeMentions, findCalls, findFromChains } from '@/test/kept-address-owners';

/**
 * GUARD (B23): every email sender that reads a kept address asks
 * server/lib/kept-address.ts first.
 *
 * WHY. A maintenance request and a support ticket keep a copy of the filer's
 * address (owner decision O-A3-6), and a member who deleted their account is
 * never emailed again (A3). Neither table has a deletion marker yet, so
 * kept-address.ts infers it from the owner columns, and it does so in one
 * place (integrator decision 1, 2026-10-25). A sender with its own copy of
 * that inference, or one that skips it, would email a deleted member at the
 * kept address, and nothing else would notice.
 *
 * WHAT THIS CHECKS, in apps/web/src (the only code that sends email), tests
 * and the test helpers left out: a file that calls sendEmail(…) and reads a
 * kept address also calls the answer for that table:
 *   - maintenance_requests.requester_email_snapshot, named anywhere in the
 *     file's code: maintenanceRequesterAccountDeleted(…);
 *   - a read of support_tickets (a `.from('support_tickets')` chain that
 *     starts with select; its rows carry the email): supportTicketSubmitter
 *     AccountDeleted(…);
 *   - rentals.borrower_email has no answer yet. A borrower without an account
 *     has no borrower_user_id either (0131), so nothing in a rental tells a
 *     deleted member from someone who never had an account. Its senders are
 *     listed in NO_ANSWER_YET until the marker of the B23 design
 *     (rentals.borrower_deleted_at) exists; a listed file that no longer
 *     sends or reads the address fails too.
 * The check is per file: a file that asks somewhere passes. The senders' own
 * tests prove each one asks before its kept-address email
 * (support-tickets.resolved-notice.test.ts, maintenance-resolved.test.ts).
 * Orders answer from their own marker (order_requests.requester_deleted_at,
 * server/lib/requester-contact.ts) and are not checked here.
 *
 * IF THIS FAILS. A file sends email and reads a kept address without asking
 * whether its owner deleted their account. Call the answer named in the
 * finding before sending to the kept address (never a copy of its rule), or,
 * for a table with no answer yet, list the file in NO_ANSWER_YET with the
 * reason.
 */

const REPO = path.resolve(__dirname, '../../../../..');
const ROOT = 'apps/web/src';
/** Test helpers and fixtures. Only this exact directory, as in kept-address.guard.test.ts. */
const TEST_HELPERS = 'apps/web/src/test';

interface KeptAddress {
  table: string;
  column: string;
  /** Whether this file's code reads the kept address. */
  reads: (file: string, text: string) => boolean;
  /** The kept-address.ts function that answers for this table, or null. */
  answer: string | null;
}

const KEPT_ADDRESSES: KeptAddress[] = [
  {
    table: 'maintenance_requests',
    column: 'requester_email_snapshot',
    reads: (file, text) => codeMentions(file, text, 'requester_email_snapshot').length > 0,
    answer: 'maintenanceRequesterAccountDeleted',
  },
  {
    table: 'support_tickets',
    column: 'email',
    reads: (file, text) =>
      findFromChains(file, text).some(
        (c) => c.table === 'support_tickets' && c.methods[0] === 'select',
      ),
    answer: 'supportTicketSubmitterAccountDeleted',
  },
  {
    table: 'rentals',
    column: 'borrower_email',
    reads: (file, text) => codeMentions(file, text, 'borrower_email').length > 0,
    answer: null,
  },
];

/** Senders of a kept address that no function can answer for yet. */
const NO_ANSWER_YET: Array<{ file: string; table: string; why: string }> = [
  {
    file: 'apps/web/src/lib/email/rentals.ts',
    table: 'rentals',
    why:
      'The checkout, returned and overdue emails go to borrower_email. Until the B23 marker ' +
      '(rentals.borrower_deleted_at) exists, a member who borrowed something and deleted their ' +
      'account still gets them (named in kept-address.ts and the B23 pull request).',
  },
];

function sourceFiles(rel: string, out: string[] = []): string[] {
  const dir = path.join(REPO, rel);
  for (const entry of readdirSync(dir)) {
    const childRel = `${rel}/${entry}`;
    if (statSync(path.join(dir, entry)).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__' || childRel === TEST_HELPERS) continue;
      sourceFiles(childRel, out);
    } else if (
      /\.(ts|tsx)$/.test(entry) &&
      !/\.test\.(ts|tsx)$/.test(entry) &&
      !entry.endsWith('.d.ts')
    ) {
      out.push(childRel);
    }
  }
  return out;
}

function senderFindings(files: Array<{ file: string; text: string }>): string[] {
  const out: string[] = [];
  const listedSeen = new Set<(typeof NO_ANSWER_YET)[number]>();
  for (const { file, text } of files) {
    if (findCalls(file, text, 'sendEmail').length === 0) continue;
    for (const kept of KEPT_ADDRESSES) {
      if (!kept.reads(file, text)) continue;
      if (kept.answer !== null) {
        if (findCalls(file, text, kept.answer).length === 0) {
          out.push(
            `${file} sends email and reads ${kept.table}.${kept.column} without asking ` +
              `${kept.answer}() in server/lib/kept-address.ts`,
          );
        }
        continue;
      }
      const listed = NO_ANSWER_YET.find((l) => l.file === file && l.table === kept.table);
      if (listed) listedSeen.add(listed);
      else {
        out.push(
          `${file} sends email and reads ${kept.table}.${kept.column}, which nothing can answer ` +
            'for yet: list it in NO_ANSWER_YET with the reason',
        );
      }
    }
  }
  for (const l of NO_ANSWER_YET) {
    if (!listedSeen.has(l))
      out.push(`NO_ANSWER_YET ${l.file}: it no longer sends to a kept ${l.table} address`);
  }
  return out;
}

describe('kept-address senders (B23 guard)', () => {
  let scanned: Array<{ file: string; text: string }> | null = null;
  const repo = () =>
    (scanned ??= sourceFiles(ROOT).map((file) => ({
      file,
      text: readFileSync(path.join(REPO, file), 'utf8'),
    })));

  it('every sender that reads a kept address asks kept-address.ts first', () => {
    expect(senderFindings(repo())).toEqual([]);
  }, 120_000);

  it('found the two senders the inference answers for', () => {
    const asking = repo()
      .filter(({ file, text }) => findCalls(file, text, 'sendEmail').length > 0)
      .flatMap(({ file, text }) =>
        KEPT_ADDRESSES.filter((k) => k.answer !== null && k.reads(file, text)).map(
          (k) => `${file} ${k.table}`,
        ),
      )
      .sort();
    expect(asking).toEqual([
      'apps/web/src/server/email/maintenance-resolved.ts maintenance_requests',
      'apps/web/src/server/services/support-tickets.ts support_tickets',
    ]);
  }, 120_000);

  describe('self-test: planted senders are caught', () => {
    const PLANTED_MAINTENANCE = `
      // requester_email_snapshot in a comment is not a read
      export async function sendReopened(admin: Admin, id: string) {
        const { data } = await admin
          .from('maintenance_requests')
          .select('id, requester_user_id, requester_email_snapshot')
          .eq('id', id)
          .maybeSingle();
        if (!data?.requester_user_id) return; // a copy of the rule, not the answer
        await sendEmail({ to: data.requester_email_snapshot, subject: 'Reopened', html: '' });
      }
    `;
    const PLANTED_SUPPORT = `
      export async function sendReminder(admin: Admin, id: string) {
        const { data } = await admin.from('support_tickets').select('email, subject').eq('id', id).single();
        await sendEmail({ to: data.email, subject: 'Still open', html: '' });
      }
    `;
    const PLANTED_ASKS = `
      export async function sendReminder(admin: Admin, id: string) {
        const { data } = await admin
          .from('support_tickets')
          .select('email, subject, organization_id, submitted_by')
          .eq('id', id)
          .single();
        if (supportTicketSubmitterAccountDeleted(data)) return;
        await sendEmail({ to: data.email, subject: 'Still open', html: '' });
      }
    `;
    const PLANTED_RENTAL = `
      export async function sendDueSoon(row: { borrower_email: string | null }) {
        if (row.borrower_email) await sendEmail({ to: row.borrower_email, subject: 'Due soon', html: '' });
      }
    `;
    const PLANTED_NO_SEND = `
      export async function listKept(admin: Admin) {
        return admin.from('maintenance_requests').select('requester_email_snapshot');
      }
    `;
    const PLANTED_INSERT_ONLY = `
      export async function file(admin: Admin) {
        await admin.from('support_tickets').insert({ email: 'a@example.com' }).select('id').single();
        await sendEmail({ to: 'support@example.com', subject: 'New ticket', html: '' });
      }
    `;

    it('reports a sender that reads a kept address without the answer, and a new rental sender', () => {
      const planted = [
        { file: 'apps/web/src/server/email/maintenance-reopened.ts', text: PLANTED_MAINTENANCE },
        { file: 'apps/web/src/server/email/support-reminder.ts', text: PLANTED_SUPPORT },
        { file: 'apps/web/src/server/email/support-reminder-asks.ts', text: PLANTED_ASKS },
        { file: 'apps/web/src/server/email/rental-due-soon.ts', text: PLANTED_RENTAL },
        { file: 'apps/web/src/server/email/kept-list.ts', text: PLANTED_NO_SEND },
        { file: 'apps/web/src/server/email/support-insert.ts', text: PLANTED_INSERT_ONLY },
      ];
      expect(senderFindings([...repo(), ...planted])).toEqual([
        'apps/web/src/server/email/maintenance-reopened.ts sends email and reads maintenance_requests.requester_email_snapshot without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
        'apps/web/src/server/email/support-reminder.ts sends email and reads support_tickets.email without asking supportTicketSubmitterAccountDeleted() in server/lib/kept-address.ts',
        'apps/web/src/server/email/rental-due-soon.ts sends email and reads rentals.borrower_email, which nothing can answer for yet: list it in NO_ANSWER_YET with the reason',
      ]);
    }, 120_000);

    it('reports a NO_ANSWER_YET entry that no longer sends to a kept address', () => {
      const withoutRentals = repo().filter((f) => f.file !== 'apps/web/src/lib/email/rentals.ts');
      expect(senderFindings(withoutRentals)).toEqual([
        'NO_ANSWER_YET apps/web/src/lib/email/rentals.ts: it no longer sends to a kept rentals address',
      ]);
    }, 120_000);

    it('a comment naming the column is not a read', () => {
      expect(
        codeMentions(
          'x.ts',
          '// requester_email_snapshot\nconst a = 1;',
          'requester_email_snapshot',
        ),
      ).toEqual([]);
      expect(
        codeMentions(
          'x.ts',
          "const cols = 'id, requester_email_snapshot';",
          'requester_email_snapshot',
        ),
      ).toEqual([1]);
    });
  });
});
