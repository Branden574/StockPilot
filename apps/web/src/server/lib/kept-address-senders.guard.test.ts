import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  analyzeSenderFile,
  type CallSite,
  type KeptAddressSpec,
  type SenderUnit,
} from '@/test/kept-address-senders';

/**
 * GUARD (B23): every email sender that reads a kept address asks
 * server/lib/kept-address.ts first.
 *
 * WHY. A maintenance request and a support ticket keep a copy of the filer's
 * address (owner decision O-A3-6), and a member who deleted their account is
 * never emailed again (A3). Neither table has a deletion marker yet, so
 * kept-address.ts infers it from the owner columns, in one place (integrator
 * decision 1, 2026-10-25). A sender with its own copy of that rule, or one
 * that skips it, would email a deleted member at the kept address, and
 * nothing else would notice.
 *
 * WHAT THIS CHECKS, in apps/web/src (the only code that sends email), tests
 * and the test helpers left out, for each named function (a function, a
 * method, or a function assigned to a variable; src/test/kept-address-
 * senders.ts says exactly how each fact below is found):
 *   1. SENDING. A function sends when it calls sendEmail(…) under any
 *      receiver, a `.emails.send(…)` member or a fetch to the Resend API, or
 *      a function of the scan that sends (in its own file, through `this`,
 *      or imported), so every exported sender of lib/email counts
 *      (sendOrderRequestEmail, sendRentalOverdueEmail and the rest).
 *      packages/core sends no email (checked below), so a call into it never
 *      sends.
 *   2. READING. A function reads a kept address when it names the column, an
 *      alias of it the file can see, or selects it (KEPT_ADDRESSES). A
 *      support ticket's address is a column with a common name (email), so
 *      any read of support_tickets counts: any chain with a select, but an
 *      insert's or upsert's whose select names no kept column.
 *   3. PER FUNCTION. A function that reads a kept address and sends, or hands
 *      the address (or a row holding it) to a function of another file
 *      outside packages/core, calls the answer itself, unless the sender or
 *      function it hands it to calls the answer (the receiving sender asks).
 *      A hand-off checked by hand is in REVIEWED_HANDOFFS with the reason.
 *   4. ALIASES. Every property that carries a kept address out of a row (an
 *      object key whose value is the address, outside any call's arguments)
 *      is registered in KEPT_ADDRESSES with its file and function, and every
 *      registered alias is still made there. A registered alias is then read
 *      like the column wherever its file can be seen (that file, and the
 *      files that import it).
 *   5. TABLES IT CANNOT READ. In a file that sends, a select through a
 *      `.from()` whose table the scan cannot read (a variable, an imported
 *      constant) is a finding unless REVIEWED_DYNAMIC_READS says why it
 *      reads no kept address.
 *   6. NO ANSWER YET. Rentals have none: a borrower without an account has no
 *      borrower_user_id either (0131), so nothing in a rental tells a deleted
 *      member from someone who never had an account. A file that reads the
 *      kept rental address and sends it, or hands it on, is listed in
 *      NO_ANSWER_YET until the B23 marker (rentals.borrower_deleted_at)
 *      exists.
 * Orders answer from their own marker (order_requests.requester_deleted_at,
 * server/lib/requester-contact.ts) and are not checked here.
 *
 * IF THIS FAILS. Call the answer named in the finding before the send or the
 * hand-off (never a copy of its rule); register a new alias; or, after
 * checking it by hand, list the hand-off, the unread table or the rental
 * sender with the reason.
 */

const REPO = path.resolve(__dirname, '../../../../..');
const WEB = 'apps/web/src';
const CORE = 'packages/core/src';
/** Test helpers and fixtures. Only this exact directory, as in kept-address.guard.test.ts. */
const TEST_HELPERS = 'apps/web/src/test';
const TIMEOUT = 180_000;

const MAINTENANCE_SERVICE = 'apps/web/src/server/services/maintenance-requests.ts';
const RENTAL_EMAILS = 'apps/web/src/lib/email/rentals.ts';

/** The kept addresses, their aliases and their answers. */
const KEPT_ADDRESSES: Array<KeptAddressSpec & { aliasWhy: Record<string, string> }> = [
  {
    table: 'maintenance_requests',
    column: 'requester_email_snapshot',
    readBy: 'column',
    aliases: [
      { name: 'requesterEmail', file: MAINTENANCE_SERVICE, enclosing: 'get' },
      { name: 'requesterEmail', file: MAINTENANCE_SERVICE, enclosing: 'emailInput' },
    ],
    aliasWhy: {
      get: 'The request detail (the page, the review panel, the phone through the API) shows it.',
      emailInput:
        "The Outlook draft's text for the maintenance team names the requester's address; " +
        'the draft is addressed to the routing, never to the requester.',
    },
    answer: 'maintenanceRequesterAccountDeleted',
  },
  {
    table: 'support_tickets',
    column: 'email',
    readBy: 'table',
    aliases: [],
    aliasWhy: {},
    answer: 'supportTicketSubmitterAccountDeleted',
  },
  {
    table: 'rentals',
    column: 'borrower_email',
    readBy: 'column',
    aliases: [{ name: 'borrowerEmail', file: RENTAL_EMAILS, enclosing: 'loadRentalContext' }],
    aliasWhy: {
      loadRentalContext: 'The checkout, returned and overdue emails are built from it.',
    },
    answer: null,
  },
];

/** Files that send to, or hand on, a kept address nothing can answer for yet. */
const NO_ANSWER_YET: Array<{ file: string; table: string; why: string }> = [
  {
    file: RENTAL_EMAILS,
    table: 'rentals',
    why:
      'The checkout, returned and overdue emails go to borrower_email. Until the B23 marker ' +
      '(rentals.borrower_deleted_at) exists, a member who borrowed something and deleted their ' +
      'account still gets them (named in kept-address.ts and the B23 pull request).',
  },
  {
    file: 'apps/web/src/server/services/rentals.ts',
    table: 'rentals',
    why:
      'create() reads the address typed into the rental form (input.borrowerEmail), writes it ' +
      'and the audit row, and sends the checkout email through lib/email/rentals.ts; nobody has ' +
      'deleted an account between typing the address and the rental being saved.',
  },
];

/** Hand-offs of a kept address to another file, checked by hand (none today). */
const REVIEWED_HANDOFFS: Array<{ file: string; enclosing: string; callee: string; why: string }> =
  [];

/** Selects through a table the scan cannot read, in a file that sends. */
const REVIEWED_DYNAMIC_READS: Array<{ file: string; enclosing: string; why: string }> = [
  {
    file: MAINTENANCE_SERVICE,
    enclosing: 'resolveRelatedId',
    why:
      "Its table is typed 'inventory_items' | 'order_requests' | 'rentals' | 'locations' | " +
      "'charters' | 'warehouses', and it selects only id: no kept address.",
  },
];

// ── The scan ────────────────────────────────────────────────────────────────

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

/** A resolver for `@/…` and relative imports over the given files. */
function resolverFor(files: Set<string>) {
  return (fromFile: string, specifier: string): string | null => {
    let base: string | null = null;
    if (specifier.startsWith('@/')) base = `${WEB}/${specifier.slice(2)}`;
    else if (specifier.startsWith('./') || specifier.startsWith('../')) {
      base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    }
    if (base === null) return null;
    for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
      if (files.has(c)) return c;
    }
    return null;
  };
}

interface Source {
  file: string;
  text: string;
}

function analyze(sources: Source[]): SenderUnit[] {
  const resolve = resolverFor(new Set(sources.map((s) => s.file)));
  return sources.flatMap((s) => analyzeSenderFile(s.file, s.text, KEPT_ADDRESSES, resolve));
}

function read(rel: string): Source[] {
  return sourceFiles(rel).map((file) => ({
    file,
    text: readFileSync(path.join(REPO, file), 'utf8'),
  }));
}

// ── The rules ───────────────────────────────────────────────────────────────

const key = (file: string, name: string) => `${file}#${name}`;
const fn = (u: SenderUnit) => (u.name ? `${u.name}()` : 'its top level');

/** The functions that send, directly or through a function of the scan. */
function sendingUnits(units: SenderUnit[]): Set<string> {
  const sending = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const u of units) {
      const k = key(u.file, u.name);
      if (sending.has(k)) continue;
      if (
        u.sends.length > 0 ||
        u.localCalls.some((c) => sending.has(key(u.file, c.name))) ||
        u.importCalls.some((c) => c.resolved && sending.has(key(c.resolved, c.imported ?? c.name)))
      ) {
        sending.add(k);
        changed = true;
      }
    }
  }
  return sending;
}

/** The function a call reaches, when the scan has it. */
function target(u: SenderUnit, c: CallSite): string | null {
  if (c.module === undefined) return key(u.file, c.name);
  return c.resolved ? key(c.resolved, c.imported ?? c.name) : null;
}

const isCore = (c: CallSite) =>
  c.module === '@stockpilot/core' || (c.module?.startsWith('@stockpilot/core/') ?? false);

function senderFindings(units: SenderUnit[]): string[] {
  const out: string[] = [];
  const byKey = new Map(units.map((u) => [key(u.file, u.name), u]));
  const sending = sendingUnits(units);
  const asks = (k: string | null, answer: string) =>
    k !== null && (byKey.get(k)?.answers.includes(answer) ?? false);
  const listedSeen = new Set<(typeof NO_ANSWER_YET)[number]>();
  const handoffsSeen = new Set<(typeof REVIEWED_HANDOFFS)[number]>();

  for (const u of units) {
    for (const table of [...new Set(u.reads.map((r) => r.table))]) {
      const spec = KEPT_ADDRESSES.find((s) => s.table === table)!;
      const what = `${spec.table}.${spec.column}`;
      const calls = [...u.localCalls, ...u.importCalls];
      const sendsThrough = calls.filter((c) => {
        const t = target(u, c);
        return t !== null && sending.has(t);
      });
      const handoffs = u.importCalls.filter(
        (c) => c.carries.includes(table) && !isCore(c) && !sendsThrough.includes(c),
      );

      if (spec.answer === null) {
        if (u.sends.length === 0 && sendsThrough.length === 0 && handoffs.length === 0) continue;
        const listed = NO_ANSWER_YET.find((l) => l.file === u.file && l.table === table);
        if (listed) listedSeen.add(listed);
        else {
          out.push(
            `${u.file}:${u.line} ${fn(u)} reads ${what} and sends it or hands it on, and nothing ` +
              'can answer for it yet: list the file in NO_ANSWER_YET with the reason',
          );
        }
        continue;
      }
      const answer = spec.answer;
      if (u.answers.includes(answer)) continue;
      const ask = `without asking ${answer}() in server/lib/kept-address.ts`;
      for (const s of u.sends) {
        out.push(`${u.file}:${s.line} ${fn(u)} reads ${what} and sends email (${s.how}) ${ask}`);
      }
      const sentDirectly = new Set(u.sends.map((x) => x.line));
      for (const c of sendsThrough) {
        if (sentDirectly.has(c.line)) continue; // sendEmail itself: reported above
        if (asks(target(u, c), answer)) continue; // the receiving sender asks
        out.push(
          `${u.file}:${c.line} ${fn(u)} reads ${what} and sends email through ${c.name}() ${ask}`,
        );
      }
      for (const c of handoffs) {
        if (asks(target(u, c), answer)) continue;
        const reviewed = REVIEWED_HANDOFFS.find(
          (r) => r.file === u.file && r.enclosing === u.name && r.callee === c.name,
        );
        if (reviewed) {
          handoffsSeen.add(reviewed);
          continue;
        }
        out.push(
          `${u.file}:${c.line} ${fn(u)} hands ${what} to ${c.name}() (${c.module}) ${ask}: ` +
            'ask first, or check the hand-off by hand and list it in REVIEWED_HANDOFFS',
        );
      }
    }
  }

  // Aliases: every one made is registered, and every registered one is made.
  for (const spec of KEPT_ADDRESSES) {
    const made = units.flatMap((u) =>
      u.aliasSites
        .filter((a) => a.table === spec.table)
        .map((a) => ({ file: u.file, enclosing: u.name, name: a.name, line: a.line })),
    );
    for (const m of made) {
      if (
        !spec.aliases.some(
          (a) => a.file === m.file && a.enclosing === m.enclosing && a.name === m.name,
        )
      ) {
        out.push(
          `${m.file}:${m.line} ${m.enclosing ? `${m.enclosing}()` : 'its top level'} puts ` +
            `${spec.table}.${spec.column} ` +
            `into ${m.name}: register the alias in KEPT_ADDRESSES so its readers are checked`,
        );
      }
    }
    for (const a of spec.aliases) {
      if (
        !made.some((m) => m.file === a.file && m.enclosing === a.enclosing && m.name === a.name)
      ) {
        out.push(
          `KEPT_ADDRESSES ${spec.table} alias ${a.name}: ${a.file} ${a.enclosing}() no longer makes it`,
        );
      }
    }
  }

  // Selects of an unread table in a file that sends.
  const sendingFiles = new Set(
    units.filter((u) => sending.has(key(u.file, u.name))).map((u) => u.file),
  );
  const dynamicSeen = new Set<(typeof REVIEWED_DYNAMIC_READS)[number]>();
  for (const u of units) {
    if (!sendingFiles.has(u.file)) continue;
    for (const d of u.dynamicReads) {
      const reviewed = REVIEWED_DYNAMIC_READS.find(
        (r) => r.file === u.file && r.enclosing === u.name,
      );
      if (reviewed) dynamicSeen.add(reviewed);
      else {
        out.push(
          `${u.file}:${d.line} ${fn(u)} selects through .from(${d.tableExpression}), a table the ` +
            'scan cannot read, in a file that sends email: check it reads no kept address and list ' +
            'it in REVIEWED_DYNAMIC_READS',
        );
      }
    }
  }

  for (const l of NO_ANSWER_YET) {
    if (!listedSeen.has(l))
      out.push(`NO_ANSWER_YET ${l.file}: it no longer sends or hands on a kept ${l.table} address`);
  }
  for (const r of REVIEWED_HANDOFFS) {
    if (!handoffsSeen.has(r))
      out.push(`REVIEWED_HANDOFFS ${r.file} ${r.enclosing}() -> ${r.callee}: no longer found`);
  }
  for (const r of REVIEWED_DYNAMIC_READS) {
    if (!dynamicSeen.has(r))
      out.push(`REVIEWED_DYNAMIC_READS ${r.file} ${r.enclosing}(): no longer found`);
  }
  return out;
}

// ── The tests ───────────────────────────────────────────────────────────────

describe('kept-address senders (B23 guard)', () => {
  let web: Source[] | null = null;
  let units: SenderUnit[] | null = null;
  const repoSources = () => (web ??= read(WEB));
  const repo = () => (units ??= analyze(repoSources()));
  /** The repository with planted files added (or put in place of a file of
   *  the same name); imports resolve among both. */
  const withPlanted = (planted: Source[]) => {
    const plantedFiles = new Set(planted.map((p) => p.file));
    const resolve = resolverFor(new Set([...repoSources().map((s) => s.file), ...plantedFiles]));
    const plantedUnits = planted.flatMap((s) =>
      analyzeSenderFile(s.file, s.text, KEPT_ADDRESSES, resolve),
    );
    return senderFindings([...repo().filter((u) => !plantedFiles.has(u.file)), ...plantedUnits]);
  };

  it(
    'every function that reads a kept address and sends it, or hands it on, asks first',
    () => {
      expect(senderFindings(repo())).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'found the senders the inference answers for, each asking in the function that sends',
    () => {
      const sending = sendingUnits(repo());
      const asking = repo()
        .filter((u) => sending.has(key(u.file, u.name)))
        .flatMap((u) =>
          [...new Set(u.reads.map((r) => r.table))]
            .filter((t) => KEPT_ADDRESSES.find((s) => s.table === t)?.answer)
            .map((t) => `${u.file} ${u.name} ${t} asks=${u.answers.length > 0}`),
        )
        .sort();
      expect(asking).toEqual([
        'apps/web/src/server/email/maintenance-resolved.ts maybeSendMaintenanceResolvedEmail maintenance_requests asks=true',
        'apps/web/src/server/services/support-tickets.ts updateSupportTicket support_tickets asks=true',
      ]);
    },
    TIMEOUT,
  );

  it(
    'counts the exported senders of lib/email as sending',
    () => {
      const sending = sendingUnits(repo());
      for (const [file, name] of [
        ['apps/web/src/lib/email/resend.ts', 'sendEmail'],
        ['apps/web/src/lib/email/order-requests.ts', 'sendOrderRequestEmail'],
        [RENTAL_EMAILS, 'sendRentalOverdueEmail'],
        ['apps/web/src/lib/email/login-alert.ts', 'sendNewDeviceLoginEmail'],
      ] as const) {
        expect(sending.has(key(file, name)), `${file} ${name}`).toBe(true);
      }
    },
    TIMEOUT,
  );

  it(
    'packages/core sends no email, so a call into it sends nothing',
    () => {
      const sends = analyze(read(CORE)).flatMap((u) =>
        u.sends.map((s) => `${u.file}:${s.line} ${s.how}`),
      );
      expect(sends).toEqual([]);
    },
    TIMEOUT,
  );

  it('every registered alias says why it is made', () => {
    for (const spec of KEPT_ADDRESSES) {
      for (const a of spec.aliases) expect(spec.aliasWhy[a.enclosing], a.enclosing).toBeTruthy();
    }
  });

  describe('self-test: planted senders the file-level guard (fe0816022) passed are caught', () => {
    const READ_MAINTENANCE = `
        const { data } = await admin
          .from('maintenance_requests')
          .select('id, requester_user_id, requester_email_snapshot')
          .eq('id', id)
          .maybeSingle();`;

    it(
      '(1) a call of an exported lib/email sender, a .emails.send member, and a hand-off to a sender or a helper in another file',
      () => {
        const planted: Source[] = [
          {
            file: 'apps/web/src/server/email/plant-order-sender.ts',
            text: `
              import { sendOrderRequestEmail } from '@/lib/email/order-requests';
              export async function sendReopened(admin: Admin, id: string) {${READ_MAINTENANCE}
                await sendOrderRequestEmail({ to: data?.requester_email_snapshot } as never);
              }`,
          },
          {
            file: 'apps/web/src/server/email/plant-resend-sdk.ts',
            text: `
              export async function sendReopened(admin: Admin, resend: Resend, id: string) {${READ_MAINTENANCE}
                await resend.emails.send({ to: data?.requester_email_snapshot ?? '', subject: 'Reopened' });
              }`,
          },
          {
            file: 'apps/web/src/server/email/plant-notify.ts',
            text: `
              export async function notifyRequester(to: string) {
                await sendEmail({ to, subject: 'Reopened', html: '' });
              }
              export function contactLine(to: string) {
                return 'Contact: ' + to;
              }`,
          },
          {
            file: 'apps/web/src/server/services/plant-handoff.ts',
            text: `
              import { contactLine, notifyRequester } from '@/server/email/plant-notify';
              export async function reopen(admin: Admin, id: string) {${READ_MAINTENANCE}
                await notifyRequester(data!.requester_email_snapshot!);
              }
              export async function contact(admin: Admin, id: string) {${READ_MAINTENANCE}
                return contactLine(data!.requester_email_snapshot!);
              }`,
          },
        ];
        expect(withPlanted(planted)).toEqual([
          'apps/web/src/server/email/plant-order-sender.ts:9 sendReopened() reads maintenance_requests.requester_email_snapshot and sends email through sendOrderRequestEmail() without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/email/plant-resend-sdk.ts:8 sendReopened() reads maintenance_requests.requester_email_snapshot and sends email (.emails.send) without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/services/plant-handoff.ts:9 reopen() reads maintenance_requests.requester_email_snapshot and sends email through notifyRequester() without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/services/plant-handoff.ts:17 contact() hands maintenance_requests.requester_email_snapshot to contactLine() (@/server/email/plant-notify) without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts: ask first, or check the hand-off by hand and list it in REVIEWED_HANDOFFS',
        ]);
      },
      TIMEOUT,
    );

    it(
      '(2) a support read through update().select(), and a select through a table constant the scan cannot read',
      () => {
        const planted: Source[] = [
          {
            file: 'apps/web/src/server/services/plant-support-update.ts',
            text: `
              export async function reopenTicket(admin: Admin, id: string) {
                const { data } = await admin
                  .from('support_tickets')
                  .update({ status: 'open' })
                  .eq('id', id)
                  .select('email, subject')
                  .single();
                await sendEmail({ to: data.email, subject: 'Reopened', html: '' });
              }`,
          },
          {
            file: 'apps/web/src/server/services/plant-support-const.ts',
            text: `
              import { SUPPORT_TABLE } from '@/server/services/plant-tables';
              export async function remind(admin: Admin, id: string) {
                const { data } = await admin.from(SUPPORT_TABLE).select('email').eq('id', id).single();
                await sendEmail({ to: data.email, subject: 'Still open', html: '' });
              }`,
          },
          {
            file: 'apps/web/src/server/services/plant-support-insert.ts',
            text: `
              export async function file(admin: Admin) {
                await admin.from('support_tickets').insert({ email: 'a@example.com' }).select('id').single();
                await sendEmail({ to: 'support@example.com', subject: 'New ticket', html: '' });
              }`,
          },
        ];
        expect(withPlanted(planted)).toEqual([
          'apps/web/src/server/services/plant-support-update.ts:9 reopenTicket() reads support_tickets.email and sends email (sendEmail) without asking supportTicketSubmitterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/services/plant-support-const.ts:4 remind() selects through .from(SUPPORT_TABLE), a table the scan cannot read, in a file that sends email: check it reads no kept address and list it in REVIEWED_DYNAMIC_READS',
        ]);
      },
      TIMEOUT,
    );

    it(
      '(3) an unguarded sender beside a guarded one in the same file',
      () => {
        const planted: Source[] = [
          {
            file: 'apps/web/src/server/email/plant-two-senders.ts',
            text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';
              export async function sendResolved(admin: Admin, id: string) {${READ_MAINTENANCE}
                if (!data || maintenanceRequesterAccountDeleted(data)) return;
                await sendEmail({ to: data.requester_email_snapshot, subject: 'Resolved', html: '' });
              }
              export async function sendReopened(admin: Admin, id: string) {${READ_MAINTENANCE}
                await sendEmail({ to: data?.requester_email_snapshot, subject: 'Reopened', html: '' });
              }`,
          },
        ];
        expect(withPlanted(planted)).toEqual([
          'apps/web/src/server/email/plant-two-senders.ts:18 sendReopened() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail) without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
        ]);
      },
      TIMEOUT,
    );

    it(
      '(4) a read of the maintenance and rental aliases, and an alias nobody registered',
      () => {
        const planted: Source[] = [
          {
            file: 'apps/web/src/server/email/plant-alias-maintenance.ts',
            text: `
              import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';
              export async function sendFollowUp(svc: MaintenanceRequestsService, id: string) {
                const detail = await svc.get(id);
                await sendEmail({ to: detail.requesterEmail ?? '', subject: 'Follow-up', html: '' });
              }`,
          },
          {
            file: 'apps/web/src/server/email/plant-alias-rental.ts',
            text: `
              import { sendRentalOverdueEmail } from '@/lib/email/rentals';
              export async function sendDueSoon(rental: { borrowerEmail: string | null }) {
                if (rental.borrowerEmail) await sendEmail({ to: rental.borrowerEmail, subject: 'Due soon', html: '' });
                void sendRentalOverdueEmail;
              }`,
          },
          {
            file: 'apps/web/src/server/services/plant-new-alias.ts',
            text: `
              export async function contactFor(admin: Admin, id: string) {${READ_MAINTENANCE}
                return { contact: data?.requester_email_snapshot ?? null };
              }`,
          },
        ];
        expect(withPlanted(planted)).toEqual([
          'apps/web/src/server/email/plant-alias-maintenance.ts:5 sendFollowUp() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail) without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/email/plant-alias-rental.ts:3 sendDueSoon() reads rentals.borrower_email and sends it or hands it on, and nothing can answer for it yet: list the file in NO_ANSWER_YET with the reason',
          'apps/web/src/server/services/plant-new-alias.ts:8 contactFor() puts maintenance_requests.requester_email_snapshot into contact: register the alias in KEPT_ADDRESSES so its readers are checked',
        ]);
      },
      TIMEOUT,
    );

    it(
      'reports a listed entry that no longer matches, and leaves a comment alone',
      () => {
        const planted: Source[] = [
          {
            file: RENTAL_EMAILS,
            text: '// borrower_email in a comment is not a read\nexport {};\n',
          },
        ];
        expect(withPlanted(planted)).toEqual([
          `KEPT_ADDRESSES rentals alias borrowerEmail: ${RENTAL_EMAILS} loadRentalContext() no longer makes it`,
          `NO_ANSWER_YET ${RENTAL_EMAILS}: it no longer sends or hands on a kept rentals address`,
        ]);
      },
      TIMEOUT,
    );
  });
});
