import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { blankSqlComments } from '@/test/kept-address-owners';
import {
  analyzeSenderFiles,
  type CallSite,
  type KeptAddressSpec,
  linkSenderFiles,
  type SenderFile,
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
 * and the test helpers left out, for each function with a body, kept apart by
 * its path in the file (`name`, `Class.method`, `object.key`, `outer>inner`;
 * src/test/kept-address-senders.ts says exactly how each fact below is found):
 *   1. SENDING. A function sends when it calls sendEmail(…) under any
 *      receiver, `.emails.send(…)` (also on an `emails` taken off the client,
 *      and by element access) or a fetch to the Resend API, or a function of
 *      the scan that sends: in its own file (by the nearest declaration of
 *      the name, `this.m`, a local class or object), or imported (a named,
 *      default or namespace import, static or dynamic with `import()`,
 *      `Class.method` of an imported class or of an instance made from one,
 *      `object.key` of an imported object), followed through re-exports. So
 *      every exported sender of lib/email counts (sendOrderRequestEmail,
 *      sendRentalOverdueEmail and the rest). packages/core sends no email
 *      (checked below), so a call into it never sends.
 *   2. READING. A function reads a kept address when it names the column, an
 *      alias of it the file can see, or selects it (KEPT_ADDRESSES), the
 *      query followed back through the variables it is kept in; when a
 *      select on another table embeds the table (`support_tickets(…)` from
 *      organizations or user_profiles, at any depth, its rows followed under
 *      the embed's key); when a function of its own file hands it the
 *      address where that function does not ask (it is handed it), by a call
 *      or by passing it as a value (`rows.map(remind)`); when it reads a
 *      registered alias off a row a call returned to it (`detail.requesterEmail`
 *      of a maintenance detail a loader in another file returns); when it
 *      calls a function, in its file or another, that returns a kept address
 *      or a row holding it, or passes one as a value (`gets it from get()`,
 *      `gets it from listSupportTickets()`), so a row handed on whole without
 *      naming the address is checked where it is handed on (integrator
 *      decision, 2026-10-31); and when it uses a name a function around it,
 *      or the file's top, holds the address or a row in (`captures it from
 *      f()`: a closure handed to `defer()` or `after()`). A support ticket's
 *      address is a column with a common name (email), so any read of
 *      support_tickets counts: any chain with a select, any embed of it, but
 *      an insert's or upsert's whose select names no kept column.
 *   3. PER SEND. Every send, and every hand-off of the address (or a row
 *      holding it) to a function of another file outside packages/core, sits
 *      in a function that calls the answer, or in a function inside that one,
 *      within the function that reads it: an answer in one callback, wrapped
 *      handler or object method does not cover a send in another, and an
 *      answer inside a callback (`rows.filter((r) => !answer(r))`) does not
 *      cover a send after it (ask in the loop that sends). A send or
 *      hand-off is also fine when the function it reaches asks first, in its
 *      own body. A function passed as a value (`defer(notify)`,
 *      `rows.map(remind)`) is called where it is passed: it sends through it
 *      and hands it what the call hands it (an array method's elements). A
 *      closure that only captures the address is guarded by an answer of the
 *      function around it that sits around the closure. The answer is the
 *      function of server/lib/kept-address.ts
 *      the call reaches, imported under any name, through a namespace import,
 *      `import()` or a re-export; a function of another file, or of its own,
 *      that only has the answer's name does not ask. A hand-off checked by
 *      hand is in REVIEWED_HANDOFFS with the reason.
 *   4. CALLS IT CANNOT FOLLOW. Where the function does not ask around it, a
 *      call carrying the address (or a row holding it) is a finding when it
 *      reaches a file of the scan but no function the scan knows, or a
 *      callee the scan cannot place at all: a function kept in a variable or
 *      a parameter, a method of an object it cannot place (a parameter, a
 *      field, what a factory returned), a global, a query builder's write,
 *      a store into an array, set or map that is not the function's own, and
 *      a method it cannot place called on an object holding the address
 *      (`notice.send()`; not a query builder's, nor an array's, a string's, a
 *      promise's, a set's, a map's or an object's own method). So is a row
 *      put into an object that outlives the function (`this.row`, a
 *      constructor parameter property, a parameter's object, one at the
 *      file's top level). Not findings: a
 *      global that only computes a value (PURE_GLOBAL_CALLS in the scan), a
 *      store into the function's own array, object, set or map, which the
 *      scan then follows. One checked by hand is in REVIEWED_HANDOFFS.
 *   5. ALIASES. Every key that carries a kept address under another name (an
 *      object key wherever the object is, but in the arguments of an answer
 *      or of a send primitive: sendEmail, `.emails.send`, a fetch to the
 *      Resend API; `o.key = address`; `this.key = address`; a constructor
 *      parameter property; a key a select renames the column to,
 *      `contact:requester_email_snapshot`) is registered in
 *      KEPT_ADDRESSES with its file and function, and every registered alias
 *      is still made there. A computed key the scan cannot read
 *      (`{ [k]: address }`, `o[k] = address`) is a finding of its own. A
 *      registered alias is then read like the column wherever its file can be
 *      seen (that file, and the files that import it), and off any row a call
 *      returned. A key with the column's own name (the support mapper's
 *      `email`) is no alias: the rows that carry it are followed by what each
 *      function returns (point 2).
 *   6. TABLES IT CANNOT READ. In every module but a 'use client' one (which
 *      runs in the browser, sends no email, and whose `.select()` calls are
 *      mostly a text field's), a select through a `.from()` whose table the
 *      scan cannot read (a variable, an imported constant), through a query
 *      it cannot trace back to a `.from()` at all, or with a select list it
 *      cannot read (not a literal, a constant of the file or a template of
 *      those) on a table that can embed support_tickets (embeddedFrom, pinned
 *      to the foreign keys in the migrations), is a finding unless
 *      REVIEWED_DYNAMIC_READS says why it reads no kept address: a loader that
 *      sends nothing can return its rows to a sender in another file.
 *   7. NO ANSWER YET. Rentals have none: a borrower without an account has no
 *      borrower_user_id either (0131), so nothing in a rental tells a deleted
 *      member from someone who never had an account. A function that reads
 *      the kept rental address and sends it, or hands it on, is listed in
 *      NO_ANSWER_YET by file and function until the B23 marker
 *      (rentals.borrower_deleted_at) exists, so a new one in a listed file
 *      still fails; a call it cannot follow (point 4) is shown even there,
 *      unless REVIEWED_HANDOFFS lists it.
 *   8. ONE NAME, TWO FUNCTIONS. Functions of one path in a file (block-scoped
 *      functions of one name) are reported when one of them reads, sends or
 *      asks: a call by that name cannot be told apart.
 * Orders answer from their own marker (order_requests.requester_deleted_at,
 * server/lib/requester-contact.ts) and are not checked here.
 *
 * IF THIS FAILS. Call the answer named in the finding in the function that
 * sends or hands on (never a copy of its rule); make a call the scan cannot
 * follow one it can (a named function, method or object function); register
 * a new alias; or, after checking it by hand, list the hand-off, the call, the
 * unread table or select list, or the rental sender with the reason.
 */

const REPO = path.resolve(__dirname, '../../../../..');
const WEB = 'apps/web/src';
const CORE = 'packages/core/src';
/** Test helpers and fixtures. Only this exact directory, as in kept-address.guard.test.ts. */
const TEST_HELPERS = 'apps/web/src/test';
const TIMEOUT = 180_000;

/** The answers' file: a call is an answer only when it reaches one of its functions. */
const KEPT_ADDRESS_FILE = 'apps/web/src/server/lib/kept-address.ts';
const MAINTENANCE_SERVICE = 'apps/web/src/server/services/maintenance-requests.ts';
const RENTAL_EMAILS = 'apps/web/src/lib/email/rentals.ts';
const RENTAL_SERVICE = 'apps/web/src/server/services/rentals.ts';
const SUPPORT_SERVICE = 'apps/web/src/server/services/support-tickets.ts';

/** The kept addresses, their aliases and their answers. */
const KEPT_ADDRESSES: Array<KeptAddressSpec & { aliasWhy: Record<string, string> }> = [
  {
    table: 'maintenance_requests',
    column: 'requester_email_snapshot',
    readBy: 'column',
    aliases: [
      {
        name: 'requesterEmail',
        file: MAINTENANCE_SERVICE,
        enclosing: 'MaintenanceRequestsService.get',
      },
      {
        name: 'requesterEmail',
        file: MAINTENANCE_SERVICE,
        enclosing: 'MaintenanceRequestsService.emailInput',
      },
    ],
    aliasWhy: {
      'MaintenanceRequestsService.get':
        'The request detail (the page, the review panel, the phone through the API) shows it.',
      'MaintenanceRequestsService.emailInput':
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
    // Its foreign keys (0173): organization_id and submitted_by. Pinned to
    // the migrations below.
    embeddedFrom: ['organizations', 'user_profiles'],
  },
  {
    table: 'rentals',
    column: 'borrower_email',
    readBy: 'column',
    aliases: [
      { name: 'borrowerEmail', file: RENTAL_EMAILS, enclosing: 'loadRentalContext' },
      { name: 'p_borrower_email', file: RENTAL_SERVICE, enclosing: 'RentalsService.create' },
    ],
    aliasWhy: {
      loadRentalContext: 'The checkout, returned and overdue emails are built from it.',
      'RentalsService.create':
        "create_rental's argument (0361): the database writes it to rentals.borrower_email.",
    },
    answer: null,
  },
];

/** Functions that send to, or hand on, a kept address nothing can answer for
 *  yet, each by file and function, so a new one in a listed file still fails. */
const NO_ANSWER_YET: Array<{ file: string; enclosing: string; table: string; why: string }> = [
  {
    file: RENTAL_EMAILS,
    enclosing: 'sendRentalEmail',
    table: 'rentals',
    why:
      'The checkout, returned and overdue emails go to borrower_email. Until the B23 marker ' +
      '(rentals.borrower_deleted_at) exists, a member who borrowed something and deleted their ' +
      'account still gets them (named in kept-address.ts and the B23 pull request).',
  },
  {
    file: RENTAL_SERVICE,
    enclosing: 'RentalsService.create',
    table: 'rentals',
    why:
      'It reads the address typed into the rental form (input.borrowerEmail), writes it and the ' +
      'audit row, and sends the checkout email through lib/email/rentals.ts; nobody has deleted ' +
      'an account between typing the address and the rental being saved.',
  },
  // The three below get create()'s answer back. create() returns only the new
  // rental's id, but a call carries what it is handed, so the scan counts the
  // address create() hands create_rental as part of what create() returns.
  {
    file: 'apps/web/src/app/api/v1/rentals/route.ts',
    enclosing: 'POST',
    table: 'rentals',
    why:
      "The phone's checkout route: RentalsService.create sends the checkout email (listed " +
      "above), and the route answers with create()'s { id } as JSON; it sends nothing itself.",
  },
  {
    file: 'apps/web/src/server/actions/rentals.ts',
    enclosing: 'createRentalAction',
    table: 'rentals',
    why:
      "The web's checkout action: RentalsService.create sends the checkout email (listed " +
      "above), and it answers the form with create()'s { id }; it sends nothing itself.",
  },
  {
    file: 'apps/web/src/components/rentals/rental-create-form.tsx',
    enclosing: 'RentalCreateFormInner>handleSubmit',
    table: 'rentals',
    why:
      'The web checkout form runs in the browser: it calls createRentalAction, whose ' +
      'RentalsService.create sends the checkout email (listed above), and reads the new ' +
      "rental's id from the answer; it sends nothing itself.",
  },
];

/** Checked by hand: hand-offs of a kept address (or a row holding it) to another file, calls
 *  the scan cannot follow (callee as written), and rows put where it does not follow them. */
const REVIEWED_HANDOFFS: Array<{ file: string; enclosing: string; callee: string; why: string }> = [
  // The phone's two maintenance request routes (counted since a call of a
  // function that returns a maintenance row is a read, 2026-10-31).
  {
    file: 'apps/web/src/app/api/v1/maintenance-requests/[id]/route.ts',
    enclosing: 'GET',
    callee: 'json',
    why:
      "The phone's request detail: it hands MaintenanceRequestsService.get's detail (its " +
      'requesterEmail, which the request page shows too) and the Outlook draft text to ' +
      "NextResponse.json for the signed-in member's app, and sends no email.",
  },
  {
    file: 'apps/web/src/app/api/v1/maintenance-requests/route.ts',
    enclosing: 'GET',
    callee: 'json',
    why:
      "The phone's request list: it hands the rows MaintenanceRequestsService.list returns to " +
      "NextResponse.json for the signed-in member's app, and sends no email.",
  },
  {
    file: RENTAL_SERVICE,
    enclosing: 'RentalsService.create',
    callee: 'this.ctx.supabase.rpc',
    why:
      'create_rental (0361), the database function that saves the rental: it writes the typed ' +
      'address to rentals.borrower_email (the alias p_borrower_email) and its lines and holds, ' +
      'and sends nothing; the database calls out only for push notifications (0028).',
  },
  {
    file: 'apps/web/src/app/(platform)/platform/support/page.tsx',
    enclosing: 'PlatformSupportPage',
    callee: 'createAttachmentSignedUrls',
    why:
      "It hands the tickets' screenshot storage keys (attachmentPath, made from the rows " +
      'listSupportTickets() returns), never an address; createAttachmentSignedUrls signs them ' +
      'for the platform admin and sends nothing.',
  },
];

/** Selects the scan cannot place, checked by hand: through a table it cannot read, through a
 *  query it cannot trace to a `.from()`, or with a select list it cannot read on a table that can
 *  embed a kept one (KeptAddressSpec.embeddedFrom). */
const REVIEWED_DYNAMIC_READS: Array<{ file: string; enclosing: string; why: string }> = [
  {
    file: MAINTENANCE_SERVICE,
    enclosing: 'MaintenanceRequestsService.resolveRelatedId',
    why:
      "Its table is typed 'inventory_items' | 'order_requests' | 'rentals' | 'locations' | " +
      "'charters' | 'warehouses', and it selects only id: no kept address.",
  },
  {
    file: 'apps/web/src/server/services/context.ts',
    enclosing: 'planLimitBudget>readCount',
    why:
      "Its table is 'inventory_items', 'locations' or 'organization_members' (the plan " +
      'resource), and it reads only a count of ids: no kept address.',
  },
  {
    file: 'apps/web/src/server/services/item-grouping.ts',
    enclosing: 'ItemGroupingService.previewGroup>named',
    why: "Its table is typed 'charters' | 'warehouses', and it selects id and name: no kept address.",
  },
  {
    file: 'apps/web/src/server/services/recovery.ts',
    enclosing: 'RecoveryService.listDeleted',
    why:
      'Its table comes from ENTITY_TABLE (inventory_items, categories, locations, suppliers), ' +
      "and it selects id, name, sku, deleted_at and the deleter's own profile: no kept address.",
  },
  {
    file: 'apps/web/src/server/services/recovery.ts',
    enclosing: 'RecoveryService.restore',
    why:
      'Its table comes from ENTITY_TABLE (inventory_items, categories, locations, suppliers), ' +
      'and it clears deleted_at and selects only id: no kept address.',
  },
  {
    file: 'apps/web/src/server/services/restore-points.ts',
    enclosing: 'matchRefMap',
    why:
      "Its table is typed 'categories' | 'suppliers' | 'locations', and it selects id and " +
      'name: no kept address.',
  },
  {
    file: 'apps/web/src/server/services/restore-points.ts',
    enclosing: 'ensureRefMap',
    why:
      "Its table is typed 'categories' | 'suppliers', and it inserts a name and selects only " +
      'id: no kept address.',
  },
  {
    file: 'apps/web/src/server/services/member-email-unsubscribe.ts',
    enclosing: 'unsubscribeMemberEmail',
    why:
      'Its user_profiles list is `${DIGEST_OPTIN_COLUMN}, disabled_at`, and DIGEST_OPTIN_COLUMN ' +
      "is 'email_digest_optin' (notification-preferences.ts): two columns of the profile, no " +
      'embedded support ticket.',
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

/** The sources, read against `context` (files read before, not read again). */
function analyzeFiles(
  sources: Source[],
  known: Set<string>,
  context: SenderFile[] = [],
): SenderFile[] {
  return analyzeSenderFiles(sources, KEPT_ADDRESSES, resolverFor(known), {
    answerFile: KEPT_ADDRESS_FILE,
    known: context,
  });
}

interface Scan {
  files: SenderFile[];
  units: SenderUnit[];
}

function scan(files: SenderFile[]): Scan {
  return { files, units: linkSenderFiles(files) };
}

function analyze(sources: Source[]): Scan {
  return scan(analyzeFiles(sources, new Set(sources.map((s) => s.file))));
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

/** The units that send, directly or through a unit of the scan. */
function sendingUnits(units: SenderUnit[]): Set<string> {
  const sending = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const u of units) {
      const k = key(u.file, u.name);
      if (sending.has(k)) continue;
      if (
        u.sends.length > 0 ||
        [...u.localCalls, ...u.importCalls].some((c) => c.target !== null && sending.has(c.target))
      ) {
        sending.add(k);
        changed = true;
      }
    }
  }
  return sending;
}

const isCore = (c: CallSite) =>
  c.module === '@stockpilot/core' || (c.module?.startsWith('@stockpilot/core/') ?? false);

function senderFindings({ files, units }: Scan): string[] {
  const out: string[] = [];
  const byKey = new Map(units.map((u) => [key(u.file, u.name), u]));
  const sending = sendingUnits(units);
  /** The unit a call reaches asks first: it calls the answer in its own
   *  function (not only in a callback inside it), so the answer guards every
   *  send and hand-off of it. */
  const asksFirst = (k: string | null, answer: string) => {
    const t = k === null ? undefined : byKey.get(k);
    return t?.answerSites.some((a) => a.answer === answer && a.home === t.start) ?? false;
  };
  const listedSeen = new Set<(typeof NO_ANSWER_YET)[number]>();
  const handoffsSeen = new Set<(typeof REVIEWED_HANDOFFS)[number]>();
  const reviewedHandoff = (u: SenderUnit, callee: string) => {
    const r = REVIEWED_HANDOFFS.find(
      (h) => h.file === u.file && h.enclosing === u.name && h.callee === callee,
    );
    if (r) handoffsSeen.add(r);
    return r !== undefined;
  };

  // Two units with one path (block-scoped functions of one name): calls by
  // that name all resolve to the first, so the guard cannot tell them apart.
  // That matters only where one of them reads a kept address, sends or asks.
  for (const f of files) {
    for (const d of f.duplicates) {
      const group = d.lines.map((_, i) => (i === 0 ? d.name : `${d.name}#${i + 1}`));
      const matters = group.some((name) => {
        const u = byKey.get(key(f.file, name));
        return (
          sending.has(key(f.file, name)) ||
          (u !== undefined && (u.reads.length > 0 || u.answers.length > 0))
        );
      });
      if (!matters) continue;
      out.push(
        `${f.file}:${d.lines.join(',')} ${d.lines.length} functions are all ${d.name}(): ` +
          'the guard cannot tell their calls apart; rename one',
      );
    }
  }

  for (const u of units) {
    for (const table of [...new Set(u.reads.map((r) => r.table))]) {
      const spec = KEPT_ADDRESSES.find((s) => s.table === table)!;
      const what = `${spec.table}.${spec.column}`;
      // A unit that only gets the address from a caller in its file, or from
      // what functions return, says so.
      const own = u.reads.filter((r) => r.table === table);
      const GETS = 'gets it from ';
      const CAPTURES = 'captures it from ';
      const from = (prefix: string) =>
        [...new Set(own.map((r) => r.how.slice(prefix.length)))].join(', ');
      const reads = own.every((r) => r.how.startsWith('is handed it by '))
        ? `is handed ${what} by ${own[0]!.how.slice('is handed it by '.length)}`
        : own.every((r) => r.how.startsWith(GETS))
          ? `gets ${what} from ${from(GETS)}`
          : own.every((r) => r.how.startsWith(CAPTURES))
            ? `captures ${what} from ${from(CAPTURES)}`
            : `reads ${what}`;
      const calls = [...u.localCalls, ...u.importCalls];
      const sendsThrough = calls.filter((c) => c.target !== null && sending.has(c.target));
      const unresolved = u.importCalls.filter((c) => c.unresolved && c.carries.includes(table));
      const unknown = u.unknownCalls.filter((c) => c.carries.includes(table));
      const handoffs = u.importCalls.filter(
        (c) =>
          c.carries.includes(table) && !isCore(c) && !c.unresolved && !sendsThrough.includes(c),
      );
      // An answer guards the sends and hand-offs in the function it is called
      // in (and the functions inside that one), not those of another function
      // of the unit, such as a sibling callback.
      const guarded = (fns: number[]) =>
        spec.answer !== null &&
        u.answerSites.some((a) => a.answer === spec.answer && fns.includes(a.home));
      const fix = spec.answer === null ? '' : `, or ask ${spec.answer}() first`;
      // A hand-off the scan cannot follow, like any other, is fine once the
      // function asks around it; with no answer for the table (rentals) it is
      // always shown, but for a call reviewed by hand.
      const lost = (c: CallSite) =>
        `${u.file}:${c.line} ${fn(u)} hands ${what} to ${c.name}() (${c.module}), which reaches ` +
        `no function the scan can follow in ${c.resolved}: make it a function, method or ` +
        `object function the scan reads${fix}`;
      const cannotPlace = (c: CallSite) =>
        `${u.file}:${c.line} ${fn(u)} hands ${what} to ${c.name}(), a call the scan cannot ` +
        'follow to a function it reads: call a function, method or object function the scan ' +
        `reads${fix}, or check the call by hand and list it in REVIEWED_HANDOFFS`;
      for (const c of unresolved) if (!guarded(c.fns)) out.push(lost(c));
      for (const c of unknown) {
        if (!guarded(c.fns) && !reviewedHandoff(u, c.name)) out.push(cannotPlace(c));
      }
      for (const e of u.escapes.filter((x) => x.table === table)) {
        if (guarded(e.fns) || reviewedHandoff(u, e.target)) continue;
        out.push(
          `${u.file}:${e.line} ${fn(u)} puts a row holding ${what} into ${e.target}, which ` +
            'outlives the function, and the scan does not follow it there: keep the row in a ' +
            `variable of the function${fix}, or check it by hand and list it in REVIEWED_HANDOFFS`,
        );
      }

      if (spec.answer === null) {
        if (u.sends.length === 0 && sendsThrough.length === 0 && handoffs.length === 0) continue;
        const listed = NO_ANSWER_YET.find(
          (l) => l.file === u.file && l.enclosing === u.name && l.table === table,
        );
        if (listed) listedSeen.add(listed);
        else {
          out.push(
            `${u.file}:${u.line} ${fn(u)} ${reads} and sends it or hands it on, and nothing ` +
              'can answer for it yet: list the function in NO_ANSWER_YET with the reason',
          );
        }
        continue;
      }
      const answer = spec.answer;
      const ask = `without asking ${answer}() in server/lib/kept-address.ts`;
      for (const s of u.sends) {
        if (guarded(s.fns)) continue;
        out.push(`${u.file}:${s.line} ${fn(u)} ${reads} and sends email (${s.how}) ${ask}`);
      }
      const sentDirectly = new Set(u.sends.map((x) => x.line));
      for (const c of sendsThrough) {
        if (sentDirectly.has(c.line)) continue; // sendEmail itself: reported above
        if (guarded(c.fns) || asksFirst(c.target, answer)) continue;
        out.push(
          `${u.file}:${c.line} ${fn(u)} ${reads} and sends email through ${c.name}() ${ask}`,
        );
      }
      for (const c of handoffs) {
        if (guarded(c.fns) || asksFirst(c.target, answer)) continue;
        if (reviewedHandoff(u, c.name)) continue;
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
  // A key the scan cannot read can be no registered alias.
  for (const u of units) {
    for (const k of u.unreadableKeys) {
      const spec = KEPT_ADDRESSES.find((s) => s.table === k.table)!;
      out.push(
        `${u.file}:${k.line} ${fn(u)} puts ${spec.table}.${spec.column} under ${k.key}, a key ` +
          'the scan cannot read: use a fixed key and register it in KEPT_ADDRESSES',
      );
    }
  }

  // Selects of a table the scan cannot read, in any module but a 'use client'
  // one (it runs in the browser, sends no email, and its `.select()` calls
  // are mostly a text field's).
  const clientFiles = new Set(files.filter((f) => f.client).map((f) => f.file));
  const dynamicSeen = new Set<(typeof REVIEWED_DYNAMIC_READS)[number]>();
  for (const u of units) {
    if (clientFiles.has(u.file)) continue;
    for (const d of u.dynamicReads) {
      const reviewed = REVIEWED_DYNAMIC_READS.find(
        (r) => r.file === u.file && r.enclosing === u.name,
      );
      if (reviewed) dynamicSeen.add(reviewed);
      else {
        out.push(
          `${u.file}:${d.line} ${fn(u)} selects through ${d.what}: check it reads no kept ` +
            'address and list it in REVIEWED_DYNAMIC_READS',
        );
      }
    }
  }

  for (const l of NO_ANSWER_YET) {
    if (!listedSeen.has(l)) {
      out.push(
        `NO_ANSWER_YET ${l.file} ${l.enclosing}(): it no longer sends or hands on a kept ` +
          `${l.table} address`,
      );
    }
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
  let repoScan: Scan | null = null;
  const repoSources = () => (web ??= read(WEB));
  const repo = () => (repoScan ??= analyze(repoSources()));
  /** The repository with planted files added (or put in place of a file of
   *  the same name); imports resolve among both. Planted files are analyzed
   *  against the repository's files and what their functions return; the
   *  repository's own analysis is reused, so only an import of a planted
   *  file from a repository file is not seen (no plant needs one). */
  const withPlanted = (planted: Source[]) => {
    const plantedFiles = new Set(planted.map((p) => p.file));
    const known = new Set([...repoSources().map((s) => s.file), ...plantedFiles]);
    const context = repo().files.filter((f) => !plantedFiles.has(f.file));
    const files = [...context, ...analyzeFiles(planted, known, context)];
    return senderFindings(scan(files));
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
      const sending = sendingUnits(repo().units);
      const asking = repo()
        .units.filter((u) => sending.has(key(u.file, u.name)))
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
      const sending = sendingUnits(repo().units);
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
      const sends = analyze(read(CORE)).units.flatMap((u) =>
        u.sends.map((s) => `${u.file}:${s.line} ${s.how}`),
      );
      expect(sends).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'follows the rows the support list functions and the maintenance detail return',
    () => {
      const returns = (file: string, name: string) =>
        repo().units.find((u) => u.file === file && u.name === name)?.returns;
      for (const name of ['listSupportTickets', 'listMyTickets', 'mapRow']) {
        expect(returns(SUPPORT_SERVICE, name), name).toEqual({ support_tickets: 'row' });
      }
      expect(returns(MAINTENANCE_SERVICE, 'MaintenanceRequestsService.get')).toMatchObject({
        maintenance_requests: 'row',
      });
      const page = repo().units.find(
        (u) =>
          u.file === 'apps/web/src/app/(platform)/platform/support/page.tsx' &&
          u.name === 'PlatformSupportPage',
      );
      expect(page?.reads.map((r) => r.how)).toContain('gets it from listSupportTickets()');
    },
    TIMEOUT,
  );

  it('every registered alias says why it is made', () => {
    for (const spec of KEPT_ADDRESSES) {
      for (const a of spec.aliases) expect(spec.aliasWhy[a.enclosing], a.enclosing).toBeTruthy();
    }
  });

  it('a table read by its chains lists every table a select can embed it from (its foreign keys in the migrations)', () => {
    const dir = path.join(REPO, 'supabase/migrations');
    const statements = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .flatMap((f) => blankSqlComments(readFileSync(path.join(dir, f), 'utf8')).split(';'));
    const TABLE_OF =
      /^\s*(?:create\s+table|alter\s+table)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:only\s+)?(?:public\.)?(\w+)/i;
    for (const spec of KEPT_ADDRESSES.filter((s) => s.readBy === 'table')) {
      const related = new Set<string>();
      for (const st of statements) {
        const table = TABLE_OF.exec(st)?.[1]?.toLowerCase();
        if (!table) continue;
        const refs = [...st.matchAll(/\breferences\s+(?:public\.)?(\w+)/gi)].map((m) =>
          m[1]!.toLowerCase(),
        );
        // Its own foreign keys, and another table's foreign key to it.
        if (table === spec.table) for (const r of refs) related.add(r);
        else if (refs.includes(spec.table)) related.add(table);
      }
      related.delete(spec.table);
      expect([...(spec.embeddedFrom ?? [])].sort(), spec.table).toEqual([...related].sort());
    }
  });

  describe('self-test: planted senders the file-level guard (fe0816022) passed are caught', () => {
    const READ_MAINTENANCE = `
        const { data } = await admin
          .from('maintenance_requests')
          .select('id, requester_user_id, requester_email_snapshot')
          .eq('id', id)
          .maybeSingle();`;
    /** The end of a finding for a call that hands a kept address to a callee
     *  the scan cannot place (unknownCalls), for a table with an answer. */
    const cannotPlace = (answer: string) =>
      ', a call the scan cannot follow to a function it reads: call a function, method or ' +
      `object function the scan reads, or ask ${answer}() first, or check the call by hand and ` +
      'list it in REVIEWED_HANDOFFS';
    const CANNOT_PLACE_M = cannotPlace('maintenanceRequesterAccountDeleted');

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
          // (6): an object handed to a sender that is not a send primitive.
          'apps/web/src/server/email/plant-order-sender.ts:9 sendReopened() puts maintenance_requests.requester_email_snapshot into to: register the alias in KEPT_ADDRESSES so its readers are checked',
        ]);
      },
      TIMEOUT,
    );

    it(
      '(1) a sender reached through an instance of an imported class, made either way',
      () => {
        const planted: Source[] = [
          {
            file: 'apps/web/src/server/services/plant-notices.ts',
            text: `
              export class NoticeService {
                static async forCurrentUser() {
                  return new NoticeService();
                }
                async notify(to: string) {
                  await sendEmail({ to, subject: 'Reopened', html: '' });
                }
              }`,
          },
          {
            file: 'apps/web/src/server/services/plant-instance.ts',
            text: `
              import { NoticeService } from '@/server/services/plant-notices';
              export async function reopen(admin: Admin, id: string) {${READ_MAINTENANCE}
                const svc = await NoticeService.forCurrentUser();
                await svc.notify(data!.requester_email_snapshot!);
                await new NoticeService().notify(data!.requester_email_snapshot!);
              }`,
          },
        ];
        expect(withPlanted(planted)).toEqual([
          'apps/web/src/server/services/plant-instance.ts:10 reopen() reads maintenance_requests.requester_email_snapshot and sends email through notify() without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/services/plant-instance.ts:11 reopen() reads maintenance_requests.requester_email_snapshot and sends email through notify() without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
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
          'apps/web/src/server/services/plant-support-const.ts:4 remind() selects through .from(SUPPORT_TABLE), a table the scan cannot read: check it reads no kept address and list it in REVIEWED_DYNAMIC_READS',
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
          'apps/web/src/server/email/plant-alias-rental.ts:3 sendDueSoon() reads rentals.borrower_email and sends it or hands it on, and nothing can answer for it yet: list the function in NO_ANSWER_YET with the reason',
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
          // The checkout email the rental service calls is gone with the file.
          `${RENTAL_SERVICE}:306 RentalsService.create() hands rentals.borrower_email to sendRentalCheckoutEmail() (@/lib/email/rentals), which reaches no function the scan can follow in ${RENTAL_EMAILS}: make it a function, method or object function the scan reads`,
          `KEPT_ADDRESSES rentals alias borrowerEmail: ${RENTAL_EMAILS} loadRentalContext() no longer makes it`,
          `NO_ANSWER_YET ${RENTAL_EMAILS} sendRentalEmail(): it no longer sends or hands on a kept rentals address`,
          // With no checkout email, create() sends nothing, so the action and
          // the form that reach it no longer send either.
          'NO_ANSWER_YET apps/web/src/server/actions/rentals.ts createRentalAction(): it no longer sends or hands on a kept rentals address',
          'NO_ANSWER_YET apps/web/src/components/rentals/rental-create-form.tsx RentalCreateFormInner>handleSubmit(): it no longer sends or hands on a kept rentals address',
        ]);
      },
      TIMEOUT,
    );

    // guard_review_2 (2026-10-31): each plant below passed the per-function
    // helper of e46dd99f4 with no finding.
    const PLANTS_5: Source[] = [
      {
        file: 'apps/web/src/server/email/plant-same-method.ts',
        text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';
              export class ResolvedNotice {
                async send(admin: Admin, id: string) {${READ_MAINTENANCE}
                  if (!data || maintenanceRequesterAccountDeleted(data)) return;
                  await sendEmail({ to: data.requester_email_snapshot, subject: 'Resolved', html: '' });
                }
              }
              export class ReopenedNotice {
                async send(admin: Admin, id: string) {${READ_MAINTENANCE}
                  await sendEmail({ to: data?.requester_email_snapshot, subject: 'Reopened', html: '' });
                }
              }`,
      },
      {
        file: 'apps/web/src/server/email/plant-nested-name.ts',
        text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';
              export async function sendResolved(admin: Admin, id: string) {${READ_MAINTENANCE}
                if (!data || maintenanceRequesterAccountDeleted(data)) return;
                await sendEmail({ to: data.requester_email_snapshot, subject: 'Resolved', html: '' });
              }
              export async function sendAll(admin: Admin, ids: string[]) {
                async function sendResolved(id: string) {${READ_MAINTENANCE}
                  await sendEmail({ to: data?.requester_email_snapshot, subject: 'Resolved', html: '' });
                }
                for (const id of ids) await sendResolved(id);
              }`,
      },
    ];
    const PLANTS_6: Source[] = [
      {
        file: 'apps/web/src/server/services/plant-alias-arg.ts',
        text: `
              export async function reopen(admin: Admin, id: string) {${READ_MAINTENANCE}
                await queueNotice(admin, { recipient: data?.requester_email_snapshot ?? null });
              }
              async function queueNotice(admin: Admin, payload: { recipient: string | null }) {
                await admin.from('notice_outbox').insert({ payload });
              }`,
      },
    ];
    const PLANTS_7: Source[] = [
      {
        file: 'apps/web/src/server/services/plant-split-chain.ts',
        text: `
              export async function remindTicket(admin: Admin, id: string) {
                let q = admin.from('support_tickets');
                q = q.select('email').eq('id', id);
                const { data } = await q.single();
                await sendEmail({ to: data.email, subject: 'Still open', html: '' });
              }`,
      },
      {
        file: 'apps/web/src/server/services/plant-untraced.ts',
        text: `
              export async function remindTicket(admin: Admin, id: string) {
                const query = ticketsOf(admin);
                const { data } = await query.select('email').eq('id', id).single();
                await sendEmail({ to: data.email, subject: 'Still open', html: '' });
              }
              function ticketsOf(admin: Admin) {
                return admin.from('support_tickets');
              }`,
      },
    ];
    const PLANTS_8: Source[] = [
      {
        file: 'apps/web/src/server/services/plant-notice-classes.ts',
        text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';
              export class QuietNotice {
                async notify(to: string, row: { requester_user_id: string | null }) {
                  if (maintenanceRequesterAccountDeleted(row)) return;
                  await sendEmail({ to, subject: 'Reopened', html: '' });
                }
              }
              export class LoudNotice {
                async notify(to: string) {
                  await sendEmail({ to, subject: 'Reopened', html: '' });
                }
              }`,
      },
      {
        file: 'apps/web/src/server/services/plant-loud.ts',
        text: `
              import { LoudNotice } from '@/server/services/plant-notice-classes';
              export async function reopen(admin: Admin, id: string) {${READ_MAINTENANCE}
                await new LoudNotice().notify(data!.requester_email_snapshot!);
              }`,
      },
      {
        file: 'apps/web/src/server/email/plant-direct.ts',
        text: `
              export async function notifyRequester(to: string) {
                await sendEmail({ to, subject: 'Reopened', html: '' });
              }`,
      },
      {
        file: 'apps/web/src/server/email/plant-direct-star.ts',
        text: `
              export async function notifyAgain(to: string) {
                await sendEmail({ to, subject: 'Reopened again', html: '' });
              }`,
      },
      {
        file: 'apps/web/src/server/email/plant-barrel.ts',
        text: `
              export { notifyRequester as notifyOwner } from '@/server/email/plant-direct';
              export * from '@/server/email/plant-direct-star';`,
      },
      {
        file: 'apps/web/src/server/services/plant-via-barrel.ts',
        text: `
              import { notifyAgain, notifyOwner } from '@/server/email/plant-barrel';
              export async function reopen(admin: Admin, id: string) {${READ_MAINTENANCE}
                await tell(data!.requester_email_snapshot!);
              }
              async function tell(to: string) {
                await notifyOwner(to);
                await notifyAgain(to);
              }`,
      },
      {
        file: 'apps/web/src/server/email/plant-obj.ts',
        text: `
              export const notices = {
                reopened: async (to: string) => {
                  await sendEmail({ to, subject: 'Reopened', html: '' });
                },
              };
              export const helpers = makeHelpers();`,
      },
      {
        file: 'apps/web/src/server/services/plant-unresolved.ts',
        text: `
              import { helpers, notices } from '@/server/email/plant-obj';
              export async function reopen(admin: Admin, id: string) {${READ_MAINTENANCE}
                await tell(data!.requester_email_snapshot!);
              }
              async function tell(to: string) {
                await notices.reopened(to);
                await helpers.remind(to);
              }`,
      },
    ];

    it(
      '(5) two functions of one name in a file: methods of two classes, and a nested function',
      () => {
        expect(withPlanted(PLANTS_5)).toEqual([
          'apps/web/src/server/email/plant-same-method.ts:21 ReopenedNotice.send() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail) without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/email/plant-nested-name.ts:19 sendAll>sendResolved() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail) without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
        ]);
      },
      TIMEOUT,
    );

    it(
      '(5) two block-scoped functions of one name, one of them sending, are reported',
      () => {
        const planted: Source[] = [
          {
            file: 'apps/web/src/server/email/plant-block-scoped.ts',
            text: `
              export async function notify(admin: Admin, id: string, loud: boolean) {${READ_MAINTENANCE}
                if (loud) {
                  const deliver = async () => null;
                  await deliver();
                } else {
                  const deliver = async (to: string) => sendEmail({ to, subject: 'Quiet', html: '' });
                  await deliver(data!.requester_email_snapshot!);
                }
              }`,
          },
        ];
        expect(withPlanted(planted)).toEqual([
          'apps/web/src/server/email/plant-block-scoped.ts:9,12 2 functions are all notify>deliver(): the guard cannot tell their calls apart; rename one',
        ]);
      },
      TIMEOUT,
    );

    it(
      '(6) a kept address put into an object in a call that is not a send primitive or an answer',
      () => {
        expect(withPlanted(PLANTS_6)).toEqual([
          // (8, 2026-10-31): the outbox write is a callee the scan cannot place.
          `apps/web/src/server/services/plant-alias-arg.ts:11 queueNotice() hands maintenance_requests.requester_email_snapshot to admin.from('notice_outbox').insert()${CANNOT_PLACE_M}`,
          'apps/web/src/server/services/plant-alias-arg.ts:8 reopen() puts maintenance_requests.requester_email_snapshot into recipient: register the alias in KEPT_ADDRESSES so its readers are checked',
        ]);
      },
      TIMEOUT,
    );

    it(
      '(7) a support query built across variables, and a select the scan cannot trace to a .from()',
      () => {
        expect(withPlanted(PLANTS_7)).toEqual([
          'apps/web/src/server/services/plant-split-chain.ts:6 remindTicket() reads support_tickets.email and sends email (sendEmail) without asking supportTicketSubmitterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/services/plant-untraced.ts:4 remindTicket() selects through query, which the scan cannot trace to a .from(): check it reads no kept address and list it in REVIEWED_DYNAMIC_READS',
        ]);
      },
      TIMEOUT,
    );

    it(
      '(8) a hand-off the scan cannot follow is fine once the function asks',
      () => {
        const planted: Source[] = [
          PLANTS_8.find((p) => p.file === 'apps/web/src/server/email/plant-obj.ts')!,
          {
            file: 'apps/web/src/server/services/plant-asks-first.ts',
            text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';
              import { helpers } from '@/server/email/plant-obj';
              export async function reopen(admin: Admin, id: string) {${READ_MAINTENANCE}
                if (!data || maintenanceRequesterAccountDeleted(data)) return;
                await helpers.remind(data.requester_email_snapshot!);
              }`,
          },
        ];
        expect(withPlanted(planted)).toEqual([]);
      },
      TIMEOUT,
    );

    it(
      '(8) Class.method across classes, re-exports, and a call that reaches no function',
      () => {
        expect(withPlanted(PLANTS_8)).toEqual([
          'apps/web/src/server/services/plant-loud.ts:9 reopen() reads maintenance_requests.requester_email_snapshot and sends email through notify() without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/services/plant-via-barrel.ts:9 reopen() reads maintenance_requests.requester_email_snapshot and sends email through tell() without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/services/plant-via-barrel.ts:12 tell() is handed maintenance_requests.requester_email_snapshot by reopen() and sends email through notifyOwner() without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/services/plant-via-barrel.ts:13 tell() is handed maintenance_requests.requester_email_snapshot by reopen() and sends email through notifyAgain() without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/services/plant-unresolved.ts:9 reopen() reads maintenance_requests.requester_email_snapshot and sends email through tell() without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/services/plant-unresolved.ts:13 tell() hands maintenance_requests.requester_email_snapshot to remind() (@/server/email/plant-obj), which reaches no function the scan can follow in apps/web/src/server/email/plant-obj.ts: make it a function, method or object function the scan reads, or ask maintenanceRequesterAccountDeleted() first',
          'apps/web/src/server/services/plant-unresolved.ts:12 tell() is handed maintenance_requests.requester_email_snapshot by reopen() and sends email through reopened() without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
        ]);
      },
      TIMEOUT,
    );

    // Review 3 (2026-10-31), finding 3: an answer was counted by its bare
    // name, so a function that only had that name passed for asking. Each
    // plant below passed the helper of b52da7e63 with no finding.
    const PLANTS_ANSWER_LOOKALIKES = (): Source[] => {
      const real = readFileSync(path.join(REPO, SUPPORT_SERVICE), 'utf8');
      const IMPORT = `import {
  supportTicketOwner,
  supportTicketSubmitterAccountDeleted,
} from '@/server/lib/kept-address';`;
      if (!real.includes(IMPORT))
        throw new Error('the support service no longer imports the answer');
      return [
        {
          // The support service with its own copy in place of the import.
          file: SUPPORT_SERVICE,
          text: real.replace(
            IMPORT,
            `import { supportTicketOwner } from '@/server/lib/kept-address';
function supportTicketSubmitterAccountDeleted(_row: unknown): boolean {
  return false;
}`,
          ),
        },
        {
          file: 'apps/web/src/server/email/plant-own-answer.ts',
          text: `
              export async function remindRequester(admin: Admin, id: string) {${READ_MAINTENANCE}
                if (!data || maintenanceRequesterAccountDeleted(data)) return;
                await sendEmail({ to: data.requester_email_snapshot, subject: 'Reminder', html: '' });
              }
              function maintenanceRequesterAccountDeleted(_row: unknown) {
                return false;
              }`,
        },
        {
          file: 'apps/web/src/server/lib/plant-lookalike.ts',
          text: `
              export function maintenanceRequesterAccountDeleted(_row: unknown) {
                return false;
              }`,
        },
        {
          file: 'apps/web/src/server/email/plant-lookalike-import.ts',
          text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/plant-lookalike';
              export async function remindRequester(admin: Admin, id: string) {${READ_MAINTENANCE}
                if (!data || maintenanceRequesterAccountDeleted(data)) return;
                await sendEmail({ to: data.requester_email_snapshot, subject: 'Reminder', html: '' });
              }`,
        },
        {
          file: 'apps/web/src/server/email/plant-shadowed-answer.ts',
          text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';
              export async function viaMember(admin: Admin, id: string, rules: Rules) {${READ_MAINTENANCE}
                if (!data || rules.maintenanceRequesterAccountDeleted(data)) return;
                await sendEmail({ to: data.requester_email_snapshot, subject: 'Reminder', html: '' });
              }
              export async function viaParameter(
                admin: Admin,
                id: string,
                maintenanceRequesterAccountDeleted: (row: unknown) => boolean,
              ) {${READ_MAINTENANCE}
                if (!data || maintenanceRequesterAccountDeleted(data)) return;
                await sendEmail({ to: data.requester_email_snapshot, subject: 'Reminder', html: '' });
              }
              export async function viaNested(admin: Admin, id: string) {
                function maintenanceRequesterAccountDeleted(_row: unknown) {
                  return false;
                }${READ_MAINTENANCE}
                if (!data || maintenanceRequesterAccountDeleted(data)) return;
                await sendEmail({ to: data.requester_email_snapshot, subject: 'Reminder', html: '' });
              }
              export const realAnswer = maintenanceRequesterAccountDeleted;`,
        },
      ];
    };
    const PLANTS_ANSWER_IMPORTED: Source[] = [
      {
        file: 'apps/web/src/server/lib/plant-kept-barrel.ts',
        text: `export { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';`,
      },
      {
        file: 'apps/web/src/server/email/plant-asks-every-way.ts',
        text: `
              import { maintenanceRequesterAccountDeleted as requesterGone } from '@/server/lib/kept-address';
              import * as kept from '@/server/lib/kept-address';
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/plant-kept-barrel';
              export async function viaAlias(admin: Admin, id: string) {${READ_MAINTENANCE}
                if (!data || requesterGone(data)) return;
                await sendEmail({ to: data.requester_email_snapshot, subject: 'Reminder', html: '' });
              }
              export async function viaNamespace(admin: Admin, id: string) {${READ_MAINTENANCE}
                if (!data || kept.maintenanceRequesterAccountDeleted(data)) return;
                await sendEmail({ to: data.requester_email_snapshot, subject: 'Reminder', html: '' });
              }
              export async function viaBarrel(admin: Admin, id: string) {${READ_MAINTENANCE}
                if (!data || maintenanceRequesterAccountDeleted(data)) return;
                await sendEmail({ to: data.requester_email_snapshot, subject: 'Reminder', html: '' });
              }`,
      },
    ];

    // Review 3 (2026-10-31), finding 4: a kept address a function returned
    // was not followed, in its file or in another one. Each plant below
    // passed the helper of b52da7e63 with no finding. The two-hop sender
    // comes before its loader, so what the loader returns is learned in a
    // later round of analyzeSenderFiles.
    const PLANTS_RETURNED: Source[] = [
      {
        file: 'apps/web/src/server/email/plant-two-hop.ts',
        text: `
              import { loadDetail } from '@/server/lib/plant-load-request';
              export async function remindRequester(id: string) {
                const detail = await loadDetail(id);
                await sendEmail({ to: detail.requesterEmail ?? '', subject: 'Reminder', html: '' });
              }
              export async function remindAgain(id: string) {
                const { requesterEmail } = await loadDetail(id);
                await sendEmail({ to: requesterEmail ?? '', subject: 'Reminder', html: '' });
              }`,
      },
      {
        file: 'apps/web/src/server/jobs/plant-ticket-reminder.ts',
        text: `
              import { listSupportTickets } from '@/server/services/support-tickets';
              export async function remindOpenTickets() {
                const tickets = await listSupportTickets({ status: 'open' });
                for (const t of tickets) {
                  await sendEmail({ to: t.email, subject: 'Is your ticket still open?', html: '' });
                }
              }`,
      },
      {
        file: 'apps/web/src/server/jobs/plant-my-tickets.ts',
        text: `
              import { listMyTickets } from '@/server/services/support-tickets';
              export async function digest(userId: string, organizationId: string) {
                const [first] = await listMyTickets({ userId, organizationId });
                if (first) await sendEmail({ to: first.email, subject: 'Your tickets', html: '' });
              }`,
      },
      {
        file: 'apps/web/src/server/services/plant-ticket-helper.ts',
        text: `
              async function loadTicket(admin: Admin, id: string) {
                const { data } = await admin.from('support_tickets').select('*').eq('id', id).single();
                return data;
              }
              const ticketOf = (admin: Admin, id: string) => loadTicket(admin, id);
              export async function loadTickets(admin: Admin, ids: string[]) {
                return Promise.all(ids.map((id) => loadTicket(admin, id)));
              }
              export async function remind(admin: Admin, id: string) {
                const t = await ticketOf(admin, id);
                await sendEmail({ to: t.email, subject: 'Still open?', html: '' });
              }
              export async function remindAll(admin: Admin, ids: string[]) {
                const tickets = await Promise.all(ids.map((id) => loadTicket(admin, id)));
                for (const t of tickets) await sendEmail({ to: t.email, subject: 'Still open?', html: '' });
              }`,
      },
      {
        file: 'apps/web/src/server/jobs/plant-ticket-batch.ts',
        text: `
              import { loadTickets } from '@/server/services/plant-ticket-helper';
              export async function remindBatch(admin: Admin, ids: string[]) {
                for (const t of await loadTickets(admin, ids)) {
                  await sendEmail({ to: t.email, subject: 'Still open?', html: '' });
                }
              }`,
      },
      {
        file: 'apps/web/src/server/lib/plant-load-request.ts',
        text: `
              import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';
              export async function loadDetail(id: string) {
                const svc = await MaintenanceRequestsService.forCurrentUser();
                return svc.get(id);
              }`,
      },
    ];

    it(
      '(9) an answer is the kept-address.ts function a call reaches: a function, an import or a member that only has its name is not one',
      () => {
        expect(withPlanted(PLANTS_ANSWER_LOOKALIKES())).toEqual([
          'apps/web/src/server/services/support-tickets.ts:363 updateSupportTicket() reads support_tickets.email and sends email through sendResolvedNotice() without asking supportTicketSubmitterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/services/support-tickets.ts:362 updateSupportTicket() hands support_tickets.email to keepAlive() (@/server/services/lib/defer) without asking supportTicketSubmitterAccountDeleted() in server/lib/kept-address.ts: ask first, or check the hand-off by hand and list it in REVIEWED_HANDOFFS',
          'apps/web/src/server/services/support-tickets.ts:415 sendResolvedNotice() is handed support_tickets.email by updateSupportTicket() and sends email (sendEmail) without asking supportTicketSubmitterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/services/support-tickets.ts:392 sendResolvedNotice() hands support_tickets.email to renderSupportResolvedEmailHtml() (@/lib/email/es/families/support) without asking supportTicketSubmitterAccountDeleted() in server/lib/kept-address.ts: ask first, or check the hand-off by hand and list it in REVIEWED_HANDOFFS',
          'apps/web/src/server/email/plant-own-answer.ts:9 remindRequester() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail) without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/email/plant-lookalike-import.ts:10 remindRequester() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail) without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/email/plant-lookalike-import.ts:9 remindRequester() hands maintenance_requests.requester_email_snapshot to maintenanceRequesterAccountDeleted() (@/server/lib/plant-lookalike) without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts: ask first, or check the hand-off by hand and list it in REVIEWED_HANDOFFS',
          // (8, 2026-10-31): a member of a parameter, and a parameter called as
          // a function, are callees the scan cannot place.
          `apps/web/src/server/email/plant-shadowed-answer.ts:9 viaMember() hands maintenance_requests.requester_email_snapshot to rules.maintenanceRequesterAccountDeleted()${CANNOT_PLACE_M}`,
          'apps/web/src/server/email/plant-shadowed-answer.ts:10 viaMember() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail) without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
          `apps/web/src/server/email/plant-shadowed-answer.ts:22 viaParameter() hands maintenance_requests.requester_email_snapshot to maintenanceRequesterAccountDeleted()${CANNOT_PLACE_M}`,
          'apps/web/src/server/email/plant-shadowed-answer.ts:23 viaParameter() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail) without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/email/plant-shadowed-answer.ts:35 viaNested() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail) without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
        ]);
      },
      TIMEOUT,
    );

    it(
      '(9) the answer imported under another name, through a namespace import or through a re-export is asked',
      () => {
        expect(withPlanted(PLANTS_ANSWER_IMPORTED)).toEqual([]);
      },
      TIMEOUT,
    );

    it(
      '(10) a kept address a function returns: rows from listSupportTickets() and listMyTickets(), a helper of the same file, a callback, and a loader in another file',
      () => {
        expect(withPlanted(PLANTS_RETURNED)).toEqual([
          'apps/web/src/server/email/plant-two-hop.ts:5 remindRequester() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail) without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/email/plant-two-hop.ts:9 remindAgain() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail) without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/jobs/plant-ticket-reminder.ts:6 remindOpenTickets() gets support_tickets.email from listSupportTickets() and sends email (sendEmail) without asking supportTicketSubmitterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/jobs/plant-my-tickets.ts:5 digest() gets support_tickets.email from listMyTickets() and sends email (sendEmail) without asking supportTicketSubmitterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/services/plant-ticket-helper.ts:12 remind() gets support_tickets.email from ticketOf() and sends email (sendEmail) without asking supportTicketSubmitterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/services/plant-ticket-helper.ts:16 remindAll() gets support_tickets.email from loadTicket() and sends email (sendEmail) without asking supportTicketSubmitterAccountDeleted() in server/lib/kept-address.ts',
          'apps/web/src/server/jobs/plant-ticket-batch.ts:5 remindBatch() gets support_tickets.email from loadTickets() and sends email (sendEmail) without asking supportTicketSubmitterAccountDeleted() in server/lib/kept-address.ts',
        ]);
      },
      TIMEOUT,
    );

    it(
      '(10) a function that asks for each row a function returns is fine',
      () => {
        const planted: Source[] = [
          {
            file: 'apps/web/src/server/jobs/plant-ticket-reminder-asks.ts',
            text: `
              import { supportTicketSubmitterAccountDeleted } from '@/server/lib/kept-address';
              import { listSupportTickets } from '@/server/services/support-tickets';
              export async function remindOpenTickets() {
                const tickets = await listSupportTickets({ status: 'open' });
                for (const t of tickets) {
                  const owner = { organization_id: t.organizationId, submitted_by: t.submittedBy };
                  if (supportTicketSubmitterAccountDeleted(owner)) continue;
                  await sendEmail({ to: t.email, subject: 'Is your ticket still open?', html: '' });
                }
              }`,
          },
        ];
        expect(withPlanted(planted)).toEqual([]);
      },
      TIMEOUT,
    );

    // ── Guard clauses 1-8, checked again (round c10, 2026-10-31) ──────────────
    // Each plant is written the way its clause describes it. CAUGHT: the
    // helper of 06df95532 already reported it; kept so it stays caught.
    // MISSED: the helper of 06df95532 reported nothing for it.
    const C10_READ = `
                const { data } = await admin
                  .from('maintenance_requests')
                  .select('id, requester_user_id, requester_email_snapshot')
                  .eq('id', id)
                  .maybeSingle();`;
    const C10_NOTICES: Source = {
      file: 'apps/web/src/server/services/plant-c10-notices.ts',
      text: `
              export class NoticeService {
                static async notifyStatic(to: string) {
                  await sendEmail({ to, subject: 'Reopened', html: '' });
                }
                async notify(to: string) {
                  await sendEmail({ to, subject: 'Reopened', html: '' });
                }
              }
              export function makeNoticeService() {
                return new NoticeService();
              }
              export const notices = {
                reopened: async (to: string) => {
                  await sendEmail({ to, subject: 'Reopened', html: '' });
                },
              };`,
    };
    const C10_REMINDERS: Source = {
      file: 'apps/web/src/server/jobs/plant-c10-reminders.ts',
      text: `
              export async function queueReminder(job: unknown) {
                void job;
              }`,
    };
    const C10: Record<string, Source[]> = {
      'c1 caught': [
        {
          file: 'apps/web/src/server/email/plant-c10-c1-caught.ts',
          text: `
              import * as orderEmails from '@/lib/email/order-requests';
              import { sendRentalOverdueEmail as remindBorrower } from '@/lib/email/rentals';
              import { recordReopen } from '@/server/services/plant-c10-audit';
              export async function viaNamespace(admin: Admin, id: string) {${C10_READ}
                await orderEmails.sendOrderRequestEmail(data!.requester_email_snapshot! as never);
              }
              export async function viaAlias(admin: Admin, id: string) {${C10_READ}
                await remindBorrower(data!.requester_email_snapshot! as never);
              }
              export async function handOffRow(admin: Admin, id: string) {${C10_READ}
                await recordReopen(data);
              }`,
        },
        {
          file: 'apps/web/src/server/services/plant-c10-audit.ts',
          text: `
              export async function recordReopen(row: unknown) {
                void row;
              }`,
        },
      ],
      'c1 missed': [
        {
          file: 'apps/web/src/server/email/plant-c10-c1-missed.ts',
          text: `
              import { sendEmail } from '@/lib/email/resend';
              export async function viaDynamicImport(admin: Admin, id: string) {${C10_READ}
                const { sendOrderRequestEmail } = await import('@/lib/email/order-requests');
                await sendOrderRequestEmail(data!.requester_email_snapshot! as never);
              }
              export async function viaDynamicNamespace(admin: Admin, id: string) {${C10_READ}
                const orderEmails = await import('@/lib/email/order-requests');
                await orderEmails.sendOrderRequestEmail(data!.requester_email_snapshot! as never);
              }
              export async function viaEmails(admin: Admin, resend: Resend, id: string) {${C10_READ}
                const { emails } = resend;
                await emails.send({ to: [data!.requester_email_snapshot!], subject: 'Reopened', html: '' });
              }
              export async function viaElements(admin: Admin, resend: Resend, id: string) {${C10_READ}
                await resend['emails'].send({ to: [data!.requester_email_snapshot!], subject: 'Reopened', html: '' });
                await resend.emails['send']({ to: [data!.requester_email_snapshot!], subject: 'Again', html: '' });
              }
              export async function viaVariable(admin: Admin, id: string) {${C10_READ}
                const send = sendEmail;
                await send({ to: [data!.requester_email_snapshot!], subject: 'Reopened', html: '' });
              }`,
        },
      ],
      'c1 missed 2': [
        {
          file: 'apps/web/src/server/email/plant-c10-c1-more.ts',
          text: `
              export async function viaInlineImport(admin: Admin, id: string) {${C10_READ}
                await (await import('@/lib/email/order-requests')).sendOrderRequestEmail(data!.requester_email_snapshot! as never);
              }
              export async function viaSendEmailElement(admin: Admin, mailer: Mailer, id: string) {${C10_READ}
                await mailer['sendEmail']({ to: [data!.requester_email_snapshot!], subject: 'Reopened', html: '' });
              }
              export async function viaAliasSeenThroughImport(input: { requesterEmail: string }) {
                const { MaintenanceRequestsService } = await import('@/server/services/maintenance-requests');
                void MaintenanceRequestsService;
                await sendEmail({ to: input.requesterEmail, subject: 'Follow-up', html: '' });
              }`,
        },
      ],
      'c1 control': [
        {
          file: 'apps/web/src/server/email/plant-c10-c1-control.ts',
          text: `
              export async function asksThroughDynamicImport(admin: Admin, id: string) {${C10_READ}
                const { maintenanceRequesterAccountDeleted } = await import('@/server/lib/kept-address');
                if (!data || maintenanceRequesterAccountDeleted(data)) return;
                const { sendOrderRequestEmail } = await import('@/lib/email/order-requests');
                await sendOrderRequestEmail(data.requester_email_snapshot as never);
              }`,
        },
      ],
      'c2 caught': [
        {
          file: 'apps/web/src/server/services/plant-c10-c2-caught.ts',
          text: `
              export async function purge(admin: Admin, id: string) {
                const { data } = await admin.from('support_tickets').delete().eq('id', id).select('email').single();
                await sendEmail({ to: data.email, subject: 'Removed', html: '' });
              }
              export async function refile(admin: Admin, row: Row) {
                const { data } = await admin.from('support_tickets').upsert(row).select('email').single();
                await sendEmail({ to: data.email, subject: 'Refiled', html: '' });
              }
              export async function file(admin: Admin, row: Row) {
                const { data } = await admin.from('support_tickets').insert(row).select('id, email').single();
                await sendEmail({ to: data.email, subject: 'Filed', html: '' });
              }
              export async function remind(admin: Admin, table: string, id: string) {
                const { data } = await admin.from(table).select('email').eq('id', id).single();
                await sendEmail({ to: data.email, subject: 'Still open', html: '' });
              }`,
        },
      ],
      'c2 missed': [
        {
          file: 'apps/web/src/server/services/plant-c10-ticket-loader.ts',
          text: `
              import { SUPPORT_TABLE } from '@/server/services/plant-tables';
              export async function loadTicket(admin: Admin, id: string) {
                const { data } = await admin.from(SUPPORT_TABLE).select('*').eq('id', id).single();
                return data;
              }`,
        },
        {
          file: 'apps/web/src/server/jobs/plant-c10-ticket-remind.ts',
          text: `
              import { loadTicket } from '@/server/services/plant-c10-ticket-loader';
              export async function remind(admin: Admin, id: string) {
                const t = await loadTicket(admin, id);
                await sendEmail({ to: t.email, subject: 'Still open?', html: '' });
              }`,
        },
      ],
      'c3 missed': [
        {
          file: 'apps/web/src/server/actions/plant-c10-c3-wrapped.ts',
          text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';
              export const resolvedAction = withAuth(async (admin: Admin, id: string) => {${C10_READ}
                if (!data || maintenanceRequesterAccountDeleted(data)) return;
                await sendEmail({ to: data.requester_email_snapshot, subject: 'Resolved', html: '' });
              });
              export const reopenedAction = withAuth(async (admin: Admin, id: string) => {${C10_READ}
                await sendEmail({ to: data?.requester_email_snapshot, subject: 'Reopened', html: '' });
              });`,
        },
        {
          file: 'apps/web/src/server/email/plant-c10-c3-callbacks.ts',
          text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';
              export async function sendBoth(admin: Admin, ids: string[]) {
                await Promise.all(
                  ids.map(async (id) => {${C10_READ}
                    if (!data || maintenanceRequesterAccountDeleted(data)) return;
                    await sendEmail({ to: data.requester_email_snapshot, subject: 'Resolved', html: '' });
                  }),
                );
                await Promise.all(
                  ids.map(async (id) => {${C10_READ}
                    await sendEmail({ to: data?.requester_email_snapshot, subject: 'Reopened', html: '' });
                  }),
                );
              }
              export async function sendFiltered(admin: Admin, rows: Array<{ requester_user_id: string | null; requester_email_snapshot: string | null }>) {
                const live = rows.filter((r) => !maintenanceRequesterAccountDeleted(r));
                for (const r of live) await sendEmail({ to: r.requester_email_snapshot, subject: 'Resolved', html: '' });
              }`,
        },
      ],
      'c3 control': [
        {
          file: 'apps/web/src/server/email/plant-c10-c3-control.ts',
          text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';
              export async function sendLater(admin: Admin, id: string) {${C10_READ}
                if (!data || maintenanceRequesterAccountDeleted(data)) return;
                keepAlive(
                  (async () => {
                    await sendEmail({ to: data.requester_email_snapshot, subject: 'Resolved', html: '' });
                  })(),
                );
              }
              export async function sendEach(admin: Admin, rows: Array<{ requester_user_id: string | null; requester_email_snapshot: string | null }>) {
                for (const r of rows) {
                  if (maintenanceRequesterAccountDeleted(r)) continue;
                  await sendEmail({ to: r.requester_email_snapshot, subject: 'Resolved', html: '' });
                }
              }`,
        },
      ],
      'c3 missed 2': [
        {
          file: 'apps/web/src/server/email/plant-c10-c3-helper.ts',
          text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';
              export async function remindBoth(admin: Admin, ids: string[]) {
                await Promise.all(
                  ids.map(async (id) => {${C10_READ}
                    if (!data || maintenanceRequesterAccountDeleted(data)) return;
                    await tell(data.requester_email_snapshot);
                  }),
                );
                await Promise.all(
                  ids.map(async (id) => {${C10_READ}
                    await tell(data?.requester_email_snapshot ?? null);
                  }),
                );
              }
              async function tell(to: string | null) {
                await sendEmail({ to, subject: 'Reminder', html: '' });
              }`,
        },
      ],
      'c3 missed 3': [
        {
          file: 'apps/web/src/server/email/plant-c10-c3-filtered.ts',
          text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';
              type Row = { requester_user_id: string | null; requester_email_snapshot: string | null };
              export async function sendResolvedTo(rows: Row[]) {
                const live = rows.filter((r) => !maintenanceRequesterAccountDeleted(r));
                for (const r of rows) await sendEmail({ to: r.requester_email_snapshot, subject: 'Resolved', html: '' });
                return live.length;
              }`,
        },
        {
          file: 'apps/web/src/server/jobs/plant-c10-c3-caller.ts',
          text: `
              import { sendResolvedTo } from '@/server/email/plant-c10-c3-filtered';
              export async function resolveOne(admin: Admin, id: string) {${C10_READ}
                if (data) await sendResolvedTo([data]);
              }`,
        },
      ],
      'c4 read by return': [
        {
          file: 'apps/web/src/server/email/plant-c10-follow-up.ts',
          text: `
              export async function sendFollowUp(detail: { requesterEmail: string | null }) {
                await sendEmail({ to: detail.requesterEmail ?? '', subject: 'Follow-up', html: '' });
              }`,
        },
        {
          file: 'apps/web/src/server/services/plant-c10-c4-detail.ts',
          text: `
              import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';
              import { sendFollowUp } from '@/server/email/plant-c10-follow-up';
              export async function followUp(id: string) {
                const svc = await MaintenanceRequestsService.forCurrentUser();
                const detail = await svc.get(id);
                await sendFollowUp(detail);
              }`,
        },
      ],
      'c4 missed': [
        C10_REMINDERS,
        {
          file: 'apps/web/src/server/services/plant-c10-c4-assign.ts',
          text: `
              import { queueReminder } from '@/server/jobs/plant-c10-reminders';
              export async function reopen(admin: Admin, id: string) {${C10_READ}
                const payload: { recipient?: string | null } = {};
                payload.recipient = data?.requester_email_snapshot ?? null;
                await queueReminder(payload);
              }
              export class ReopenJob {
                recipient: string | null = null;
                async load(admin: Admin, id: string) {${C10_READ}
                  this.recipient = data?.requester_email_snapshot ?? null;
                }
              }
              export async function viaCompound(admin: Admin, id: string) {${C10_READ}
                let to: string | null = null;
                to ??= data?.requester_email_snapshot ?? null;
                await queueReminder(to);
              }
              export async function viaAssign(admin: Admin, id: string) {${C10_READ}
                const copy = {};
                Object.assign(copy, data);
                await queueReminder(copy);
              }`,
        },
      ],
      'c4 missed 2': [
        {
          file: 'apps/web/src/server/services/plant-c10-c4-key.ts',
          text: `
              export async function viaAssignedKey(admin: Admin, id: string, field: string) {${C10_READ}
                const payload: Record<string, string | null> = {};
                payload[field] = data?.requester_email_snapshot ?? null;
                await queueNotice(payload);
              }
              async function queueNotice(payload: Record<string, string | null>) {
                void payload;
              }`,
        },
      ],
      'c5 caught': [
        {
          file: 'apps/web/src/server/email/plant-c10-c5-static.ts',
          text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';
              export class Notice {
                static async send(admin: Admin, id: string) {${C10_READ}
                  if (!data || maintenanceRequesterAccountDeleted(data)) return;
                  await sendEmail({ to: data.requester_email_snapshot, subject: 'Resolved', html: '' });
                }
                async send(admin: Admin, id: string) {${C10_READ}
                  await sendEmail({ to: data?.requester_email_snapshot, subject: 'Reopened', html: '' });
                }
              }`,
        },
        {
          file: 'apps/web/src/server/email/plant-c10-c5-classes.ts',
          text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';
              register(
                class {
                  async send(admin: Admin, id: string) {${C10_READ}
                    if (!data || maintenanceRequesterAccountDeleted(data)) return;
                    await sendEmail({ to: data.requester_email_snapshot, subject: 'Resolved', html: '' });
                  }
                },
              );
              register(
                class {
                  async send(admin: Admin, id: string) {${C10_READ}
                    await sendEmail({ to: data?.requester_email_snapshot, subject: 'Reopened', html: '' });
                  }
                },
              );`,
        },
        {
          file: 'apps/web/src/server/email/plant-c10-c5-overload.ts',
          text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';
              export async function notify(admin: Admin, id: string): Promise<void>;
              export async function notify(admin: Admin, id: number): Promise<void>;
              export async function notify(admin: Admin, id: string | number) {${C10_READ}
                await sendEmail({ to: data?.requester_email_snapshot, subject: 'Reopened', html: '' });
              }
              export async function notifyResolved(admin: Admin, id: string) {${C10_READ}
                if (!data || maintenanceRequesterAccountDeleted(data)) return;
                await sendEmail({ to: data.requester_email_snapshot, subject: 'Resolved', html: '' });
              }`,
        },
      ],
      'c5 missed': [
        {
          file: 'apps/web/src/server/email/plant-c10-c5-objects.ts',
          text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';
              export const resolvedHandlers = register({
                async deliver(admin: Admin, id: string) {${C10_READ}
                  if (!data || maintenanceRequesterAccountDeleted(data)) return;
                  await sendEmail({ to: data.requester_email_snapshot, subject: 'Resolved', html: '' });
                },
              });
              export const reopenedHandlers = register({
                async deliver(admin: Admin, id: string) {${C10_READ}
                  await sendEmail({ to: data?.requester_email_snapshot, subject: 'Reopened', html: '' });
                },
              });`,
        },
      ],
      'c6 caught': [
        {
          file: 'apps/web/src/server/services/plant-c10-c6-caught.ts',
          text: `
              export async function reopen(admin: Admin, id: string) {${C10_READ}
                const { requester_email_snapshot } = data!;
                await queueNotice({ recipient: requester_email_snapshot });
                await enqueue({ to: data?.requester_email_snapshot ?? null });
                return new Notice({ to: data?.requester_email_snapshot ?? null });
              }
              async function queueNotice(payload: { recipient: string | null }) {
                void payload;
              }
              async function enqueue(job: { to: string | null }) {
                void job;
              }
              class Notice {
                constructor(readonly options: { to: string | null }) {}
              }`,
        },
      ],
      'c6 missed': [
        {
          file: 'apps/web/src/server/services/plant-c10-c6-missed.ts',
          text: `
              export async function viaFetch(admin: Admin, id: string) {${C10_READ}
                await fetch('https://hooks.example.com/notify', {
                  method: 'POST',
                  body: data?.requester_email_snapshot ?? '',
                });
              }
              export async function viaComputedKey(admin: Admin, id: string, field: string) {${C10_READ}
                await queueNotice({ [field]: data?.requester_email_snapshot ?? null });
              }
              async function queueNotice(payload: Record<string, string | null>) {
                void payload;
              }`,
        },
      ],
      'c7 caught': [
        {
          file: 'apps/web/src/server/services/plant-c10-c7-caught.ts',
          text: `
              export async function remind(supabase: Admin, id: string) {
                let q = supabase.from('support_tickets');
                q = q.select('requester_email_snapshot');
                const { data } = await q.eq('id', id).single();
                await sendEmail({ to: data.email, subject: 'Still open', html: '' });
              }`,
        },
      ],
      'c7 missed': [
        {
          file: 'apps/web/src/server/services/plant-c10-untraced-loader.ts',
          text: `
              function ticketsOf(admin: Admin) {
                return admin.from('support_tickets');
              }
              export async function loadTicket(admin: Admin, id: string) {
                const { data } = await ticketsOf(admin).select('*').eq('id', id).single();
                return data;
              }`,
        },
        {
          file: 'apps/web/src/server/jobs/plant-c10-untraced-remind.ts',
          text: `
              import { loadTicket } from '@/server/services/plant-c10-untraced-loader';
              export async function remind(admin: Admin, id: string) {
                const t = await loadTicket(admin, id);
                await sendEmail({ to: t.email, subject: 'Still open?', html: '' });
              }`,
        },
        {
          file: 'apps/web/src/server/services/plant-c10-run-query.ts',
          text: `
              export async function run(q: Query) {
                const { data } = await q.select('*');
                return data ?? [];
              }`,
        },
        {
          file: 'apps/web/src/server/jobs/plant-c10-run-remind.ts',
          text: `
              import { run } from '@/server/services/plant-c10-run-query';
              export async function remindAll(admin: Admin) {
                const rows = await run(admin.from('support_tickets'));
                for (const r of rows) await sendEmail({ to: r.email, subject: 'Still open?', html: '' });
              }`,
        },
      ],
      'c7 control': [
        {
          file: 'apps/web/src/server/services/plant-c10-c7-control.ts',
          text: `
              export async function history(admin: Admin, itemId: string) {
                const orders = await fetchAllRows((from: number, to: number) => {
                  const q = admin.from('purchase_order_items').select('id, unit_cost').eq('item_id', itemId);
                  return q.range(from, to);
                });
                const receipts = await fetchAllRows((from: number, to: number) => {
                  const q = admin.from('receipt_lines').select('id, unit_cost').eq('item_id', itemId);
                  return q.range(from, to);
                });
                return [...orders, ...receipts].length;
              }`,
        },
      ],
      'c8 caught': [
        C10_NOTICES,
        {
          file: 'apps/web/src/server/services/plant-c10-default-class.ts',
          text: `
              export default class Notice {
                async notify(to: string) {
                  await sendEmail({ to, subject: 'Reopened', html: '' });
                }
              }`,
        },
        {
          file: 'apps/web/src/server/services/plant-c10-notice-barrel.ts',
          text: `
              export { NoticeService as Notices } from '@/server/services/plant-c10-notices';
              export * from '@/server/services/plant-c10-notices';`,
        },
        {
          file: 'apps/web/src/server/services/plant-c10-instance-export.ts',
          text: `
              import { NoticeService } from '@/server/services/plant-c10-notices';
              export const sharedNotices = new NoticeService();`,
        },
        {
          file: 'apps/web/src/server/services/plant-c10-two-notify.ts',
          text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';
              export async function notify(to: string, row: { requester_user_id: string | null }) {
                if (maintenanceRequesterAccountDeleted(row)) return;
                await sendEmail({ to, subject: 'Reopened', html: '' });
              }
              export class LoudNotice {
                async notify(to: string) {
                  await sendEmail({ to, subject: 'Reopened', html: '' });
                }
              }`,
        },
        {
          file: 'apps/web/src/server/services/plant-c10-c8-caught.ts',
          text: `
              import Notice from '@/server/services/plant-c10-default-class';
              import { Notices, notices } from '@/server/services/plant-c10-notice-barrel';
              import { sharedNotices } from '@/server/services/plant-c10-instance-export';
              import { LoudNotice } from '@/server/services/plant-c10-two-notify';
              export async function viaDefault(admin: Admin, id: string) {${C10_READ}
                await new Notice().notify(data!.requester_email_snapshot!);
              }
              export async function viaRenamed(admin: Admin, id: string) {${C10_READ}
                await new Notices().notify(data!.requester_email_snapshot!);
              }
              export async function viaStatic(admin: Admin, id: string) {${C10_READ}
                await Notices.notifyStatic(data!.requester_email_snapshot!);
              }
              export async function viaObject(admin: Admin, id: string) {${C10_READ}
                await notices.reopened(data!.requester_email_snapshot!);
              }
              export async function viaInstance(admin: Admin, id: string) {${C10_READ}
                await sharedNotices.notify(data!.requester_email_snapshot!);
              }
              export async function viaClassMethod(admin: Admin, id: string) {${C10_READ}
                await new LoudNotice().notify(data!.requester_email_snapshot!);
              }`,
        },
      ],
      'c8 missed': [
        C10_NOTICES,
        {
          file: 'apps/web/src/server/services/plant-c10-c8-missed.ts',
          text: `
              import type { NoticeService } from '@/server/services/plant-c10-notices';
              import { makeNoticeService, NoticeService as Notices, notices } from '@/server/services/plant-c10-notices';
              export async function viaParameter(admin: Admin, svc: NoticeService, id: string) {${C10_READ}
                await svc.notify(data!.requester_email_snapshot!);
              }
              export class ReopenFlow {
                constructor(private readonly mailer: NoticeService) {}
                async reopen(admin: Admin, id: string) {${C10_READ}
                  await this.mailer.notify(data!.requester_email_snapshot!);
                }
              }
              export async function viaFactory(admin: Admin, id: string) {${C10_READ}
                const svc = makeNoticeService();
                await svc.notify(data!.requester_email_snapshot!);
              }
              export async function viaDestructured(admin: Admin, id: string) {${C10_READ}
                const { reopened } = notices;
                await reopened(data!.requester_email_snapshot!);
              }
              export async function viaCopy(admin: Admin, id: string) {${C10_READ}
                const svc = new Notices();
                const mailer = svc;
                await mailer.notify(data!.requester_email_snapshot!);
              }
              export async function viaCallback(admin: Admin, id: string, notify: (to: string) => Promise<void>) {${C10_READ}
                await notify(data!.requester_email_snapshot!);
              }`,
        },
        {
          file: 'apps/web/src/server/services/plant-c10-open-tickets.ts',
          text: `
              export async function loadOpen(admin: Admin) {
                const out: unknown[] = [];
                const { data } = await admin.from('support_tickets').select('*').eq('status', 'open');
                for (const t of data ?? []) out.push(t);
                return out;
              }`,
        },
        {
          file: 'apps/web/src/server/jobs/plant-c10-open-remind.ts',
          text: `
              import { loadOpen } from '@/server/services/plant-c10-open-tickets';
              export async function remindOpen(admin: Admin) {
                for (const t of await loadOpen(admin)) await sendEmail({ to: t.email, subject: 'Still open?', html: '' });
              }`,
        },
      ],
      'c8 missed 2': [
        C10_NOTICES,
        C10_REMINDERS,
        {
          file: 'apps/web/src/server/services/plant-c10-c8-more.ts',
          text: `
              import { makeNoticeService } from '@/server/services/plant-c10-notices';
              import { queueReminder } from '@/server/jobs/plant-c10-reminders';
              class Reminder {
                constructor(readonly row: unknown) {}
              }
              export async function viaInstanceOfRow(admin: Admin, id: string) {${C10_READ}
                await queueReminder(new Reminder(data));
              }
              export async function viaFactoryOfRow(admin: Admin, id: string) {${C10_READ}
                const svc = makeNoticeService(data);
                await svc.notify(data!.requester_email_snapshot!);
              }`,
        },
      ],
      'c8 missed 3': [
        {
          file: 'apps/web/src/server/services/plant-c10-c8-stores.ts',
          text: `
              const outbox: unknown[] = [];
              export async function viaModuleArray(admin: Admin, id: string) {${C10_READ}
                outbox.push(data);
              }
              export class Holder {
                row: unknown = null;
                async keep(admin: Admin, id: string) {${C10_READ}
                  this.row = data;
                }
              }
              export async function viaParameterObject(admin: Admin, id: string, into: { row?: unknown }) {${C10_READ}
                into.row = data;
              }
              export async function viaLocalArray(admin: Admin, id: string) {${C10_READ}
                const rows: unknown[] = [];
                rows.push(data);
                return rows.length;
              }`,
        },
      ],
      'c8 control': [
        {
          file: 'apps/web/src/server/services/plant-c10-c8-control.ts',
          text: `
              export async function lookupKey(admin: Admin, id: string) {${C10_READ}
                const key = encodeURIComponent(String(data?.requester_email_snapshot ?? ''));
                const copy = JSON.stringify({ at: Date.now() });
                return key.length + copy.length;
              }`,
        },
      ],
    };
    const ASK_M =
      ' without asking maintenanceRequesterAccountDeleted() in server/lib/kept-address.ts';
    const ASK_S =
      ' without asking supportTicketSubmitterAccountDeleted() in server/lib/kept-address.ts';
    const HAND_OFF_M = `${ASK_M}: ask first, or check the hand-off by hand and list it in REVIEWED_HANDOFFS`;
    const ESCAPE_M =
      ', which outlives the function, and the scan does not follow it there: keep the row in a ' +
      'variable of the function, or ask maintenanceRequesterAccountDeleted() first, or check it ' +
      'by hand and list it in REVIEWED_HANDOFFS';
    const DYNAMIC = ': check it reads no kept address and list it in REVIEWED_DYNAMIC_READS';
    const REGISTER = ': register the alias in KEPT_ADDRESSES so its readers are checked';

    it(
      '(c1) caught at 06df95532: a lib/email sender through a namespace import and under another name, and a row handed to a helper in another file',
      () => {
        expect(withPlanted(C10['c1 caught']!)).toEqual([
          `apps/web/src/server/email/plant-c10-c1-caught.ts:11 viaNamespace() reads maintenance_requests.requester_email_snapshot and sends email through sendOrderRequestEmail()${ASK_M}`,
          `apps/web/src/server/email/plant-c10-c1-caught.ts:19 viaAlias() reads maintenance_requests.requester_email_snapshot and sends email through remindBorrower()${ASK_M}`,
          `apps/web/src/server/email/plant-c10-c1-caught.ts:27 handOffRow() hands maintenance_requests.requester_email_snapshot to recordReopen() (@/server/services/plant-c10-audit)${HAND_OFF_M}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c1) missed at 06df95532: a lib/email sender through a dynamic import, emails.send off a destructured emails or by element access, and sendEmail kept in a variable',
      () => {
        expect(withPlanted(C10['c1 missed']!)).toEqual([
          `apps/web/src/server/email/plant-c10-c1-missed.ts:10 viaDynamicImport() reads maintenance_requests.requester_email_snapshot and sends email through sendOrderRequestEmail()${ASK_M}`,
          `apps/web/src/server/email/plant-c10-c1-missed.ts:19 viaDynamicNamespace() reads maintenance_requests.requester_email_snapshot and sends email through sendOrderRequestEmail()${ASK_M}`,
          `apps/web/src/server/email/plant-c10-c1-missed.ts:28 viaEmails() reads maintenance_requests.requester_email_snapshot and sends email (.emails.send)${ASK_M}`,
          `apps/web/src/server/email/plant-c10-c1-missed.ts:36 viaElements() reads maintenance_requests.requester_email_snapshot and sends email (.emails.send)${ASK_M}`,
          `apps/web/src/server/email/plant-c10-c1-missed.ts:37 viaElements() reads maintenance_requests.requester_email_snapshot and sends email (.emails.send)${ASK_M}`,
          `apps/web/src/server/email/plant-c10-c1-missed.ts:46 viaVariable() hands maintenance_requests.requester_email_snapshot to send()${CANNOT_PLACE_M}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c1) missed at 06df95532: a lib/email sender through (await import(…)).f(), sendEmail by element access, and an alias seen through a dynamic import',
      () => {
        expect(withPlanted(C10['c1 missed 2']!)).toEqual([
          `apps/web/src/server/email/plant-c10-c1-more.ts:8 viaInlineImport() reads maintenance_requests.requester_email_snapshot and sends email through sendOrderRequestEmail()${ASK_M}`,
          `apps/web/src/server/email/plant-c10-c1-more.ts:16 viaSendEmailElement() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail)${ASK_M}`,
          `apps/web/src/server/email/plant-c10-c1-more.ts:21 viaAliasSeenThroughImport() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail)${ASK_M}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c1) the answer and the sender, both through a dynamic import, are followed',
      () => {
        expect(withPlanted(C10['c1 control']!)).toEqual([]);
      },
      TIMEOUT,
    );

    it(
      '(c2) caught at 06df95532: support selects after delete(), upsert() and insert(), and .from() of a parameter',
      () => {
        expect(withPlanted(C10['c2 caught']!)).toEqual([
          `apps/web/src/server/services/plant-c10-c2-caught.ts:4 purge() reads support_tickets.email and sends email (sendEmail)${ASK_S}`,
          `apps/web/src/server/services/plant-c10-c2-caught.ts:8 refile() reads support_tickets.email and sends email (sendEmail)${ASK_S}`,
          `apps/web/src/server/services/plant-c10-c2-caught.ts:12 file() reads support_tickets.email and sends email (sendEmail)${ASK_S}`,
          `apps/web/src/server/services/plant-c10-c2-caught.ts:15 remind() selects through .from(table), a table the scan cannot read${DYNAMIC}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c2) missed at 06df95532: .from() of a table constant in a loader that sends nothing, its rows emailed from another file',
      () => {
        expect(withPlanted(C10['c2 missed']!)).toEqual([
          `apps/web/src/server/services/plant-c10-ticket-loader.ts:4 loadTicket() selects through .from(SUPPORT_TABLE), a table the scan cannot read${DYNAMIC}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c3) missed at 06df95532: an answer in one function of a unit covered a send in another (two wrapped handlers, two callbacks, an answer only in a filter callback)',
      () => {
        expect(withPlanted(C10['c3 missed']!)).toEqual([
          `apps/web/src/server/actions/plant-c10-c3-wrapped.ts:18 its top level reads maintenance_requests.requester_email_snapshot and sends email (sendEmail)${ASK_M}`,
          `apps/web/src/server/email/plant-c10-c3-callbacks.ts:22 sendBoth() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail)${ASK_M}`,
          `apps/web/src/server/email/plant-c10-c3-callbacks.ts:28 sendFiltered() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail)${ASK_M}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c3) missed at 06df95532: an answer in one callback let the other hand the address to a local helper that sends',
      () => {
        expect(withPlanted(C10['c3 missed 2']!)).toEqual([
          `apps/web/src/server/email/plant-c10-c3-helper.ts:22 remindBoth() reads maintenance_requests.requester_email_snapshot and sends email through tell()${ASK_M}`,
          `apps/web/src/server/email/plant-c10-c3-helper.ts:27 tell() is handed maintenance_requests.requester_email_snapshot by remindBoth() and sends email (sendEmail)${ASK_M}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c3) missed at 06df95532: a sender in another file that asks only in a filter callback counted as asking first',
      () => {
        expect(withPlanted(C10['c3 missed 3']!)).toEqual([
          `apps/web/src/server/email/plant-c10-c3-filtered.ts:6 sendResolvedTo() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail)${ASK_M}`,
          `apps/web/src/server/jobs/plant-c10-c3-caller.ts:9 resolveOne() reads maintenance_requests.requester_email_snapshot and sends email through sendResolvedTo()${ASK_M}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c3) an answer guards a send in a callback inside its function, and the send after it in a loop',
      () => {
        expect(withPlanted(C10['c3 control']!)).toEqual([]);
      },
      TIMEOUT,
    );

    it(
      '(c4) missed at 06df95532: an alias made by assigning a property or a class field, and the address carried through ??= and Object.assign',
      () => {
        expect(withPlanted(C10['c4 missed']!)).toEqual([
          `apps/web/src/server/services/plant-c10-c4-assign.ts:11 reopen() hands maintenance_requests.requester_email_snapshot to queueReminder() (@/server/jobs/plant-c10-reminders)${HAND_OFF_M}`,
          `apps/web/src/server/services/plant-c10-c4-assign.ts:32 viaCompound() hands maintenance_requests.requester_email_snapshot to queueReminder() (@/server/jobs/plant-c10-reminders)${HAND_OFF_M}`,
          `apps/web/src/server/services/plant-c10-c4-assign.ts:42 viaAssign() hands maintenance_requests.requester_email_snapshot to queueReminder() (@/server/jobs/plant-c10-reminders)${HAND_OFF_M}`,
          `apps/web/src/server/services/plant-c10-c4-assign.ts:10 reopen() puts maintenance_requests.requester_email_snapshot into recipient${REGISTER}`,
          `apps/web/src/server/services/plant-c10-c4-assign.ts:21 ReopenJob.load() puts maintenance_requests.requester_email_snapshot into recipient${REGISTER}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c4) missed at 06df95532: an address assigned under a key the scan cannot read',
      () => {
        expect(withPlanted(C10['c4 missed 2']!)).toEqual([
          'apps/web/src/server/services/plant-c10-c4-key.ts:9 viaAssignedKey() puts maintenance_requests.requester_email_snapshot under payload[field], a key the scan cannot read: use a fixed key and register it in KEPT_ADDRESSES',
        ]);
      },
      TIMEOUT,
    );

    it(
      '(read by return, integrator decision 2026-10-31) missed at 06df95532: a maintenance detail handed whole to a sender that cannot see the alias',
      () => {
        expect(withPlanted(C10['c4 read by return']!)).toEqual([
          `apps/web/src/server/services/plant-c10-c4-detail.ts:7 followUp() gets maintenance_requests.requester_email_snapshot from get() and sends email through sendFollowUp()${ASK_M}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c5) caught at 06df95532: a static and an instance method of one name, two class expressions, and an overload',
      () => {
        expect(withPlanted(C10['c5 caught']!)).toEqual([
          'apps/web/src/server/email/plant-c10-c5-static.ts:4,13 2 functions are all Notice.send(): the guard cannot tell their calls apart; rename one',
          'apps/web/src/server/email/plant-c10-c5-classes.ts:5,18 2 functions are all (class).send(): the guard cannot tell their calls apart; rename one',
          `apps/web/src/server/email/plant-c10-c5-static.ts:19 Notice.send#2() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail)${ASK_M}`,
          `apps/web/src/server/email/plant-c10-c5-classes.ts:24 (class).send#2() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail)${ASK_M}`,
          `apps/web/src/server/email/plant-c10-c5-overload.ts:11 notify() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail)${ASK_M}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c5) missed at 06df95532: methods of one name in two objects handed to a call',
      () => {
        expect(withPlanted(C10['c5 missed']!)).toEqual([
          `apps/web/src/server/email/plant-c10-c5-objects.ts:21 its top level reads maintenance_requests.requester_email_snapshot and sends email (sendEmail)${ASK_M}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c6) caught at 06df95532: { recipient } and { to } straight into calls and into new',
      () => {
        expect(withPlanted(C10['c6 caught']!)).toEqual([
          // (c11): the object holding the address, kept on `this` by a
          // constructor parameter property.
          `apps/web/src/server/services/plant-c10-c6-caught.ts:20 Notice.constructor() puts a row holding maintenance_requests.requester_email_snapshot into this.options${ESCAPE_M}`,
          `apps/web/src/server/services/plant-c10-c6-caught.ts:9 reopen() puts maintenance_requests.requester_email_snapshot into recipient${REGISTER}`,
          `apps/web/src/server/services/plant-c10-c6-caught.ts:10 reopen() puts maintenance_requests.requester_email_snapshot into to${REGISTER}`,
          `apps/web/src/server/services/plant-c10-c6-caught.ts:11 reopen() puts maintenance_requests.requester_email_snapshot into to${REGISTER}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c6) missed at 06df95532: any fetch silenced the address in its options, and a computed key hid it',
      () => {
        expect(withPlanted(C10['c6 missed']!)).toEqual([
          `apps/web/src/server/services/plant-c10-c6-missed.ts:8 viaFetch() hands maintenance_requests.requester_email_snapshot to fetch()${CANNOT_PLACE_M}`,
          `apps/web/src/server/services/plant-c10-c6-missed.ts:10 viaFetch() puts maintenance_requests.requester_email_snapshot into body${REGISTER}`,
          'apps/web/src/server/services/plant-c10-c6-missed.ts:19 viaComputedKey() puts maintenance_requests.requester_email_snapshot under [field], a key the scan cannot read: use a fixed key and register it in KEPT_ADDRESSES',
        ]);
      },
      TIMEOUT,
    );

    it(
      "(c7) caught at 06df95532: the clause's own query split across variables",
      () => {
        expect(withPlanted(C10['c7 caught']!)).toEqual([
          `apps/web/src/server/services/plant-c10-c7-caught.ts:6 remind() reads support_tickets.email and sends email (sendEmail)${ASK_S}`,
          `apps/web/src/server/services/plant-c10-c7-caught.ts:6 remind() reads maintenance_requests.requester_email_snapshot and sends email (sendEmail)${ASK_M}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c7) missed at 06df95532: a select the scan cannot trace to a .from(), in files that send nothing, whose rows another file emails',
      () => {
        expect(withPlanted(C10['c7 missed']!)).toEqual([
          `apps/web/src/server/services/plant-c10-untraced-loader.ts:6 loadTicket() selects through ticketsOf(admin), which the scan cannot trace to a .from()${DYNAMIC}`,
          `apps/web/src/server/services/plant-c10-run-query.ts:3 run() selects through q, which the scan cannot trace to a .from()${DYNAMIC}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c7) two query variables of one name in two callbacks of a unit keep their own tables',
      () => {
        expect(withPlanted(C10['c7 control']!)).toEqual([]);
      },
      TIMEOUT,
    );

    it(
      '(c8) caught at 06df95532: Class.method through a default export, a renamed re-export, a static member, an object, an exported instance, and beside a function of its name',
      () => {
        expect(withPlanted(C10['c8 caught']!)).toEqual([
          `apps/web/src/server/services/plant-c10-c8-caught.ts:12 viaDefault() reads maintenance_requests.requester_email_snapshot and sends email through notify()${ASK_M}`,
          `apps/web/src/server/services/plant-c10-c8-caught.ts:20 viaRenamed() reads maintenance_requests.requester_email_snapshot and sends email through notify()${ASK_M}`,
          `apps/web/src/server/services/plant-c10-c8-caught.ts:28 viaStatic() reads maintenance_requests.requester_email_snapshot and sends email through notifyStatic()${ASK_M}`,
          `apps/web/src/server/services/plant-c10-c8-caught.ts:36 viaObject() reads maintenance_requests.requester_email_snapshot and sends email through reopened()${ASK_M}`,
          `apps/web/src/server/services/plant-c10-c8-caught.ts:44 viaInstance() reads maintenance_requests.requester_email_snapshot and sends email through notify()${ASK_M}`,
          `apps/web/src/server/services/plant-c10-c8-caught.ts:52 viaClassMethod() reads maintenance_requests.requester_email_snapshot and sends email through notify()${ASK_M}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      "(c8) missed at 06df95532: a callee the scan cannot place fails (a typed parameter, an injected field, a factory's instance, a destructured method, a callback); a copied instance and rows kept in a local array are followed",
      () => {
        expect(withPlanted(C10['c8 missed']!)).toEqual([
          `apps/web/src/server/services/plant-c10-c8-missed.ts:10 viaParameter() hands maintenance_requests.requester_email_snapshot to svc.notify()${CANNOT_PLACE_M}`,
          `apps/web/src/server/services/plant-c10-c8-missed.ts:20 ReopenFlow.reopen() hands maintenance_requests.requester_email_snapshot to this.mailer.notify()${CANNOT_PLACE_M}`,
          `apps/web/src/server/services/plant-c10-c8-missed.ts:30 viaFactory() hands maintenance_requests.requester_email_snapshot to svc.notify()${CANNOT_PLACE_M}`,
          `apps/web/src/server/services/plant-c10-c8-missed.ts:39 viaDestructured() hands maintenance_requests.requester_email_snapshot to reopened()${CANNOT_PLACE_M}`,
          `apps/web/src/server/services/plant-c10-c8-missed.ts:49 viaCopy() reads maintenance_requests.requester_email_snapshot and sends email through notify()${ASK_M}`,
          `apps/web/src/server/services/plant-c10-c8-missed.ts:57 viaCallback() hands maintenance_requests.requester_email_snapshot to notify()${CANNOT_PLACE_M}`,
          `apps/web/src/server/jobs/plant-c10-open-remind.ts:4 remindOpen() gets support_tickets.email from loadOpen() and sends email (sendEmail)${ASK_S}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c8) missed at 06df95532: an instance built from a row and handed on, and a method of what a factory handed the row returns (06df95532 reported only the hand-off to the factory)',
      () => {
        expect(withPlanted(C10['c8 missed 2']!)).toEqual([
          // (c11): the row, kept on `this` by a constructor parameter property.
          `apps/web/src/server/services/plant-c10-c8-more.ts:5 Reminder.constructor() puts a row holding maintenance_requests.requester_email_snapshot into this.row${ESCAPE_M}`,
          `apps/web/src/server/services/plant-c10-c8-more.ts:13 viaInstanceOfRow() hands maintenance_requests.requester_email_snapshot to queueReminder() (@/server/jobs/plant-c10-reminders)${HAND_OFF_M}`,
          `apps/web/src/server/services/plant-c10-c8-more.ts:22 viaFactoryOfRow() hands maintenance_requests.requester_email_snapshot to svc.notify()${CANNOT_PLACE_M}`,
          `apps/web/src/server/services/plant-c10-c8-more.ts:21 viaFactoryOfRow() hands maintenance_requests.requester_email_snapshot to makeNoticeService() (@/server/services/plant-c10-notices)${HAND_OFF_M}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      "(c8) missed at 06df95532: a row stored where the scan does not follow it (a module's array, a class field, a parameter's object) fails; a function's own array stays quiet",
      () => {
        expect(withPlanted(C10['c8 missed 3']!)).toEqual([
          `apps/web/src/server/services/plant-c10-c8-stores.ts:9 viaModuleArray() hands maintenance_requests.requester_email_snapshot to outbox.push()${CANNOT_PLACE_M}`,
          `apps/web/src/server/services/plant-c10-c8-stores.ts:19 Holder.keep() puts a row holding maintenance_requests.requester_email_snapshot into this.row${ESCAPE_M}`,
          `apps/web/src/server/services/plant-c10-c8-stores.ts:28 viaParameterObject() puts a row holding maintenance_requests.requester_email_snapshot into into.row${ESCAPE_M}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c8) a global that only computes a value is no callee the scan must place',
      () => {
        expect(withPlanted(C10['c8 control']!)).toEqual([]);
      },
      TIMEOUT,
    );

    // ── Round c11 (2026-10-31): the security review of 784ab5775 and the
    // decisions review ───────────────────────────────────────────────────────
    // Each MISSED set reported nothing at 784ab5775 (the merge 425fe7cc6 has
    // the same scan); each control stays quiet.
    const C11_S_READ = `
                const { data } = await admin
                  .from('support_tickets')
                  .update({ status: 'resolved' })
                  .eq('id', id)
                  .select('email, subject, organization_id, submitted_by')
                  .single();`;
    const C11_OUTBOX: Source = {
      file: 'apps/web/src/server/jobs/plant-c11-outbox.ts',
      text: `
              export async function enqueueEmail(job: { to: string; template: string }) {
                await createAdminClient().from('email_outbox').insert(job);
              }`,
    };
    const RENTAL_ACTIONS = 'apps/web/src/server/actions/rentals.ts';
    const RENTAL_ROUTE = 'apps/web/src/app/api/v1/rentals/route.ts';
    /** A real file with a new rental sender appended. */
    const withRentalSender = (file: string, name: string): Source => ({
      file,
      text: `${readFileSync(path.join(REPO, file), 'utf8')}
export async function ${name}(rentalId: string) {
  const admin = createAdminClient();
  const { data } = await admin.from('rentals').select('id, borrower_email').eq('id', rentalId).maybeSingle();
  if (data?.borrower_email) await sendEmail({ to: data.borrower_email, subject: 'Reminder', html: '' });
}
`,
    });
    const C11: Record<string, Source[]> = {
      'closures missed': [
        C10_REMINDERS,
        {
          file: 'apps/web/src/server/email/plant-c11-closure-defer.ts',
          text: `
              import { defer } from '@/server/services/lib/defer';
              export async function resolveAndNotify(admin: Admin, id: string) {${C10_READ}
                const to = data?.requester_email_snapshot;
                if (!to) return;
                const notify = async () => {
                  await sendEmail({ to, subject: 'Your request is resolved', html: '' });
                };
                defer(notify);
              }`,
        },
        {
          file: 'apps/web/src/server/services/plant-c11-closure-after.ts',
          text: `
              import { after } from 'next/server';
              export async function resolveTicket(admin: Admin, id: string) {${C11_S_READ}
                const ticket = data;
                if (!ticket) return;
                async function notify() {
                  await sendEmail({ to: ticket!.email, subject: 'Resolved', html: '' });
                }
                after(notify);
              }`,
        },
        {
          file: 'apps/web/src/server/services/plant-c11-closure-handoff.ts',
          text: `
              import { queueReminder } from '@/server/jobs/plant-c10-reminders';
              export async function remindLater(admin: Admin, id: string) {${C10_READ}
                const to = data?.requester_email_snapshot ?? null;
                const queue = async () => {
                  await queueReminder(to);
                };
                return queue;
              }`,
        },
      ],
      'closures control': [
        {
          file: 'apps/web/src/server/email/plant-c11-closure-asks.ts',
          text: `
              import { maintenanceRequesterAccountDeleted } from '@/server/lib/kept-address';
              import { defer } from '@/server/services/lib/defer';
              export async function resolveAndNotify(admin: Admin, id: string) {${C10_READ}
                if (!data || maintenanceRequesterAccountDeleted(data)) return;
                const to = data.requester_email_snapshot;
                const notify = async () => {
                  await sendEmail({ to, subject: 'Your request is resolved', html: '' });
                };
                defer(notify);
              }`,
        },
        {
          // A closure that names the row only in its types reads nothing.
          file: 'apps/web/src/server/services/plant-c11-closure-type.ts',
          text: `
              export async function ticketMailer(admin: Admin, id: string) {
                const { data: ticket } = await admin.from('support_tickets').select('email, subject').eq('id', id).single();
                const subject = 'Ticket ' + id;
                async function notifyOps(extra: typeof ticket, field: keyof NonNullable<typeof ticket>) {
                  await sendEmail({ to: 'ops@example.com', subject, html: String(field) });
                }
                return notifyOps;
              }`,
        },
      ],
      'function values missed': [
        {
          file: 'apps/web/src/server/jobs/plant-c11-map-sender.ts',
          text: `
              async function remindSubmitter(t: { email: string; subject: string }) {
                await sendEmail({ to: t.email, subject: 'Still open: ' + t.subject, html: '' });
              }
              export async function remindOpen(admin: Admin) {
                const { data } = await admin.from('support_tickets').select('email, subject').eq('status', 'open');
                await Promise.all((data ?? []).map(remindSubmitter));
              }`,
        },
        {
          file: 'apps/web/src/server/email/plant-c11-reminder-mail.ts',
          text: `
              export async function sendReminder(to: string | null) {
                if (to) await sendEmail({ to, subject: 'Reminder', html: '' });
              }`,
        },
        {
          file: 'apps/web/src/server/jobs/plant-c11-map-import.ts',
          text: `
              import { sendReminder } from '@/server/email/plant-c11-reminder-mail';
              export async function remindOpenRequests(admin: Admin) {
                const { data } = await admin
                  .from('maintenance_requests')
                  .select('id, requester_user_id, requester_email_snapshot')
                  .eq('status', 'open');
                const recipients = (data ?? []).map((r) => r.requester_email_snapshot);
                await Promise.all(recipients.map(sendReminder));
              }`,
        },
        {
          file: 'apps/web/src/server/jobs/plant-c11-load-many.ts',
          text: `
              import { stringify } from 'csv-stringify/sync';
              async function loadTicket(admin: Admin, id: string) {
                const { data } = await admin.from('support_tickets').select('*').eq('id', id).single();
                return data;
              }
              export async function remindMany(admin: Admin, ids: string[]) {
                const tickets = await Promise.all(ids.map(loadTicket.bind(null, admin)));
                for (const t of tickets) await sendEmail({ to: t.email, subject: 'Still open?', html: '' });
              }
              export async function exportOpen(admin: Admin) {
                const { data } = await admin.from('support_tickets').select('email').eq('status', 'open');
                return (data ?? []).map(stringify);
              }`,
        },
      ],
      'receivers missed': [
        {
          file: 'apps/web/src/server/services/plant-c11-notice-ticket.ts',
          text: `
              class ResolvedNotice {
                constructor(private readonly ticket: { email: string; subject: string }) {}
                async send() {
                  await sendEmail({ to: this.ticket.email, subject: 'Resolved: ' + this.ticket.subject, html: '' });
                }
              }
              export async function resolveTicket(admin: Admin, id: string) {${C11_S_READ}
                const notice = data ? new ResolvedNotice(data) : null;
                await notice?.send();
              }`,
        },
        {
          file: 'apps/web/src/server/email/plant-c11-notice-to.ts',
          text: `
              class ResolvedNotice {
                constructor(private readonly to: string) {}
                async send() {
                  await sendEmail({ to: this.to, subject: 'Resolved', html: '' });
                }
              }
              export async function resolveRequest(admin: Admin, id: string) {${C10_READ}
                let notice: ResolvedNotice | null = null;
                if (data?.requester_email_snapshot) notice = new ResolvedNotice(data.requester_email_snapshot);
                await notice?.send();
              }`,
        },
        {
          file: 'apps/web/src/server/services/plant-c11-wrapped-row.ts',
          text: `
              function wrap(row: unknown) {
                return { row, send: async () => undefined };
              }
              export async function resolveRequest(admin: Admin, id: string) {${C10_READ}
                const notice = wrap(data);
                await notice.send();
              }`,
        },
      ],
      'iteration missed': [
        C11_OUTBOX,
        {
          file: 'apps/web/src/server/jobs/plant-c11-address-lists.ts',
          text: `
              import { enqueueEmail } from '@/server/jobs/plant-c11-outbox';
              export async function remindOpenRequests(admin: Admin) {
                const { data } = await admin
                  .from('maintenance_requests')
                  .select('id, requester_user_id, requester_email_snapshot')
                  .eq('status', 'open');
                const recipients = (data ?? []).map((r) => r.requester_email_snapshot);
                for (const to of recipients) {
                  if (to) await enqueueEmail({ to, template: 'maintenance-reminder' });
                }
              }
              export async function remindFirst(admin: Admin, ids: string[]) {
                const { data } = await admin
                  .from('maintenance_requests')
                  .select('id, requester_user_id, requester_email_snapshot')
                  .in('id', ids);
                const [to] = (data ?? []).map((r) => r.requester_email_snapshot).filter(Boolean);
                if (to) await enqueueEmail({ to, template: 'maintenance-reminder' });
              }`,
        },
        {
          file: 'apps/web/src/server/jobs/plant-c11-by-index.ts',
          text: `
              import { enqueueEmail } from '@/server/jobs/plant-c11-outbox';
              export async function remindFirstByIndex(admin: Admin) {
                const { data } = await admin
                  .from('maintenance_requests')
                  .select('id, requester_user_id, requester_email_snapshot')
                  .eq('status', 'open');
                const recipients = (data ?? []).map((r) => r.requester_email_snapshot);
                await enqueueEmail({ to: recipients[0] ?? '', template: 'maintenance-reminder' });
              }`,
        },
        {
          file: 'apps/web/src/server/jobs/plant-c11-then.ts',
          text: `
              import { listSupportTickets } from '@/server/services/support-tickets';
              import { enqueueEmail } from '@/server/jobs/plant-c11-outbox';
              export async function remindOpen() {
                await listSupportTickets({ status: 'open' }).then((tickets) =>
                  Promise.all(tickets.map((t) => enqueueEmail({ to: t.email, template: 'ticket-reminder' }))),
                );
              }`,
        },
        {
          file: 'apps/web/src/server/services/plant-c11-ticket-pages.ts',
          text: `
              export async function* openTickets(admin: Admin) {
                for (let from = 0; ; from += 100) {
                  const { data } = await admin
                    .from('support_tickets')
                    .select('id, email, subject')
                    .eq('status', 'open')
                    .range(from, from + 99);
                  if (!data || data.length === 0) return;
                  for (const t of data) yield t;
                }
              }`,
        },
        {
          file: 'apps/web/src/server/jobs/plant-c11-generator.ts',
          text: `
              import { openTickets } from '@/server/services/plant-c11-ticket-pages';
              export async function remindAll(admin: Admin) {
                for await (const t of openTickets(admin)) {
                  await sendEmail({ to: t.email, subject: 'Still open?', html: '' });
                }
              }`,
        },
      ],
      'select embeds missed': [
        C10_REMINDERS,
        {
          file: 'apps/web/src/server/jobs/plant-c11-org-tickets.ts',
          text: `
              import { queueReminder } from '@/server/jobs/plant-c10-reminders';
              export async function remindOrgTickets(admin: Admin, orgId: string) {
                const { data } = await admin.from('organizations').select('id, support_tickets (email, status)').eq('id', orgId).single();
                for (const t of data?.support_tickets ?? []) await sendEmail({ to: t.email, subject: 'Still open?', html: '' });
              }
              export async function queueMemberTickets(admin: Admin, userId: string) {
                const { data: profile } = await admin
                  .from('user_profiles')
                  .select('id, tickets:support_tickets!submitted_by(email, status)')
                  .eq('id', userId)
                  .single();
                for (const t of profile?.tickets ?? []) await queueReminder({ to: t.email });
              }
              export async function remindWithColumns(admin: Admin, orgId: string, columns: string) {
                const { data } = await admin.from('organizations').select(columns).eq('id', orgId).single();
                await sendEmail({ to: 'support@example.com', subject: 'Open tickets', html: JSON.stringify(data) });
              }
              export async function queueItemRequests(admin: Admin, itemId: string) {
                const { data } = await admin.from('inventory_items').select('id, maintenance_requests(*)').eq('id', itemId).single();
                await queueReminder(data);
              }`,
        },
      ],
      'select embeds control': [
        {
          file: 'apps/web/src/server/jobs/plant-c11-org-no-tickets.ts',
          text: `
              const ORG_COLUMNS = 'id, name';
              export async function notifyOrg(admin: Admin, orgId: string) {
                const { data } = await admin.from('organizations').select(\`\${ORG_COLUMNS}, slug\`).eq('id', orgId).single();
                await sendEmail({ to: 'support@example.com', subject: data?.name ?? '', html: '' });
              }`,
        },
      ],
      'select renames missed': [
        {
          file: 'apps/web/src/server/jobs/plant-c11-rename-queue.ts',
          text: `
              export async function queueReminder(job: { to: string | null }) {
                void job;
              }`,
        },
        {
          file: 'apps/web/src/server/services/plant-c11-rename.ts',
          text: `
              import { queueReminder } from '@/server/jobs/plant-c11-rename-queue';
              export async function remindRequester(admin: Admin, id: string) {
                const { data } = await admin
                  .from('maintenance_requests')
                  .select('id, contact:requester_email_snapshot')
                  .eq('id', id)
                  .maybeSingle();
                await queueReminder({ to: data?.contact ?? null });
              }
              export async function remindViaHook(admin: Admin, id: string) {
                const { data } = await admin
                  .from('maintenance_requests')
                  .select('id, contact:requester_email_snapshot::text')
                  .eq('id', id)
                  .maybeSingle();
                await fetch('https://hooks.example.com/notify', { method: 'POST', body: data?.contact ?? '' });
              }
              export async function remindSubmitter(admin: Admin, id: string) {
                const { data } = await admin.from('support_tickets').select('id, recipient:email').eq('id', id).single();
                await queueReminder({ to: data?.recipient ?? null });
              }`,
        },
      ],
      'select renames control': [
        {
          file: 'apps/web/src/server/services/plant-c11-rename-control.ts',
          text: `
              export async function listTitles(admin: Admin) {
                const { data } = await admin.from('maintenance_requests').select('id, label:subject');
                return (data ?? []).map((r) => r.label);
              }`,
        },
      ],
      'more carrying missed': [
        C10_REMINDERS,
        {
          file: 'apps/web/src/server/services/plant-c11-more.ts',
          text: `
              import { queueReminder } from '@/server/jobs/plant-c10-reminders';
              let lastTicket: { email: string } | null = null;
              export async function queueRest(admin: Admin, id: string) {${C10_READ}
                const { id: requestId, ...rest } = data ?? { id: '' };
                await queueReminder(rest);
                return requestId;
              }
              export async function remindViaThen(admin: Admin) {
                await admin.from('support_tickets').select('email').eq('status', 'open').then(({ data }) => queueReminder(data));
              }
              export async function remindEach(admin: Admin) {
                const { data } = await admin.from('support_tickets').select('email').eq('status', 'open');
                withEach(data ?? [], (t) => queueReminder({ to: t.email }));
              }
              function withEach<T>(rows: T[], fn: (row: T) => unknown) {
                return rows.length ? fn : null;
              }
              export async function loadLast(admin: Admin, id: string) {${C11_S_READ}
                lastTicket = data;
              }
              export async function remindLast() {
                if (lastTicket) await sendEmail({ to: lastTicket.email, subject: 'Still open?', html: '' });
              }`,
        },
      ],
      'shadowed function name': [
        C10_REMINDERS,
        {
          file: 'apps/web/src/server/services/plant-c11-shadow.ts',
          text: `
              import { queueReminder } from '@/server/jobs/plant-c10-reminders';
              function tickets() {
                return [];
              }
              export async function queueCopy(admin: Admin) {
                const { data: tickets } = await admin.from('support_tickets').select('email');
                const copy = structuredClone(tickets);
                await queueReminder(copy);
              }`,
        },
      ],
      'carrying control': [
        C10_REMINDERS,
        {
          file: 'apps/web/src/server/services/plant-c11-subjects.ts',
          text: `
              export const SUPPORT_SUBJECT = 'Support';`,
        },
        {
          file: 'apps/web/src/server/services/plant-c11-control.ts',
          text: `
              import { listSupportTickets } from '@/server/services/support-tickets';
              import { queueReminder } from '@/server/jobs/plant-c10-reminders';
              import { SUPPORT_SUBJECT } from '@/server/services/plant-c11-subjects';
              function isOpen(t: { status: string }) {
                return t.status === 'open';
              }
              function record(subject: string, rows: unknown[]) {
                return [subject, rows.length];
              }
              export async function countOpen(admin: Admin) {
                let q = admin.from('support_tickets').select('*');
                q = q.eq('status', 'open');
                const { data } = await q.limit(10);
                const subjects = (data ?? []).slice(0, 2).map((t) => t.subject);
                record(SUPPORT_SUBJECT, data ?? []);
                return [subjects.length, (data ?? []).filter(isOpen).length];
              }
              export async function reportFailure() {
                await listSupportTickets({ status: 'open' }).catch((e) => queueReminder({ error: String(e) }));
              }`,
        },
      ],
      'rental senders in listed files missed': [
        withRentalSender(RENTAL_ACTIONS, 'emailBorrowerAgainAction'),
        withRentalSender(RENTAL_ROUTE, 'emailBorrowerAgain'),
      ],
    };
    const ASK_S_FIX = ', or ask supportTicketSubmitterAccountDeleted() first';
    const ESCAPE_S =
      ', which outlives the function, and the scan does not follow it there: keep the row in a ' +
      `variable of the function${ASK_S_FIX}, or check it by hand and list it in REVIEWED_HANDOFFS`;
    const HAND_OFF_S = `${ASK_S}: ask first, or check the hand-off by hand and list it in REVIEWED_HANDOFFS`;

    it(
      '(c11) missed at 784ab5775: a named closure that captures the address, handed to defer(), after() or returned',
      () => {
        expect(withPlanted(C11['closures missed']!)).toEqual([
          `apps/web/src/server/email/plant-c11-closure-defer.ts:14 resolveAndNotify() reads maintenance_requests.requester_email_snapshot and sends email through notify()${ASK_M}`,
          `apps/web/src/server/email/plant-c11-closure-defer.ts:12 resolveAndNotify>notify() captures maintenance_requests.requester_email_snapshot from resolveAndNotify() and sends email (sendEmail)${ASK_M}`,
          `apps/web/src/server/services/plant-c11-closure-after.ts:15 resolveTicket() reads support_tickets.email and sends email through notify()${ASK_S}`,
          `apps/web/src/server/services/plant-c11-closure-after.ts:13 resolveTicket>notify() captures support_tickets.email from resolveTicket() and sends email (sendEmail)${ASK_S}`,
          `apps/web/src/server/services/plant-c11-closure-handoff.ts:11 remindLater>queue() hands maintenance_requests.requester_email_snapshot to queueReminder() (@/server/jobs/plant-c10-reminders)${HAND_OFF_M}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c11) a closure deferred after the function asks is guarded by that answer; a closure that names the row only in its types reads nothing',
      () => {
        expect(withPlanted(C11['closures control']!)).toEqual([]);
      },
      TIMEOUT,
    );

    it(
      '(c11) missed at 784ab5775: a sender handed to map() by reference, in the same file and in another',
      () => {
        expect(withPlanted(C11['function values missed']!)).toEqual([
          `apps/web/src/server/jobs/plant-c11-map-sender.ts:3 remindSubmitter() is handed support_tickets.email by remindOpen() and sends email (sendEmail)${ASK_S}`,
          `apps/web/src/server/jobs/plant-c11-map-sender.ts:7 remindOpen() reads support_tickets.email and sends email through remindSubmitter()${ASK_S}`,
          `apps/web/src/server/jobs/plant-c11-map-import.ts:9 remindOpenRequests() reads maintenance_requests.requester_email_snapshot and sends email through sendReminder()${ASK_M}`,
          `apps/web/src/server/jobs/plant-c11-load-many.ts:9 remindMany() gets support_tickets.email from loadTicket() and sends email (sendEmail)${ASK_S}`,
          `apps/web/src/server/jobs/plant-c11-load-many.ts:13 exportOpen() hands support_tickets.email to stringify() (csv-stringify/sync)${HAND_OFF_S}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c11) missed at 784ab5775: an instance made in a conditional or an assignment, a constructor parameter property, and a method of an object holding the row',
      () => {
        expect(withPlanted(C11['receivers missed']!)).toEqual([
          `apps/web/src/server/services/plant-c11-notice-ticket.ts:3 ResolvedNotice.constructor() puts a row holding support_tickets.email into this.ticket${ESCAPE_S}`,
          `apps/web/src/server/services/plant-c11-notice-ticket.ts:16 resolveTicket() reads support_tickets.email and sends email through send()${ASK_S}`,
          `apps/web/src/server/email/plant-c11-notice-to.ts:16 resolveRequest() reads maintenance_requests.requester_email_snapshot and sends email through send()${ASK_M}`,
          `apps/web/src/server/services/plant-c11-wrapped-row.ts:12 resolveRequest() hands maintenance_requests.requester_email_snapshot to notice.send()${CANNOT_PLACE_M}`,
          `apps/web/src/server/email/plant-c11-notice-to.ts:3 ResolvedNotice.constructor() puts maintenance_requests.requester_email_snapshot into to${REGISTER}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c11) missed at 784ab5775: a list of addresses looped over or destructured, rows handled in then(), and rows a generator yields',
      () => {
        expect(withPlanted(C11['iteration missed']!)).toEqual([
          `apps/web/src/server/jobs/plant-c11-address-lists.ts:10 remindOpenRequests() hands maintenance_requests.requester_email_snapshot to enqueueEmail() (@/server/jobs/plant-c11-outbox)${HAND_OFF_M}`,
          `apps/web/src/server/jobs/plant-c11-address-lists.ts:19 remindFirst() hands maintenance_requests.requester_email_snapshot to enqueueEmail() (@/server/jobs/plant-c11-outbox)${HAND_OFF_M}`,
          `apps/web/src/server/jobs/plant-c11-by-index.ts:9 remindFirstByIndex() hands maintenance_requests.requester_email_snapshot to enqueueEmail() (@/server/jobs/plant-c11-outbox)${HAND_OFF_M}`,
          `apps/web/src/server/jobs/plant-c11-then.ts:6 remindOpen() hands support_tickets.email to enqueueEmail() (@/server/jobs/plant-c11-outbox)${HAND_OFF_S}`,
          `apps/web/src/server/jobs/plant-c11-generator.ts:5 remindAll() gets support_tickets.email from openTickets() and sends email (sendEmail)${ASK_S}`,
          `apps/web/src/server/jobs/plant-c11-address-lists.ts:10 remindOpenRequests() puts maintenance_requests.requester_email_snapshot into to${REGISTER}`,
          `apps/web/src/server/jobs/plant-c11-address-lists.ts:19 remindFirst() puts maintenance_requests.requester_email_snapshot into to${REGISTER}`,
          `apps/web/src/server/jobs/plant-c11-by-index.ts:9 remindFirstByIndex() puts maintenance_requests.requester_email_snapshot into to${REGISTER}`,
          `apps/web/src/server/jobs/plant-c11-then.ts:6 remindOpen() puts support_tickets.email into to${REGISTER}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c11) missed at 784ab5775: support tickets embedded in an organizations or user_profiles select, and a select list the scan cannot read on organizations',
      () => {
        expect(withPlanted(C11['select embeds missed']!)).toEqual([
          `apps/web/src/server/jobs/plant-c11-org-tickets.ts:5 remindOrgTickets() reads support_tickets.email and sends email (sendEmail)${ASK_S}`,
          `apps/web/src/server/jobs/plant-c11-org-tickets.ts:13 queueMemberTickets() hands support_tickets.email to queueReminder() (@/server/jobs/plant-c10-reminders)${HAND_OFF_S}`,
          `apps/web/src/server/jobs/plant-c11-org-tickets.ts:21 queueItemRequests() hands maintenance_requests.requester_email_snapshot to queueReminder() (@/server/jobs/plant-c10-reminders)${HAND_OFF_M}`,
          `apps/web/src/server/jobs/plant-c11-org-tickets.ts:13 queueMemberTickets() puts support_tickets.email into to${REGISTER}`,
          `apps/web/src/server/jobs/plant-c11-org-tickets.ts:16 remindWithColumns() selects through a select list the scan cannot read on .from('organizations'), which can embed support_tickets${DYNAMIC}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c11) an organizations select that embeds no ticket, through a template of a constant, is no read',
      () => {
        expect(withPlanted(C11['select embeds control']!)).toEqual([]);
      },
      TIMEOUT,
    );

    it(
      '(c11) missed at 784ab5775: a kept column renamed in the select, handed to another file, a fetch and an outbox',
      () => {
        expect(withPlanted(C11['select renames missed']!)).toEqual([
          `apps/web/src/server/services/plant-c11-rename.ts:9 remindRequester() hands maintenance_requests.requester_email_snapshot to queueReminder() (@/server/jobs/plant-c11-rename-queue)${HAND_OFF_M}`,
          `apps/web/src/server/services/plant-c11-rename.ts:17 remindViaHook() hands maintenance_requests.requester_email_snapshot to fetch()${CANNOT_PLACE_M}`,
          `apps/web/src/server/services/plant-c11-rename.ts:21 remindSubmitter() hands support_tickets.email to queueReminder() (@/server/jobs/plant-c11-rename-queue)${HAND_OFF_S}`,
          `apps/web/src/server/services/plant-c11-rename.ts:6 remindRequester() puts maintenance_requests.requester_email_snapshot into contact${REGISTER}`,
          `apps/web/src/server/services/plant-c11-rename.ts:9 remindRequester() puts maintenance_requests.requester_email_snapshot into to${REGISTER}`,
          `apps/web/src/server/services/plant-c11-rename.ts:14 remindViaHook() puts maintenance_requests.requester_email_snapshot into contact${REGISTER}`,
          `apps/web/src/server/services/plant-c11-rename.ts:17 remindViaHook() puts maintenance_requests.requester_email_snapshot into body${REGISTER}`,
          `apps/web/src/server/services/plant-c11-rename.ts:20 remindSubmitter() puts support_tickets.email into recipient${REGISTER}`,
          `apps/web/src/server/services/plant-c11-rename.ts:21 remindSubmitter() puts support_tickets.email into to${REGISTER}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c11) renaming a column that is no kept address is no alias',
      () => {
        expect(withPlanted(C11['select renames control']!)).toEqual([]);
      },
      TIMEOUT,
    );

    it(
      '(c11) missed at 784ab5775: a row taken apart with ...rest, then() on a query, a callback another call hands the rows, and a row kept in a module variable',
      () => {
        expect(withPlanted(C11['more carrying missed']!)).toEqual([
          `apps/web/src/server/services/plant-c11-more.ts:11 queueRest() hands maintenance_requests.requester_email_snapshot to queueReminder() (@/server/jobs/plant-c10-reminders)${HAND_OFF_M}`,
          `apps/web/src/server/services/plant-c11-more.ts:15 remindViaThen() hands support_tickets.email to queueReminder() (@/server/jobs/plant-c10-reminders)${HAND_OFF_S}`,
          `apps/web/src/server/services/plant-c11-more.ts:19 remindEach() hands support_tickets.email to queueReminder() (@/server/jobs/plant-c10-reminders)${HAND_OFF_S}`,
          `apps/web/src/server/services/plant-c11-more.ts:34 remindLast() captures support_tickets.email from its top level and sends email (sendEmail)${ASK_S}`,
          `apps/web/src/server/services/plant-c11-more.ts:19 remindEach() puts support_tickets.email into to${REGISTER}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c11) a variable named like a function of the file is that variable, not the function (still caught at 784ab5775)',
      () => {
        expect(withPlanted(C11['shadowed function name']!)).toEqual([
          `apps/web/src/server/services/plant-c11-shadow.ts:9 queueCopy() hands support_tickets.email to queueReminder() (@/server/jobs/plant-c10-reminders)${HAND_OFF_S}`,
        ]);
      },
      TIMEOUT,
    );

    it(
      '(c11) a query builder and the methods of arrays called on rows, a constant passed beside rows, and a catch() callback carry nothing to report',
      () => {
        expect(withPlanted(C11['carrying control']!)).toEqual([]);
      },
      TIMEOUT,
    );

    it(
      '(c11) missed at 784ab5775: a new rental sender in a file NO_ANSWER_YET lists for another function',
      () => {
        const at = (file: string) =>
          readFileSync(path.join(REPO, file), 'utf8').split('\n').length + 1;
        expect(withPlanted(C11['rental senders in listed files missed']!)).toEqual([
          `${RENTAL_ACTIONS}:${at(RENTAL_ACTIONS)} emailBorrowerAgainAction() reads rentals.borrower_email and sends it or hands it on, and nothing can answer for it yet: list the function in NO_ANSWER_YET with the reason`,
          `${RENTAL_ROUTE}:${at(RENTAL_ROUTE)} emailBorrowerAgain() reads rentals.borrower_email and sends it or hands it on, and nothing can answer for it yet: list the function in NO_ANSWER_YET with the reason`,
        ]);
      },
      TIMEOUT,
    );
  });
});
