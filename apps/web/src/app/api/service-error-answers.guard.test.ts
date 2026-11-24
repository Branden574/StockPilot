import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A route's catch answers a ServiceError through the shared helper
 * (server/lib/service-error-response.ts serviceErrorResponse): every refusal
 * keeps its own status from serviceErrorStatus, its words and its details; a
 * warehouse ForbiddenError is a 403, or the retryable 503 when the caller's
 * access could not be read; an internal_error and anything else is reported
 * once under the route's tag and answered with the fixed sentence.
 *
 * A hand-written `instanceof ServiceError` branch that builds its own answer
 * (a status ladder, a fixed status, its own body) has to be listed below with
 * the reason the route needs its own answer, and the count of such branches
 * in the file. A branch that only reads the error (a test before the helper,
 * a ternary inside a report, a rethrow) is not an answer and is not counted.
 */

const API_ROOT = join(__dirname);

/** route path under app/api -> { branches, reason } */
const OWN_ANSWERS: Record<string, { branches: number; reason: string }> = {
  // Area helpers: the shared answer for their routes' own error shape.
  'v1/change-error-response.ts': {
    branches: 1,
    reason: 'Area helper for the schedule, serial number and customer status routes.',
  },
  'v1/exceptions/error-response.ts': {
    branches: 1,
    reason: 'Area helper for the exception routes.',
  },
  'v1/members/error-response.ts': {
    branches: 1,
    reason: 'Area helper for the members routes.',
  },
  'v1/returns/http.ts': {
    branches: 1,
    reason: 'Area helper for the returns routes: no-store headers and details.reason failed.',
  },
  'v1/size-counts/route.ts': {
    branches: 1,
    reason: 'Area helper for the size count routes: their own fault sentence, reported here.',
  },
  // A module or permission refusal only; everything else is answered elsewhere.
  'ai/chat/route.ts': {
    branches: 1,
    reason:
      'Answers only a module-off or permission refusal (403); anything else goes to answerModuleState or is thrown on.',
  },
  'books/extract-isbns-ai/route.ts': {
    branches: 2,
    reason:
      'Answers only a module-off or permission refusal (403); anything else goes to answerModuleState or is thrown on.',
  },
  'v1/ai/identify-from-photo/route.ts': {
    branches: 1,
    reason:
      'Answers only a module-off or permission refusal (403); anything else goes to answerModuleState or is thrown on.',
  },
  'v1/items/upc-lookup/route.ts': {
    branches: 1,
    reason:
      'Answers only a module-off or permission refusal (403); anything else goes to answerModuleState or is thrown on.',
  },
  'books/extract-isbns/route.ts': {
    branches: 1,
    reason:
      "The file parser's refusal is a 400 about the uploaded file; faults go to internalErrorResponse.",
  },
  'v1/support/route.ts': {
    branches: 1,
    reason:
      "The screenshot's upload check (part 6): its refusal is a 400 invalid_attachment with the check's sentence, the same code as the path's shape refusal; a fault is reported and answered 500.",
  },
  // Downloads (PDF, CSV, zip, label image).
  'cycle-counts/[id]/pdf/route.tsx': {
    branches: 1,
    reason:
      'Download route: statuses from serviceErrorStatus, an internal_error reported here with its detail, its own fault body.',
  },
  'movements/export.csv/route.ts': {
    branches: 1,
    reason:
      'Download route: statuses from serviceErrorStatus, an internal_error reported here with its detail, its own fault body.',
  },
  'orders/[id]/packing-slip-customer.pdf/route.tsx': {
    branches: 1,
    reason:
      'Download route: statuses from serviceErrorStatus, an internal_error reported here with its detail, its own fault body.',
  },
  'orders/[id]/packing-slip-warehouse.pdf/route.tsx': {
    branches: 1,
    reason:
      'Download route: statuses from serviceErrorStatus, an internal_error reported here with its detail, its own fault body.',
  },
  'orders/[id]/pick-slip.pdf/route.tsx': {
    branches: 1,
    reason:
      'Download route: statuses from serviceErrorStatus, an internal_error reported here with its detail, its own fault body.',
  },
  'orders/export.csv/route.ts': {
    branches: 1,
    reason:
      'Download route: statuses from serviceErrorStatus, an internal_error reported here with its detail, its own fault body.',
  },
  'orders/export.pdf/route.tsx': {
    branches: 1,
    reason:
      'Download route: statuses from serviceErrorStatus, an internal_error reported here with its detail, its own fault body.',
  },
  'purchase-orders/[id]/pdf/route.tsx': {
    branches: 1,
    reason:
      'Download route: statuses from serviceErrorStatus, an internal_error reported here with its detail, its own fault body.',
  },
  'purchase-orders/export.csv/route.ts': {
    branches: 1,
    reason:
      'Download route: statuses from serviceErrorStatus, an internal_error reported here with its detail, its own fault body.',
  },
  'purchase-orders/[id]/attachments.zip/route.ts': {
    branches: 1,
    reason:
      'A purchase order that cannot be opened is a 404 before the zip is built; the outer catch uses serviceErrorResponse.',
  },
  'v1/items/[id]/barcode/route.ts': {
    branches: 1,
    reason:
      'Label image endpoint: answers plain text, statuses from serviceErrorStatus, an internal_error reported here.',
  },
  // Phone outbox and count drain routes: the status is the drain's final-or-retry verdict.
  'v1/cycle-counts/[id]/lines/[lineId]/record/route.ts': {
    branches: 1,
    reason: 'Count drain: a lock wait is a retryable 503 and a refusal a final 409.',
  },
  'v1/cycle-counts/[id]/lines/[lineId]/clear/route.ts': {
    branches: 1,
    reason: 'Count drain: sends details.reason only (refusalReasonDetails).',
  },
  'v1/cycle-counts/[id]/reassign/route.ts': {
    branches: 1,
    reason:
      'Deferred to its own change: its own status table (no plan-limit case, an internal_error not reported); the phone sheet shows only the message, so it can move.',
  },
  'v1/cycle-counts/[id]/release/route.ts': {
    branches: 1,
    reason:
      'Deferred to its own change: its own status table (no plan-limit case, an internal_error not reported); the phone sheet shows only the message, so it can move.',
  },
  'v1/bundles/[id]/distribute/route.ts': {
    branches: 1,
    reason: 'Outbox route: its own status table, with details.reason only (refusalReasonDetails).',
  },
  'v1/po/[id]/receipts/route.ts': {
    branches: 1,
    reason:
      'Receiving: a module or plan refusal is a 403 here (plan_limit_exceeded included), as receive-line answers it.',
  },
  'v1/po/[id]/receive-line/route.ts': {
    branches: 2,
    reason:
      'Outbox route: a module or plan refusal is a 403 (plan_limit_exceeded included), and a refusal before the order is the receipt refusal.',
  },
  // Items: the sentence or details the phone acts on.
  'v1/items/route.ts': {
    branches: 1,
    reason:
      "Deferred until the phone's item screens are checked: sends details (null when the service set none) for the sports codes; a ForbiddenError is a 403.",
  },
  'v1/items/sized-variants/route.ts': {
    branches: 1,
    reason:
      "Deferred until the phone's size screens are checked: sends details (null when the service set none) for the size codes; a ForbiddenError is a 403.",
  },
  'v1/product-groups/linking/route.ts': {
    branches: 1,
    reason:
      "Sends details (null when the service set none) with the sports codes and item ids for the phone's rows.",
  },
  'v1/items/[id]/adjust/route.ts': {
    branches: 1,
    reason: 'Sends details for the authenticator refusal; a ForbiddenError is answered after it.',
  },
  'v1/items/[id]/transfer/route.ts': {
    branches: 2,
    reason:
      'An insufficient_stock fault is a 400 with the move sentence; details carry the crate confirmation.',
  },
  'v1/items/[id]/remove-stock/route.ts': {
    branches: 1,
    reason:
      'An insufficient_stock fault is a 400 with the remove sentence; everything else uses serviceErrorResponse.',
  },
  'v1/items/[id]/history/route.ts': {
    branches: 1,
    reason: "Deferred until the phone's item history is checked: a ForbiddenError is a final 403.",
  },
  'v1/inventory/staging/route.ts': {
    branches: 1,
    reason: "Deferred until the phone's staging list is checked: a ForbiddenError is a final 403.",
  },
  // Grouping.
  'v1/items/grouping/route.ts': {
    branches: 1,
    reason:
      'Grouping: the status from GROUPING_ERROR_TABLE by details.reason, and the grouping fault sentence.',
  },
  'v1/items/grouping/preview/route.ts': {
    branches: 1,
    reason:
      'Grouping: the status from GROUPING_ERROR_TABLE by details.reason, and the grouping fault sentence.',
  },
  'v1/items/ungroup/route.ts': {
    branches: 1,
    reason:
      'Grouping: the status from GROUPING_ERROR_TABLE by details.reason, and the grouping fault sentence.',
  },
  'v1/items/ungroup-selected/route.ts': {
    branches: 1,
    reason:
      'Grouping: the status from GROUPING_ERROR_TABLE by details.reason, and the grouping fault sentence.',
  },
  'v1/items/ungroup-selected/preview/route.ts': {
    branches: 1,
    reason:
      'Grouping: the status from GROUPING_ERROR_TABLE by details.reason, and the grouping fault sentence.',
  },
  // Orders: the sentence or details.reason the phone's order screens act on.
  'v1/orders/[id]/lines/route.ts': {
    branches: 3,
    reason:
      "details.reason busy or partial for the phone's order sheet; a ForbiddenError is a 403.",
  },
  'v1/orders/[id]/pick-line/route.ts': {
    branches: 1,
    reason: "Deferred until the phone's picker is checked: a ForbiddenError is a final 403.",
  },
  'v1/orders/[id]/transition/route.ts': {
    branches: 1,
    reason:
      "Deferred until the phone's order screens are checked: the hold_stock fault sentence; a ForbiddenError is a final 403.",
  },
  'v1/orders/[id]/needed-by/route.ts': {
    branches: 1,
    reason: "Core's fault sentence and details.reason failed (the service reports the fault).",
  },
  'v1/orders/[id]/shortfall-po/route.ts': {
    branches: 1,
    reason: "Core's fault sentence and details.reason failed (the service reports the fault).",
  },
  'v1/orders/[id]/returns/route.ts': {
    branches: 1,
    reason: 'details.reason failed with the returns fault sentence, reported here.',
  },
  // Rentals and the public return form.
  'v1/rentals/route.ts': {
    branches: 2,
    reason:
      "An internal_error is reported here with the rentals fault body; the phone reads this route's own status table.",
  },
  'v1/rentals/borrowers/route.ts': {
    branches: 1,
    reason: 'An internal_error is reported here with the members fault sentence.',
  },
  'v1/public/returns/route.ts': {
    branches: 1,
    reason: 'Public return form, no session: a refusal is the closed-door 404.',
  },
};

const ANSWER_RE =
  /\bstatus\s*:|\bstatus\s*[,}]|serviceErrorStatus\(|NextResponse\.json\(|new NextResponse\(|new Response\(|Response\.json\(|\banswer\(/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name))
      out.push(full);
  }
  return out;
}

/** Comments out, so a sentence that names the class is not read as code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * The code a test of `instanceof ServiceError` decides: the block of the `if`
 * it opens (to its matching brace), or, when the test is not an `if` with a
 * block, the rest of its statement.
 */
function branchAt(src: string, at: number): string {
  // The `if (` that this test belongs to, when the test sits in its condition.
  const lineStart = src.lastIndexOf('\n', at) + 1;
  const before = src.slice(Math.max(0, lineStart - 200), at);
  const ifAt = before.lastIndexOf('if (');
  let i = at;
  if (ifAt !== -1) {
    // Walk to the end of the condition.
    let depth = 0;
    let j = Math.max(0, lineStart - 200) + ifAt + 3;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j > at) {
      i = j + 1;
      while (i < src.length && /\s/.test(src[i]!)) i++;
      if (src[i] === '{') {
        let d = 0;
        for (let k = i; k < src.length; k++) {
          if (src[k] === '{') d++;
          else if (src[k] === '}') {
            d--;
            if (d === 0) return src.slice(i, k + 1);
          }
        }
      }
    }
  }
  const end = src.indexOf(';', i);
  return src.slice(at, end === -1 ? src.length : end + 1);
}

/** The rest of the block that holds position `from`, to its closing brace. */
function restOfBlock(src: string, from: number): string {
  let d = 0;
  for (let k = from; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') {
      d--;
      if (d < 0) return src.slice(from, k);
    }
  }
  return src.slice(from);
}

/**
 * Hand-written ServiceError answers in one source text. A negated test that
 * throws everything else (`if (!(e instanceof ServiceError)) throw e;`) leaves
 * only ServiceErrors below it, so the rest of its block is the branch.
 */
function ownServiceErrorAnswers(source: string): number {
  const src = stripComments(source);
  let count = 0;
  for (const m of src.matchAll(/instanceof\s+ServiceError\b/g)) {
    const at = m.index!;
    let branch = branchAt(src, at);
    const negated = /!\(\s*[\w.]+\s*$/.test(src.slice(Math.max(0, at - 60), at));
    if (negated && /\bthrow\b/.test(branch)) {
      branch = restOfBlock(src, src.indexOf(branch, at) + branch.length);
    }
    if (ANSWER_RE.test(branch)) count++;
  }
  return count;
}

/** Files under app/api that rename ServiceError or call serviceErrorStatus. */
function scanOther(): { aliases: string[]; statusCallers: string[] } {
  const aliases: string[] = [];
  const statusCallers: string[] = [];
  for (const file of walk(API_ROOT)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const rel = relative(API_ROOT, file).split(sep).join('/');
    if (/\bServiceError\s+as\s+\w/.test(src)) aliases.push(rel);
    if (/serviceErrorStatus\(/.test(src)) statusCallers.push(rel);
  }
  return { aliases, statusCallers };
}

function scan(): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of walk(API_ROOT)) {
    const n = ownServiceErrorAnswers(readFileSync(file, 'utf8'));
    if (n > 0) found.set(relative(API_ROOT, file).split(sep).join('/'), n);
  }
  return found;
}

describe('ServiceError answers under app/api go through serviceErrorResponse', () => {
  it('the detector counts a hand-written answer and nothing else', () => {
    expect(
      ownServiceErrorAnswers(`
        } catch (e) {
          if (e instanceof ServiceError) {
            const status = e.code === 'forbidden' ? 403 : 500;
            return NextResponse.json({ error: e.code, message: e.message }, { status });
          }
        }`),
    ).toBe(1);
    expect(
      ownServiceErrorAnswers(`
        } catch (e) {
          if (e instanceof ServiceError) {
            return NextResponse.json({ error: e.code, message: e.message }, { status: serviceErrorStatus(e.code) });
          }
          void reportError(e, { tag: 't' });
        }`),
    ).toBe(1);
    expect(
      ownServiceErrorAnswers(`
        if (e instanceof ServiceError && e.code === 'internal_error') return NextResponse.json(x, { status: 500 });`),
    ).toBe(1);
    expect(
      ownServiceErrorAnswers(`
        } catch (e) {
          // a comment that names instanceof ServiceError with status: 500
          if (e instanceof ServiceError && e.details?.reason === 'x') {
            revalidate(ctx.organizationId);
          }
          if (!(shareErr instanceof ServiceError)) throw shareErr;
          const message = e instanceof ServiceError ? e.message : 'Fixed.';
          void reportError(e instanceof ServiceError ? new Error(e.message) : e, { tag: 't' });
          return serviceErrorResponse(e, 'tag');
        }`),
    ).toBe(0);
  });

  it('a negated test that throws everything else counts the answer below it', () => {
    expect(
      ownServiceErrorAnswers(`
        } catch (e) {
          if (!(e instanceof ServiceError)) throw e;
          return NextResponse.json({ error: e.code }, { status: 409 });
        }`),
    ).toBe(1);
    expect(
      ownServiceErrorAnswers(`
        } catch (e) {
          if (!(e instanceof ServiceError)) {
            throw e;
          }
          return NextResponse.json({ error: e.code }, { status: 409 });
        }`),
    ).toBe(1);
  });

  it('no route renames ServiceError, and only listed files call serviceErrorStatus', () => {
    const { aliases, statusCallers } = scanOther();
    expect(aliases).toEqual([]);
    expect(statusCallers.filter((f) => !OWN_ANSWERS[f])).toEqual([]);
  });

  it('every hand-written answer is listed, with the count in its file', () => {
    const found = scan();
    const unlisted = [...found.entries()]
      .filter(([file, n]) => OWN_ANSWERS[file]?.branches !== n)
      .map(([file, n]) => `${file}: ${n} (listed ${OWN_ANSWERS[file]?.branches ?? 0})`);
    expect(unlisted).toEqual([]);
  });

  it('every listed file still has the answers it is listed for, and a reason', () => {
    const found = scan();
    const stale = Object.entries(OWN_ANSWERS)
      .filter(
        ([file, { branches, reason }]) => found.get(file) !== branches || reason.trim().length < 20,
      )
      .map(([file]) => file);
    expect(stale).toEqual([]);
  });
});
