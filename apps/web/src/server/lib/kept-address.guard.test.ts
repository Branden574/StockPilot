import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  OWNER_COLUMNS,
  OWNER_TABLES,
  constObjectStringValues,
  findCalls,
  findNewRowAssignments,
  findSqlWrites,
  findTriggerFunctions,
  findTsWrites,
  latestFunctionBodies,
  mayHoldWrite,
  type OwnerTable,
  type SqlWrite,
  type TriggerOnOwnerTable,
  type TsCall,
  type TsWrite,
} from '@/test/kept-address-owners';

/**
 * GUARD (B23): an emptied owner column on a maintenance request or a support
 * ticket means "the person who filed it deleted their account".
 *
 * WHY. server/lib/kept-address.ts decides whether a record's kept address may
 * still be emailed from its owner columns, because neither table has a
 * deletion marker yet: a maintenance request with no requester_user_id, and a
 * support ticket that names an organization and no submitted_by, are a
 * deleted member's (the foreign keys are ON DELETE SET NULL). That holds only
 * while nothing else writes a missing owner for a living person. One such
 * write and that person silently stops getting their resolution email.
 *
 * WHAT THIS CHECKS, in web (apps/web/src), phone (apps/mobile/app,
 * apps/mobile/src) and core (packages/core/src), tests left out, and in every
 * migration (supabase/migrations, comments left out):
 *   - each table has exactly one insert, the one in INSERT_PATHS, and it names
 *     the owner the way the inference needs: MaintenanceRequestsService.create
 *     writes requester_user_id = this.ctx.userId (the request form and the
 *     exception escalation both go through it); createSupportTicket takes both
 *     owner columns from supportTicketOwner(input), which refuses half a pair;
 *   - nothing upserts either table, and no update writes an owner column;
 *     an update whose columns the scan cannot read is in REVIEWED_UNREAD with
 *     the reason it cannot write one;
 *   - a write whose table the scan cannot read (`.from(variable)`) is in
 *     REVIEWED_DYNAMIC with the reason it cannot be either table;
 *   - every createSupportTicket(…) call passes organizationId and submittedBy
 *     together, or neither;
 *   - no migration INSERTs, MERGEs or COPYs into either table, or UPDATEs an
 *     owner column, and no function a trigger on either table runs assigns
 *     NEW's owner column (or NEW itself).
 * A REVIEWED entry that no longer matches anything fails too.
 *
 * IF THIS FAILS. A new way to write one of these tables or its owner columns
 * appeared. Decide whether it can leave the owner empty for a person who
 * still has an account. If it can, it breaks kept-address.ts: name the owner
 * there instead (or add the deletion marker designed in B23 and switch
 * kept-address.ts to it). If it cannot, record it here: in INSERT_PATHS for a
 * new insert, or in REVIEWED_UNREAD / REVIEWED_DYNAMIC with the reason.
 */

const REPO = path.resolve(__dirname, '../../../../..');
const ROOTS = ['apps/web/src', 'apps/mobile/app', 'apps/mobile/src', 'packages/core/src'];
/** Test helpers and fixtures. Only this exact directory: a directory named
 *  `test` elsewhere can be shipped code (app/api/v1/push/test is a route). */
const TEST_HELPERS = 'apps/web/src/test';
const MIGRATIONS = 'supabase/migrations';
const TIMEOUT = 120_000;

/** The one insert per table: where it is, and how it must name the owner. */
const INSERT_PATHS: Record<
  OwnerTable,
  { file: string; enclosing: string; check: (w: TsWrite) => string | null }
> = {
  maintenance_requests: {
    file: 'apps/web/src/server/services/maintenance-requests.ts',
    enclosing: 'create',
    check: (w) =>
      w.columns?.requester_user_id === 'this.ctx.userId' && w.spreads.length === 0
        ? null
        : 'must write requester_user_id: this.ctx.userId (the signed-in filer), with no spread',
  },
  support_tickets: {
    file: 'apps/web/src/server/services/support-tickets.ts',
    enclosing: 'createSupportTicket',
    check: (w) =>
      w.spreads.length === 1 &&
      /^supportTicketOwner\(\w+\)$/.test(w.spreads[0] ?? '') &&
      w.columns !== null &&
      !('organization_id' in w.columns) &&
      !('submitted_by' in w.columns)
        ? null
        : 'must take organization_id and submitted_by only from ...supportTicketOwner(input)',
  },
};

interface Reviewed {
  file: string;
  enclosing: string;
  why: string;
}

/** Updates of either table whose columns the scan cannot read, checked by hand. */
const REVIEWED_UNREAD: Array<Reviewed & { table: OwnerTable }> = [
  {
    file: 'apps/web/src/server/services/maintenance-requests.ts',
    enclosing: 'update',
    table: 'maintenance_requests',
    why:
      'Its columns are updated_at and COLUMN_FOR_FIELD values (the form fields), and the test ' +
      'below checks COLUMN_FOR_FIELD names no owner column. 0362 also refuses any change of ' +
      'requester_user_id from the request client it writes through.',
  },
];

/** Writes through `.from(<not a literal>)`, checked by hand. */
const REVIEWED_DYNAMIC: Reviewed[] = [
  {
    file: 'apps/web/src/server/services/recovery.ts',
    enclosing: 'restore',
    why: "ENTITY_TABLE's soft-deleted catalog tables (items, categories and the like), neither of these.",
  },
  {
    file: 'apps/web/src/server/services/restore-points.ts',
    enclosing: 'ensureRefMap',
    why: "Its table parameter is typed 'categories' | 'suppliers'.",
  },
];

// ── The scan ────────────────────────────────────────────────────────────────

interface TriggerAssignment {
  trigger: TriggerOnOwnerTable;
  found: string[];
}

interface Scan {
  writes: TsWrite[];
  /** createSupportTicket(…) calls. */
  calls: TsCall[];
  sql: SqlWrite[];
  triggerAssignments: TriggerAssignment[];
  /** Triggers whose function's body the scan could not find. */
  unreadTriggers: TriggerOnOwnerTable[];
  /** COLUMN_FOR_FIELD's values in maintenance-requests.ts (null: unread). */
  maintenanceFormColumns: string[] | null;
}

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

function scanSql(
  files: Array<{ file: string; text: string }>,
): Pick<Scan, 'sql' | 'triggerAssignments' | 'unreadTriggers'> {
  const sql = files.flatMap(({ file, text }) => findSqlWrites(file, text));
  const triggers = files.flatMap(({ file, text }) => findTriggerFunctions(file, text));
  const bodies = latestFunctionBodies(files);
  const triggerAssignments: TriggerAssignment[] = [];
  const unreadTriggers: TriggerOnOwnerTable[] = [];
  for (const t of triggers) {
    const body = t.fn ? bodies.get(t.fn) : undefined;
    if (!body) {
      unreadTriggers.push(t);
      continue;
    }
    const found = findNewRowAssignments(body.body, OWNER_COLUMNS[t.table]);
    if (found.length > 0) triggerAssignments.push({ trigger: t, found });
  }
  return { sql, triggerAssignments, unreadTriggers };
}

function scanRepo(): Scan {
  const writes: TsWrite[] = [];
  const calls: TsCall[] = [];
  for (const file of ROOTS.flatMap((r) => sourceFiles(r))) {
    const text = readFileSync(path.join(REPO, file), 'utf8');
    if (mayHoldWrite(text)) writes.push(...findTsWrites(file, text));
    calls.push(...findCalls(file, text, 'createSupportTicket'));
  }
  const migrations = readdirSync(path.join(REPO, MIGRATIONS))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({
      file: `${MIGRATIONS}/${f}`,
      text: readFileSync(path.join(REPO, MIGRATIONS, f), 'utf8'),
    }));
  const maintenanceFile = INSERT_PATHS.maintenance_requests.file;
  return {
    writes,
    calls,
    ...scanSql(migrations),
    maintenanceFormColumns: constObjectStringValues(
      maintenanceFile,
      readFileSync(path.join(REPO, maintenanceFile), 'utf8'),
      'COLUMN_FOR_FIELD',
    ),
  };
}

// ── The rules ───────────────────────────────────────────────────────────────

/** A value that names somebody: present, and not a literal null/undefined. */
function names(value: string | undefined): boolean {
  return value !== undefined && value !== 'null' && value !== 'undefined';
}

function matches(r: Reviewed, w: { file: string; enclosing: string }): boolean {
  return r.file === w.file && r.enclosing === w.enclosing;
}

function ownerWriteFindings(scan: Scan): string[] {
  const out: string[] = [];
  const at = (w: { file: string; line: number }) => `${w.file}:${w.line}`;

  for (const table of OWNER_TABLES) {
    const expected = INSERT_PATHS[table];
    let seen = false;
    for (const w of scan.writes.filter((x) => x.table === table && x.method !== 'update')) {
      if (w.method === 'upsert') {
        out.push(`${at(w)} upserts ${table}: an upsert can rewrite a row's owner; insert instead`);
      } else if (w.file !== expected.file || w.enclosing !== expected.enclosing) {
        out.push(
          `${at(w)} a new insert path for ${table} (${w.enclosing || 'top level'}): ` +
            'decide whether it always names the owner, then list it in INSERT_PATHS',
        );
      } else {
        seen = true;
        const problem = expected.check(w);
        if (problem) out.push(`${at(w)} the ${table} insert ${problem}`);
      }
    }
    if (!seen) {
      out.push(`${expected.file}: its ${table} insert in ${expected.enclosing}() was not found`);
    }
  }

  const unreadSeen = new Set<Reviewed>();
  for (const w of scan.writes.filter((x) => x.table !== null && x.method === 'update')) {
    const table = w.table as OwnerTable;
    if (w.columns === null || w.spreads.length > 0) {
      const reviewed = REVIEWED_UNREAD.find((r) => r.table === table && matches(r, w));
      if (reviewed) unreadSeen.add(reviewed);
      else {
        out.push(
          `${at(w)} updates ${table} with columns the scan cannot read: pass an object ` +
            'literal, or check it by hand and list it in REVIEWED_UNREAD',
        );
      }
      continue;
    }
    const owners = OWNER_COLUMNS[table].filter((c) => c in (w.columns ?? {}));
    if (owners.length > 0) out.push(`${at(w)} updates ${table}.${owners.join(', ')}`);
  }
  for (const r of REVIEWED_UNREAD) {
    if (!unreadSeen.has(r)) out.push(`REVIEWED_UNREAD ${r.file} ${r.enclosing}(): no longer found`);
  }

  const dynamicSeen = new Set<Reviewed>();
  for (const w of scan.writes.filter((x) => x.table === null)) {
    const reviewed = REVIEWED_DYNAMIC.find((r) => matches(r, w));
    if (reviewed) dynamicSeen.add(reviewed);
    else {
      out.push(
        `${at(w)} .${w.method}() through .from(${w.tableExpression}), a table the scan cannot ` +
          'read: check it can be neither table and list it in REVIEWED_DYNAMIC',
      );
    }
  }
  for (const r of REVIEWED_DYNAMIC) {
    if (!dynamicSeen.has(r))
      out.push(`REVIEWED_DYNAMIC ${r.file} ${r.enclosing}(): no longer found`);
  }

  for (const c of scan.calls) {
    if (c.args === null) {
      out.push(
        `${at(c)} createSupportTicket(…) with an argument the scan cannot read: pass an object literal`,
      );
    } else if (names(c.args.organizationId) !== names(c.args.submittedBy)) {
      out.push(`${at(c)} createSupportTicket(…) names only one of organizationId and submittedBy`);
    }
  }

  for (const s of scan.sql) {
    out.push(
      s.kind === 'update'
        ? `${at(s)} a migration updates ${s.table}.${s.columns.join(', ')}`
        : `${at(s)} a migration ${s.kind}s into ${s.table}: a new insert path`,
    );
  }
  for (const t of scan.triggerAssignments) {
    out.push(
      `${at(t.trigger)} trigger ${t.trigger.trigger} on ${t.trigger.table} runs ${t.trigger.fn ?? '?'}(), ` +
        `which assigns ${t.found.join(', ')}`,
    );
  }
  for (const t of scan.unreadTriggers) {
    out.push(`${at(t)} trigger ${t.trigger} on ${t.table}: its function's body was not found`);
  }

  if (scan.maintenanceFormColumns === null) {
    out.push(
      `${INSERT_PATHS.maintenance_requests.file}: COLUMN_FOR_FIELD is not an object of string literals`,
    );
  } else if (scan.maintenanceFormColumns.includes('requester_user_id')) {
    out.push(
      `${INSERT_PATHS.maintenance_requests.file}: COLUMN_FOR_FIELD lets a form field write requester_user_id`,
    );
  }
  return out;
}

// ── The tests ───────────────────────────────────────────────────────────────

describe('kept-address owner columns (B23 guard)', () => {
  let scanned: Scan | null = null;
  const repo = (): Scan => (scanned ??= scanRepo());

  it(
    'nothing writes a missing owner for a living person',
    () => {
      expect(ownerWriteFindings(repo())).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'found the two insert paths, and the phone and core write neither table',
    () => {
      const inserts = repo().writes.filter((w) => w.table !== null && w.method === 'insert');
      expect(inserts.map((w) => `${w.file} ${w.enclosing} ${w.table}`).sort()).toEqual([
        'apps/web/src/server/services/maintenance-requests.ts create maintenance_requests',
        'apps/web/src/server/services/support-tickets.ts createSupportTicket support_tickets',
      ]);
      expect(repo().calls.length).toBeGreaterThanOrEqual(3);
    },
    TIMEOUT,
  );

  describe('self-test: planted write paths are caught', () => {
    const PLANTED_TS = `
      export async function fileFromKiosk(admin: Admin, org: string) {
        await admin
          .from('maintenance_requests')
          .insert({ organization_id: org, requester_user_id: null, subject: 'Leak' });
      }
      export async function detach(admin: Admin, id: string) {
        await admin.from('support_tickets').update({ submitted_by: null }).eq('id', id);
      }
      export async function adopt(admin: Admin, id: string) {
        await admin.from('maintenance_requests').upsert({ id, requester_user_id: null });
      }
      export async function anyTable(admin: Admin, table: string) {
        await admin.from(table).insert({ organization_id: null });
      }
    `;
    const PLANTED_CALL = `
      await createSupportTicket({ email, category: 'bug', subject, message, organizationId: ctx.organizationId });
      await createSupportTicket(input);
      await createSupportTicket({ email, category: 'bug', subject, message, organizationId: null, submittedBy: null });
    `;
    const PLANTED_SQL = `
      -- insert into public.support_tickets (comment only: not a write)
      create or replace function public.file_from_email(p_org uuid)
      returns uuid language plpgsql security definer set search_path = public as $$
      begin
        insert into public.support_tickets (organization_id, email, category, subject, message)
        values (p_org, 'someone@example.com', 'other', 'From email', 'Body');
        update public.maintenance_requests m set requester_user_id = null where m.organization_id = p_org;
        return null;
      end;
      $$;
      create or replace function public.tg_maintenance_requests_kiosk()
      returns trigger language plpgsql as $$
      begin
        if new.requester_user_id = auth.uid() then
          return new;
        end if;
        new.requester_user_id := null;
        return new;
      end;
      $$;
      create trigger trg_kiosk before insert on public.maintenance_requests
        for each row execute function public.tg_maintenance_requests_kiosk();
    `;

    it(
      'reports each planted TypeScript write, by file and line',
      () => {
        const writes = findTsWrites('apps/web/src/server/services/kiosk-intake.ts', PLANTED_TS);
        const found = ownerWriteFindings({ ...repo(), writes: [...repo().writes, ...writes] });
        expect(found).toEqual([
          'apps/web/src/server/services/kiosk-intake.ts:3 a new insert path for maintenance_requests (fileFromKiosk): decide whether it always names the owner, then list it in INSERT_PATHS',
          "apps/web/src/server/services/kiosk-intake.ts:11 upserts maintenance_requests: an upsert can rewrite a row's owner; insert instead",
          'apps/web/src/server/services/kiosk-intake.ts:8 updates support_tickets.submitted_by',
          'apps/web/src/server/services/kiosk-intake.ts:14 .insert() through .from(table), a table the scan cannot read: check it can be neither table and list it in REVIEWED_DYNAMIC',
        ]);
      },
      TIMEOUT,
    );

    it(
      'reports a createSupportTicket call with half an owner, or one it cannot read',
      () => {
        const calls = findCalls(
          'apps/web/src/app/api/v1/kiosk/route.ts',
          PLANTED_CALL,
          'createSupportTicket',
        );
        const found = ownerWriteFindings({ ...repo(), calls: [...repo().calls, ...calls] });
        expect(found).toEqual([
          'apps/web/src/app/api/v1/kiosk/route.ts:2 createSupportTicket(…) names only one of organizationId and submittedBy',
          'apps/web/src/app/api/v1/kiosk/route.ts:3 createSupportTicket(…) with an argument the scan cannot read: pass an object literal',
        ]);
      },
      TIMEOUT,
    );

    it(
      'reports a planted migration insert, owner update and trigger assignment, and not a comment',
      () => {
        const planted = scanSql([
          { file: 'supabase/migrations/9999_planted.sql', text: PLANTED_SQL },
        ]);
        const found = ownerWriteFindings({
          ...repo(),
          sql: [...repo().sql, ...planted.sql],
          triggerAssignments: [...repo().triggerAssignments, ...planted.triggerAssignments],
          unreadTriggers: [...repo().unreadTriggers, ...planted.unreadTriggers],
        });
        expect(found).toEqual([
          'supabase/migrations/9999_planted.sql:6 a migration inserts into support_tickets: a new insert path',
          'supabase/migrations/9999_planted.sql:8 a migration updates maintenance_requests.requester_user_id',
          'supabase/migrations/9999_planted.sql:22 trigger trg_kiosk on maintenance_requests runs tg_maintenance_requests_kiosk(), which assigns new.requester_user_id :=',
        ]);
      },
      TIMEOUT,
    );

    it('passes the deletion markers B23 designs (they write no owner column)', () => {
      const marker = `
        update public.maintenance_requests
           set requester_deleted_at = now()
         where requester_user_id = old.id
           and requester_deleted_at is null;
        update public.support_tickets
           set submitter_deleted_at = now()
         where submitted_by = old.id
           and submitter_deleted_at is null;
      `;
      expect(findSqlWrites('supabase/migrations/9999_markers.sql', marker)).toEqual([]);
    });
  });
});
