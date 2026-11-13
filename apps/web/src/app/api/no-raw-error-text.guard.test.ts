import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Security invariant (docket S16, S31): no API route and no Server Action
 * answers an error's own text.
 *
 * A route's last catch used to answer anything that was not a ServiceError
 * with `e instanceof Error ? e.message : ...`, and a few branches answered a
 * Supabase or Storage `error.message` without a catch. The caller then read
 * whatever the error said: a TypeError naming the server's property paths,
 * Postgres text naming tables, columns and row-level security policies, a
 * Storage error naming the bucket, an AI vendor's quota or billing text, a
 * failed request's URL with its token. Many of those branches reported
 * nothing, so the answer was the only copy of the error. They now answer
 * through server/lib/api-error-response.ts: a fixed sentence to the caller,
 * the error itself to reportError with the route's tag. Server Actions had the
 * same catches (`return err('internal_error', e instanceof Error ? e.message :
 * ...)`), and a Server Action's returned result reaches the browser as it is:
 * they answer through server/lib/action-error-result.ts (S31).
 *
 * WHAT IS READ, in three scopes, each with its own list:
 *   - API: every module under app/api, every response helper (http.ts,
 *     *-http.ts, *error-response.ts, export-errors.ts) anywhere in src, and
 *     every module an API route imports directly (`@/...` or a relative path,
 *     by import, export-from or import()): a helper builds text a route
 *     answers as it is (the AI ISBN extract's `notes` did, S16 review). Also
 *     every lib/ai module those lib/ai modules import, all the way down: the
 *     AI chat hands a tool's result to the model, and the model's reply is
 *     answered (lib/ai/tools.ts, S31 review). Not server/services nor
 *     server/actions: they have their own scopes.
 *   - Server Actions: every module under server/actions, every module whose
 *     first statement (or a function's first statement) is 'use server', and
 *     every module they import directly outside server/services. A Server
 *     Action's returned result reaches the browser as it is.
 *   - Services: every module under server/services, and what they import that
 *     neither other scope reads. Actions and routes answer a non-internal
 *     ServiceError's words, and some service results, as they are.
 * A module that builds a non-internal ServiceError or a ForbiddenError (its
 * words are answered) is read by one of them (the coverage test).
 *
 * WHAT COUNTS, from the TypeScript syntax tree (so comments and strings are
 * never code): an error's own text, wherever it is spelled
 *
 *   e.message, err?.stack, (e as Error).message, (e as any).message, e['message']
 *   String(e), e.toString(), JSON.stringify(e), `${e}`, 'failed: ' + e
 *   const { message } = e as Error
 *   NextResponse.json({ error }), { detail: err }, { ...err }   (a whole error in an answer)
 *   rawErrorText(x), nonErrorText(x), postgrestErrorText(x), reportedMessage(x),
 *   asReportableError(x).message   (the error-to-text helpers: ERROR_TEXT_HELPERS)
 *
 * where an error is a catch clause's binding or a rejection handler's
 * parameter (whatever its name), a name such as e, err, error, uploadErr,
 * pgError (also as a property: res.error.message), a const whose value is one
 * of those (`const failure = asReportableError(e)`, `const thrown = e as
 * Error`; S31 review), or a parameter that a call by the function's name in
 * the same file passes one of those or asReportableError(...) (a helper such
 * as `rollbackClaim(original)`). The text is followed through what keeps it
 * text: casts, string methods, `??`, `||`, `&&`, `+`, a branch of `?:`, a
 * template. Also counted (S31):
 *
 *   { message: res.error ?? 'x' }   an error-named field used as answer text:
 *                                   in an API route, inside NextResponse.json
 *                                   or Response.json; elsewhere, in an object
 *                                   that is returned, thrown or passed to err()
 *                                   or ok(), and as err()'s message; in every
 *                                   scope, as the words of a ServiceError other
 *                                   than internal_error, of a ForbiddenError
 *                                   (actions and routes answer those as they
 *                                   are) or of a ToolRefusal (the AI chat's
 *                                   model reads those as they are, S30); a
 *                                   name that holds an error counts there too
 *                                   (S31 review)
 *   .catch(nonErrorText), .map(rawErrorText), const d = rawErrorText
 *                                   an error-to-text helper used as a value,
 *                                   not called (S31 review)
 *   'Server is missing FOO_KEY'     a literal naming a server setting (FOO_KEY,
 *                                   FOO_SECRET, FOO_TOKEN, FOO_PASSWORD, .env,
 *                                   .env.local, env vars, Vercel env)
 *
 * Also counted (S30 review):
 *
 *   error.hint, error.details, e.internalDetail
 *                                   what else an error says about itself: in
 *                                   the words of a ServiceError other than
 *                                   internal_error, of a ForbiddenError or of
 *                                   a ToolRefusal in every scope, and anywhere
 *                                   under lib/ai. internalDetail is the
 *                                   database's text S13 keeps on the server,
 *                                   so it counts on any value, proved an app
 *                                   error or not
 *   return { error }, return { ok: false, failure: e }, throw { ...err },
 *   return { note: res.error }      under lib/ai only: a whole error, or an
 *                                   error field, in an object that is returned
 *                                   or thrown. What a tool returns is the
 *                                   model's input, and the model's reply is
 *                                   answered
 *
 * WHAT THE MODEL CAN READ OF A REFUSAL (S30 review), the last part of this
 * file: the AI chat tells the model about a failed tool by the error's type
 * and code, and passes a service's own words for validation_error only. Every
 * validation_error message an AI tool can reach that is not a fixed sentence
 * is listed there with what is put into it and why, with the ServiceError
 * codes the tools can reach. Reachability is read with TypeScript's type
 * checker, from every function in lib/ai/tools.ts.
 *
 * WHAT DOES NOT COUNT: text that goes only to the server, or becomes a yes or
 * no. Inside `new Error(...)` (it is only thrown or reported, and every catch
 * that answers is held to these same rules), `new ServiceError('internal_error',
 * ...)` (S13 keeps that text server side), `reportError(...)` and
 * `console.*(...)`; tested with `.includes()`, `.startsWith()`, a RegExp's
 * `.test()`, `===`, `.length`, `!` or `typeof`, or as a condition (`if`,
 * `while`, the test of `?:`); read after `instanceof ServiceError`,
 * `instanceof ForbiddenError`, `instanceof PermissionsUnavailableError`,
 * `instanceof AccountStatusUnavailableError` or `instanceof ToolRefusal` (the
 * app wrote those words); or
 * held in a const (or a destructured name) whose every use is one of these.
 * The left side of `=` is a write, never a read.
 *
 * Every remaining line is listed below with why it is safe, so a new one
 * fails here until someone reasons about it.
 */

const SRC = path.resolve(__dirname, '../..');
const API = path.join(SRC, 'app/api');
const ACTIONS = path.join(SRC, 'server/actions');
const SERVICES = path.join(SRC, 'server/services');
const AI = path.join(SRC, 'lib/ai');

/** Response helpers outside app/api answer API callers too. */
const RESPONSE_HELPER = /^(?:.+-)?http\.ts$|^(?:.+-)?error-response\.ts$|^export-errors\.ts$/;

/** Imported by routes, but read in their own scopes: see WHAT IS READ above. */
const NOT_READ = /^server\/(?:services|actions)\//;

/**
 * Files allowed to keep the shapes, with the number of lines and the reason.
 * Each line was read: none of them reaches an API caller.
 */
const ALLOWED: Record<string, { lines: number; why: string }> = {
  'app/api/admin/backfill-item-thumbs/route.ts': {
    lines: 3,
    why: "per-row results for the BACKFILL_ADMIN_SECRET holder, who needs them to diagnose a row (kept by the owner's default, S16 decision 2); the route's own failures answer through the helper",
  },
  'app/api/v1/mobile/snapshot/route.ts': {
    lines: 1,
    why: "the items read's failure, which goes to dbError: it reports the text and answers only the query's name",
  },
  'app/api/po-imports/scan/route.ts': {
    lines: 1,
    why: "namesResult.error: parseDisplayNames' own sentences about the file names the caller sent, never an error's text",
  },
  'lib/ai/embeddings.ts': {
    lines: 6,
    why: "errorText's body and its three callers, read here through the AI tools (S31 review), and the batch result that carries firstError whole (S30 review): the text feeds console lines and a batch's firstError, which only the hourly sweep cron answers (to the CRON_SECRET holder); the backfill tool picks the counts out of the result and never returns it, and a failed query embedding is reported, never handed to the model",
  },
  'lib/auth/public-api.ts': {
    lines: 1,
    why: "withApiKey's refusal (result.error): its own sentences and codes for a missing, unknown, revoked or limited key (lib/auth/api-key.ts)",
  },
  'lib/email/resend.ts': {
    lines: 1,
    why: "sendEmail's result for its caller: the API routes and the helpers they import count it or report it, never answer it",
  },
  'server/connectors/drainer.ts': {
    lines: 1,
    why: "a connector call's failure, stored in the sync log's last_error for the organization's integration status; the drain cron answers counts only",
  },
  'server/connectors/quickbooks/index.ts': {
    lines: 3,
    why: "the QuickBooks call's failure for the drainer, which stores it as last_error (above)",
  },
  'server/lib/account-deletion.ts': {
    lines: 4,
    why: 'readAuthEmail and soleOwnedOrganizationsWithMembers hand a failed read to the delete route, which reports it and answers ACCOUNT_DELETE_RETRY_COPY',
  },
  'server/loaders/inventory-list.ts': {
    lines: 2,
    why: "prewarmInventoryList's per-view failure, in the prewarm cron's results: answered only to the CRON_SECRET or BACKFILL_ADMIN_SECRET holder, and the deploy hook does not print the body",
  },
  'server/loaders/orders-new-catalog.ts': {
    lines: 1,
    why: "prewarmOrdersNewCatalog's photo map failure, in the prewarm cron's results (see inventory-list.ts above)",
  },
  'server/loaders/orders-phone-catalog.ts': {
    lines: 1,
    why: "prewarmPhoneThumbMap's failure, in the prewarm cron's results (see inventory-list.ts above)",
  },
};

/**
 * The Server Action scope's lines (S31), with the number of lines and the
 * reason. Each line was read: none of them reaches a person as it is, except
 * the two listed for D3a, which fixes them with its own tests.
 */
const ALLOWED_ACTIONS: Record<string, { lines: number; why: string }> = {
  'lib/ai/embeddings.ts': {
    lines: 5,
    why: "errorText's body and its three callers: the text feeds console lines and a batch's firstError, which only the hourly sweep cron answers (to the CRON_SECRET holder); the backfill action and the AI tool answer counts only",
  },
  'lib/email/resend.ts': {
    lines: 1,
    why: "sendEmail's result: digest.ts reports it and answers EMAIL_NOT_SENT_MESSAGE; platform-admin.ts reports it and answers its own sentence",
  },
  'server/actions/auth.ts': {
    lines: 1,
    why: "changePasswordAction's GoTrue refusal: docket D3a replaces it with B50's classifier and its own tests; listed until then, so a second line still fails",
  },
  'server/actions/email-routing-settings.ts': {
    lines: 1,
    why: "the recipient guard's own sentence about an address the admin typed (packages/core email/org-email-routing.ts and outlook-compose.ts), never an error's text",
  },
  'server/actions/team.ts': {
    lines: 2,
    why: "transferRefusal compares transfer_org_ownership's own RAISE text (0393) and answers the action's sentences; acceptInviteWithSignupAction's createUser refusal: docket D3a maps it (an existing email, a weak password) with its own tests; listed until then",
  },
  'server/lib/account-deletion.ts': {
    lines: 4,
    why: 'a failed read handed to its callers: profile.ts and platform-admin.ts report it and answer their own sentences, never this text',
  },
  'server/loaders/inventory-list.ts': {
    lines: 2,
    why: "prewarmInventoryList's per-view failure, which only the prewarm cron calls; actions import the module for revalidateInventoryListForCurrentOrg",
  },
};

/**
 * The service scope's lines (S31), with the number of lines and the reason.
 * Each line was read: it stays on the server, or is a mapper whose answers are
 * the app's own sentences.
 */
const ALLOWED_SERVICES: Record<string, { lines: number; why: string }> = {
  'server/services/bundles.ts': {
    lines: 4,
    why: "undoCreate's failure goes only into reportError's extra; the assemble and distribute mappers turn our RAISE codes into app sentences (kitRefusal) and anything else into internal_error",
  },
  'server/services/connections.ts': {
    lines: 4,
    why: "the connection's stored last_error, shown to the organization's admins who manage it (as drainer.ts in the API list)",
  },
  'server/services/cycle-counts.ts': {
    lines: 2,
    why: 'the start and post mappers match our RAISE codes and answer app sentences, else internal_error',
  },
  'server/services/inventory.ts': {
    lines: 4,
    why: "moveSeededStockToUnplaced's local report() (3): its argument goes only to reportError(new Error(detail)) at warning level; the dialog answers locationName null. assertCustomFieldsValid (1): validateCustomFields' result.error is the validator's own sentence about a field the person filled in (packages/core customization/custom-fields.ts), never an error's text",
  },
  'server/services/integration-events.ts': {
    lines: 2,
    why: "DispatchStepError's message for a failed endpoints read or deliveries insert: thrown inside withDispatchRetries and only reported by dispatch's catch; dispatch answers nothing",
  },
  'server/services/opening-stock-compensation.ts': {
    lines: 1,
    why: "verifyErr: a failed re-read's text, only in the console.error line; the thrown ServiceError is internal_error with the app's own sentence",
  },
  'server/services/po-imports.ts': {
    lines: 3,
    why: "archiveImportCreatedItems' local skip(): its message goes only to reportError(new Error(message)); cancelling the import answers nothing about it",
  },
  'server/services/exception-recount.ts': {
    lines: 1,
    why: 'mapRecountError matches our RAISE codes and hints and answers app sentences, else internal_error',
  },
  'lib/error-text.ts': {
    lines: 1,
    why: 'reportedMessage is the text an error report carries (docket C21): read only by lib/error-reporter-core.ts, never answered',
  },
  'lib/ssrf-guard.ts': {
    lines: 1,
    why: "a failed host lookup's text in SsrfLookupFailedError, for the server: the webhook test and the ISBN lookup answer their own sentences",
  },
  'server/services/lib/fetch-by-ids.ts': {
    lines: 5,
    why: "rawErrorText's body (2) is for server logs: every caller passes it to reportError, new Error or an internal_error ServiceError; writeInIdBatches' result.error (2) and settleAsDataError's error.message (1) are read by callers as a database error field, which this census counts wherever it is answered: a returned or thrown object, a JSON body, err(), and a non-internal ServiceError's or a ForbiddenError's words (S31 review); every caller today passes it only to an internal_error ServiceError, reportError, new Error or console",
  },
  'server/services/lib/postgrest-error.ts': {
    lines: 1,
    why: 'postgrestErrorText feeds internal_error ServiceErrors, reports and console lines only',
  },
  'server/services/notification-preferences.ts': {
    lines: 2,
    why: 'the write results for their actions: digest.ts and notification-preferences.ts report the text and answer their own sentences',
  },
  'server/services/order-readiness.ts': {
    lines: 2,
    why: "failureMessage answers a ServiceError's words after its non-ServiceError return; shortfallPoRpcError matches our RAISE text",
  },
  'server/services/order-requests.ts': {
    lines: 7,
    why: "orderGuardRefusal answers only the guard's own sentences; the needed-by mapper matches our RAISE text; three go to the local report(); one is a ServiceError's words; addLinesRefusal words a closed order with its status, the DETAIL of our own order_closed refusal (0413), never an error's text (S30 review)",
  },
  'server/services/public-catalog.ts': {
    lines: 2,
    why: 'reportDegradedRead: a degraded read is reported, and the public page answers without the part',
  },
  'server/services/purchase-orders.ts': {
    lines: 1,
    why: 'saveDraftRpcError: our hints and our RAISE text (0366), else internal_error',
  },
  'server/services/receiving.ts': {
    lines: 1,
    why: "our RAISE text for a kit's pre-assembled stock (hint po_line_bundle), written for people",
  },
  'server/services/rentals.ts': {
    lines: 1,
    why: 'hint rental_invalid answers our RAISE text; anything else maps to app sentences or internal_error',
  },
  'server/services/returns.ts': {
    lines: 1,
    why: "a ServiceError's words, after the step's catch rethrows anything that is not one",
  },
  'server/services/schedule.ts': {
    lines: 1,
    why: "distribute_bundle's text is tested for the duplicate and handed to kitRefusal, which answers app sentences or nothing",
  },
};

interface Hit {
  line: number;
  text: string;
}

// ── What is read ─────────────────────────────────────────────────────────

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')
      ? [full]
      : [];
  });
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** The source file an `@/...` or relative specifier in `from` names, or null (a package). */
function moduleFile(specifier: string, from: string): string | null {
  const base = specifier.startsWith('@/')
    ? path.join(SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? path.resolve(path.dirname(from), specifier)
      : null;
  if (base === null) return null;
  const candidates = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  if (/\.tsx?$/.test(base)) candidates.unshift(base);
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

/** The source modules a file imports: import and export-from, and import(). */
function importsOf(file: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file, readFileSync(file, 'utf8')));
  return out.flatMap((specifier) => moduleFile(specifier, file) ?? []);
}

/** Every module the census reads (see WHAT IS READ). */
function scope(): string[] {
  return (SCOPES.api ??= apiScope());
}

const SCOPES: { api?: string[]; actions?: string[] } = {};

function apiScope(): string[] {
  const api = files(API);
  const helpers = files(SRC).filter(
    (file) => !file.startsWith(API + path.sep) && RESPONSE_HELPER.test(path.basename(file)),
  );
  const imported = api
    .flatMap(importsOf)
    .filter(
      (file) =>
        file.startsWith(SRC + path.sep) &&
        !file.startsWith(API + path.sep) &&
        !/\.test\.tsx?$/.test(file) &&
        !NOT_READ.test(path.relative(SRC, file)),
    );
  // The AI chat's model loop (S31 review): a tool's result goes into the
  // model's context and the model's reply is answered, so every lib/ai module
  // the read lib/ai modules import, and what those import, is read too.
  const read = new Set([...api, ...helpers, ...imported]);
  const pending = [...read].filter((file) => file.startsWith(AI + path.sep));
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    for (const next of importsOf(file)) {
      if (next.startsWith(AI + path.sep) && !/\.test\.tsx?$/.test(next) && !read.has(next)) {
        read.add(next);
        pending.push(next);
      }
    }
  }
  return [...read];
}

/** A 'use server' directive as the first of `statements`. */
function startsUseServer(statements: ts.NodeArray<ts.Statement>): boolean {
  const first = statements[0];
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use server'
  );
}

/** Whether the module, or a function in it, starts with 'use server'. */
function isServerActionModule(file: string): boolean {
  const source = readFileSync(file, 'utf8');
  if (!source.includes('use server')) return false;
  const sf = parse(file, source);
  if (startsUseServer(sf.statements)) return true;
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      isFunction(node) &&
      node.body &&
      ts.isBlock(node.body) &&
      startsUseServer(node.body.statements)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Every Server Action module and what it imports outside server/services (see WHAT IS READ). */
function actionScope(): string[] {
  return (SCOPES.actions ??= readActionScope());
}

function readActionScope(): string[] {
  const modules = [
    ...files(ACTIONS),
    ...files(SRC).filter(
      (file) => !file.startsWith(ACTIONS + path.sep) && isServerActionModule(file),
    ),
  ];
  const imported = modules
    .flatMap(importsOf)
    .filter(
      (file) =>
        file.startsWith(SRC + path.sep) &&
        !file.startsWith(SERVICES + path.sep) &&
        !/\.test\.tsx?$/.test(file),
    );
  return [...new Set([...modules, ...imported])];
}

/**
 * Every service module, and what services import that neither other scope
 * reads (lib/po-scan/extract.ts builds a refusal the scan route answers).
 */
function serviceScope(): string[] {
  const services = files(SERVICES);
  const elsewhere = new Set([...scope(), ...actionScope()]);
  const imported = services
    .flatMap(importsOf)
    .filter(
      (file) =>
        file.startsWith(SRC + path.sep) &&
        !file.startsWith(SERVICES + path.sep) &&
        !file.startsWith(ACTIONS + path.sep) &&
        !/\.test\.tsx?$/.test(file) &&
        !elsewhere.has(file),
    );
  return [...new Set([...services, ...imported])];
}

// ── What holds an error ──────────────────────────────────────────────────

const ERROR_NAME = /^(?:e|err|error|ex)$|(?:Err|Error|err|error)$/;
const TEXT_PROPERTIES = new Set(['message', 'stack']);
/**
 * What else an error says about itself (S30 review): a database error's
 * `hint` and `details`, and a ServiceError's `internalDetail`, the database's
 * text that S13 keeps on the server. They count as the error's text in the
 * words of an app error (every scope) and anywhere under lib/ai. Reading
 * `hint` or `details` off a proved app error does not count (a ServiceError's
 * `details` is the object the app built); `internalDetail` always does, on
 * any value.
 */
const DETAIL_PROPERTIES = new Set(['hint', 'details']);
const SERVER_ONLY_PROPERTY = 'internalDetail';
/**
 * Classes whose message the app wrote (ServiceError: generic for internal_error,
 * S13). PermissionsUnavailableError and AccountStatusUnavailableError pass one
 * fixed sentence to super and take no argument (pinned below). ToolRefusal
 * (lib/ai/tool-errors.ts, S30) is an AI chat tool's refusal in the tool's own
 * words, which the model reads: it is built only under lib/ai (pinned below),
 * and its words are held to the same rule as a ServiceError's.
 */
const APP_ERRORS = new Set([
  'ServiceError',
  'ForbiddenError',
  'PermissionsUnavailableError',
  'AccountStatusUnavailableError',
  'ToolRefusal',
]);
const BUILTIN_ERRORS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError']);
/**
 * Helpers that turn an error (or any value) into its text, so their result is
 * an error's own text whatever their argument is named (S31 guard helpers):
 *   rawErrorText        server/services/lib/fetch-by-ids.ts: a ServiceError's
 *                       internalDetail, else the message, else nonErrorText
 *   nonErrorText        lib/error-text.ts: a non-Error's message, code and hint
 *   postgrestErrorText  server/services/lib/postgrest-error.ts: a PostgREST
 *                       error's message, else its status, code, details, hint
 *   reportedMessage     lib/error-text.ts: an internal error's internalDetail
 *   errorText           lib/ai/embeddings.ts (module-local): a PostgREST
 *                       error's message, else String(value)
 * Their bodies are listed below with their reasons; this set holds their
 * callers to the same rules. Never narrowed by `instanceof ServiceError`:
 * rawErrorText and reportedMessage of a ServiceError are its internalDetail.
 * A call by an imported alias (`import { nonErrorText as t }`) or through a
 * namespace (`errorText.nonErrorText(e)`) counts too.
 */
const ERROR_TEXT_HELPERS = new Set([
  'rawErrorText',
  'nonErrorText',
  'postgrestErrorText',
  'reportedMessage',
  'errorText',
]);
/**
 * Helpers whose result is an error: `.message`, `.stack`, String() of it are
 * its text. asReportableError (lib/error-text.ts) gives a non-Error a message
 * built by nonErrorText.
 */
const ERROR_VALUE_HELPERS = new Set(['asReportableError']);
/** String methods whose result is still the text. */
const TEXT_METHODS = new Set([
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'trim',
  'trimStart',
  'trimEnd',
  'slice',
  'substring',
  'substr',
  'replace',
  'replaceAll',
  'normalize',
  'padStart',
  'padEnd',
  'concat',
  'at',
  'charAt',
]);
/** String methods whose result is a yes or no, or a position. */
const TEST_METHODS = new Set([
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'lastIndexOf',
  'search',
  'localeCompare',
]);
const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
/** `a ?? b`, `a || b`, `a && b`, `a + b`: the result can be (or hold) either side's text. */
const TEXT_OPERATORS = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.PlusToken,
]);

function isWrapper(
  node: ts.Node,
): node is
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.NonNullExpression
  | ts.TypeAssertion
  | ts.SatisfiesExpression {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (isWrapper(current)) current = current.expression;
  return current;
}

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function binds(name: ts.BindingName | undefined, text: string): boolean {
  if (!name) return false;
  if (ts.isIdentifier(name)) return name.text === text;
  return name.elements.some((el) => !ts.isOmittedExpression(el) && binds(el.name, text));
}

/** A function handed to `.catch(fn)` or as `.then(_, fn)`: its parameter is the rejection. */
function isRejectionHandler(fn: ts.Node): boolean {
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) {
    return false;
  }
  const method = call.expression.name.text;
  return (
    (method === 'catch' && call.arguments[0] === fn) ||
    (method === 'then' && call.arguments[1] === fn)
  );
}

/** Whether the nearest declaration of `id` binds a thrown or rejected value. */
function bindsAThrow(id: ts.Identifier): boolean {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (ts.isCatchClause(n) && binds(n.variableDeclaration?.name, id.text)) return true;
    if (isFunction(n) && n.parameters.some((p) => binds(p.name, id.text))) {
      return isRejectionHandler(n);
    }
    if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) {
      const declares = n.statements.some(
        (st) =>
          (ts.isVariableStatement(st) &&
            st.declarationList.declarations.some((d) => binds(d.name, id.text))) ||
          (ts.isFunctionDeclaration(st) && st.name?.text === id.text),
      );
      if (declares) return false;
    }
  }
  return false;
}

/** Whether `node` holds an error (see the header). */
function isError(node: ts.Expression): boolean {
  const x = unwrap(node);
  if (ts.isIdentifier(x)) {
    return bindsAThrow(x) || ERROR_NAME.test(x.text) || isErrorParameter(x) || holdsAnError(x);
  }
  if (ts.isPropertyAccessExpression(x)) return isErrorField(x);
  if (ts.isCallExpression(x)) return callsHelper(x, ERROR_VALUE_HELPERS);
  return false;
}

/** Declarations being followed by holdsAnError, so `const a = b; const b = a` ends. */
const FOLLOWING = new Set<ts.Node>();

/**
 * Whether the nearest declaration of `id` is a const whose value is an error
 * (`const failure = asReportableError(e)`, `const thrown = e as Error`), S31
 * review.
 */
function holdsAnError(id: ts.Identifier): boolean {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (ts.isCatchClause(n) && binds(n.variableDeclaration?.name, id.text)) return false;
    if (isFunction(n) && n.parameters.some((p) => binds(p.name, id.text))) return false;
    if (!(ts.isBlock(n) || ts.isSourceFile(n) || ts.isCaseClause(n) || ts.isDefaultClause(n))) {
      continue;
    }
    for (const st of n.statements) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === id.text) return false;
      if (!ts.isVariableStatement(st)) continue;
      const decl = st.declarationList.declarations.find((d) => binds(d.name, id.text));
      if (!decl) continue;
      if (
        (st.declarationList.flags & ts.NodeFlags.Const) === 0 ||
        !ts.isIdentifier(decl.name) ||
        !decl.initializer ||
        FOLLOWING.has(decl)
      ) {
        return false;
      }
      FOLLOWING.add(decl);
      try {
        return isError(decl.initializer);
      } finally {
        FOLLOWING.delete(decl);
      }
    }
  }
  return false;
}

const HELPER_ALIASES = new WeakMap<ts.SourceFile, Map<string, string>>();

/** Local name -> helper name for every import of a helper under another name. */
function helperAliases(sf: ts.SourceFile): Map<string, string> {
  const cached = HELPER_ALIASES.get(sf);
  if (cached) return cached;
  const aliases = new Map<string, string>();
  for (const st of sf.statements) {
    const bindings = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if (el.propertyName && ts.isIdentifier(el.propertyName)) {
        aliases.set(el.name.text, el.propertyName.text);
      }
    }
  }
  HELPER_ALIASES.set(sf, aliases);
  return aliases;
}

/** A call of one of `helpers`: by name, by an imported alias, or through a namespace. */
function callsHelper(call: ts.CallExpression, helpers: Set<string>): boolean {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) {
    const name = helperAliases(call.getSourceFile()).get(callee.text) ?? callee.text;
    return helpers.has(name);
  }
  return ts.isPropertyAccessExpression(callee) && helpers.has(callee.name.text);
}

/** Whether `node` is a callee: `node(...)`, also through casts and parentheses. */
function isCallee(node: ts.Node): boolean {
  let n = node;
  while (n.parent && isWrapper(n.parent)) n = n.parent;
  return n.parent !== undefined && ts.isCallExpression(n.parent) && n.parent.expression === n;
}

/**
 * An error-to-text helper used as a value instead of called: handed on as a
 * function (`.catch(nonErrorText)`, `.map(rawErrorText)`), or given another
 * name (`const describe = rawErrorText`), S31 review. Not its import, export
 * or declaration, a type (`typeof rawErrorText`), or a property's key.
 */
function isHelperReference(node: ts.Node): boolean {
  if (isCallee(node)) return false;
  if (ts.isPropertyAccessExpression(node)) return ERROR_TEXT_HELPERS.has(node.name.text);
  if (!ts.isIdentifier(node)) return false;
  const name = helperAliases(node.getSourceFile()).get(node.text) ?? node.text;
  if (!ERROR_TEXT_HELPERS.has(name)) return false;
  const p = node.parent;
  if (
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    ts.isTypeQueryNode(p) ||
    ts.isQualifiedName(p)
  ) {
    return false;
  }
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
  if (
    (ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p)) &&
    p.name === node
  ) {
    return false;
  }
  if (ts.isBindingElement(p) && (p.name === node || p.propertyName === node)) return false;
  return true;
}

/** Where a helper used as a value takes its text: the call it is handed to, else itself. */
function helperUse(node: ts.Node): ts.Node {
  let n = node;
  while (n.parent && isWrapper(n.parent)) n = n.parent;
  const p = n.parent;
  return p && ts.isCallExpression(p) && p.arguments.includes(n as ts.Expression) ? p : n;
}

/** `res.error`, `result.lastError`: a property named as an error. */
function isErrorField(node: ts.Expression): node is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(node) && ERROR_NAME.test(node.name.text) && node.name.text !== 'e'
  );
}

/** The name a call uses for a function declared as `fn`, or null. */
function functionName(fn: ts.FunctionLikeDeclaration): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
    return ts.isIdentifier(fn.name) ? fn.name.text : null;
  }
  if (
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    ts.isVariableDeclaration(fn.parent) &&
    ts.isIdentifier(fn.parent.name)
  ) {
    return fn.parent.name.text;
  }
  return null;
}

const ERROR_SLOTS = new WeakMap<ts.SourceFile, Set<string>>();

/**
 * `name#index` for every call in the file that passes an error (a catch
 * binding, a rejection's parameter, an error-named value) at that position.
 */
function errorSlots(sf: ts.SourceFile): Set<string> {
  const cached = ERROR_SLOTS.get(sf);
  if (cached) return cached;
  const slots = new Set<string>();
  ERROR_SLOTS.set(sf, slots);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name) {
        node.arguments.forEach((arg, index) => {
          const x = unwrap(arg);
          if (
            (ts.isIdentifier(x) && (bindsAThrow(x) || ERROR_NAME.test(x.text))) ||
            (ts.isCallExpression(x) && callsHelper(x, ERROR_VALUE_HELPERS))
          ) {
            slots.add(`${name}#${index}`);
          }
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return slots;
}

/** A parameter that a call by its function's name, in the same file, passes an error. */
function isErrorParameter(id: ts.Identifier): boolean {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (!isFunction(n)) continue;
    const index = n.parameters.findIndex((p) => binds(p.name, id.text));
    if (index < 0) continue;
    const name = functionName(n);
    return name !== null && errorSlots(id.getSourceFile()).has(`${name}#${index}`);
  }
  return false;
}

function nameOf(node: ts.Expression): string | null {
  const x = unwrap(node);
  return ts.isIdentifier(x) ? x.text : null;
}

// ── Where the text goes ──────────────────────────────────────────────────

/** `cond` proves `name` is an app error: `name instanceof ServiceError`, also inside && / ||. */
function provesAppError(cond: ts.Expression, name: string): boolean {
  const c = unwrap(cond);
  if (!ts.isBinaryExpression(c)) return false;
  switch (c.operatorToken.kind) {
    case ts.SyntaxKind.InstanceOfKeyword:
      return nameOf(c.left) === name && ts.isIdentifier(c.right) && APP_ERRORS.has(c.right.text);
    case ts.SyntaxKind.AmpersandAmpersandToken:
      return provesAppError(c.left, name) || provesAppError(c.right, name);
    case ts.SyntaxKind.BarBarToken:
      return provesAppError(c.left, name) && provesAppError(c.right, name);
    default:
      return false;
  }
}

/** The read sits where `name` was proved an app error (if, ?:, &&). */
function narrowedToAppError(read: ts.Node, name: string | null): boolean {
  if (!name) return false;
  let child: ts.Node = read;
  for (let n = read.parent; n && !isFunction(n); child = n, n = n.parent) {
    if (ts.isIfStatement(n) && child === n.thenStatement && provesAppError(n.expression, name)) {
      return true;
    }
    if (
      ts.isConditionalExpression(n) &&
      child === n.whenTrue &&
      provesAppError(n.condition, name)
    ) {
      return true;
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      child === n.right &&
      provesAppError(n.left, name)
    ) {
      return true;
    }
  }
  return false;
}

/** From a text value up through what keeps it text. */
function textOf(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    const p = current.parent;
    if (!p) return current;
    if (isWrapper(p)) current = p;
    else if (
      ts.isPropertyAccessExpression(p) &&
      p.expression === current &&
      TEXT_METHODS.has(p.name.text) &&
      ts.isCallExpression(p.parent) &&
      p.parent.expression === p
    ) {
      current = p.parent;
    } else if (ts.isBinaryExpression(p) && TEXT_OPERATORS.has(p.operatorToken.kind)) current = p;
    else if (ts.isConditionalExpression(p) && p.condition !== current) current = p;
    else if (ts.isTemplateSpan(p) && p.expression === current) current = p.parent;
    else return current;
  }
}

/** A call that keeps its arguments on the server. */
function isServerSink(call: ts.Node, arg: ts.Node): boolean {
  if (ts.isNewExpression(call) && call.arguments?.includes(arg as ts.Expression)) {
    if (!ts.isIdentifier(call.expression)) return false;
    if (BUILTIN_ERRORS.has(call.expression.text)) return true;
    const first = call.arguments[0];
    return (
      call.expression.text === 'ServiceError' &&
      first !== undefined &&
      first !== arg &&
      ts.isStringLiteralLike(first) &&
      first.text === 'internal_error'
    );
  }
  if (ts.isCallExpression(call) && call.arguments.includes(arg as ts.Expression)) {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) return callee.text === 'reportError';
    return (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'console'
    );
  }
  return false;
}

/** Whether the text read at `read` goes only to the server, or becomes a yes or no. */
function staysOnServer(read: ts.Node, depth = 0): boolean {
  const node = textOf(read);
  const p = node.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.expression === node) {
    if (p.name.text === 'length') return true;
    if (TEST_METHODS.has(p.name.text) && ts.isCallExpression(p.parent)) return true;
  }
  if (
    ts.isCallExpression(p) &&
    p.arguments.includes(node as ts.Expression) &&
    ts.isPropertyAccessExpression(p.expression) &&
    p.expression.name.text === 'test'
  ) {
    return true;
  }
  if (ts.isBinaryExpression(p) && COMPARISONS.has(p.operatorToken.kind)) return true;
  if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isTypeOfExpression(p)) return true;
  if ((ts.isIfStatement(p) || ts.isWhileStatement(p)) && p.expression === node) return true;
  if (ts.isConditionalExpression(p) && p.condition === node) return true;
  let arg: ts.Node = node;
  for (
    let n: ts.Node | undefined = p;
    n && !isFunction(n) && !ts.isBlock(n);
    arg = n, n = n.parent
  ) {
    if (isServerSink(n, arg)) return true;
  }
  // A const that holds the text, or a name destructured from an error.
  if (depth < 4) {
    if (
      ts.isVariableDeclaration(p) &&
      p.initializer === node &&
      ts.isIdentifier(p.name) &&
      (ts.getCombinedNodeFlags(p) & ts.NodeFlags.Const) !== 0
    ) {
      return everyUseStaysOnServer(p.name, depth);
    }
    if (ts.isBindingElement(read) && ts.isIdentifier(read.name)) {
      return everyUseStaysOnServer(read.name, depth);
    }
  }
  return false;
}

function everyUseStaysOnServer(name: ts.Identifier, depth: number): boolean {
  let scopeNode: ts.Node = name.parent;
  while (!ts.isBlock(scopeNode) && !ts.isSourceFile(scopeNode) && !isFunction(scopeNode)) {
    scopeNode = scopeNode.parent;
  }
  const uses: ts.Identifier[] = [];
  const visit = (n: ts.Node) => {
    // A type (`{ message?: unknown }`) names a property, never the value.
    if (ts.isTypeNode(n)) return;
    if (ts.isIdentifier(n) && n.text === name.text && n !== name) {
      const p = n.parent;
      const isKey =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isBindingElement(p) && p.propertyName === n) ||
        (ts.isJsxAttribute(p) && p.name === n);
      if (!isKey) uses.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(scopeNode);
  return uses.every(
    (use) => !ts.isShorthandPropertyAssignment(use.parent) && staysOnServer(use, depth + 1),
  );
}

/** From an object literal up through the literals that hold it: [outermost, what holds that]. */
function literalOwner(literal: ts.Node): [ts.Node, ts.Node | undefined] {
  let child = literal;
  let n = literal.parent;
  while (
    n &&
    (ts.isObjectLiteralExpression(n) ||
      ts.isArrayLiteralExpression(n) ||
      ts.isPropertyAssignment(n) ||
      ts.isShorthandPropertyAssignment(n) ||
      ts.isSpreadAssignment(n) ||
      isWrapper(n))
  ) {
    child = n;
    n = n.parent;
  }
  return [child, n];
}

/** An object literal that is (inside) the body of `NextResponse.json(...)` or `Response.json(...)`. */
function isJsonAnswer(literal: ts.Node): boolean {
  const [child, n] = literalOwner(literal);
  if (!n || !ts.isCallExpression(n) || n.arguments[0] !== child) return false;
  const callee = n.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'json' &&
    ts.isIdentifier(callee.expression) &&
    (callee.expression.text === 'NextResponse' || callee.expression.text === 'Response')
  );
}

/**
 * An object literal that is (inside) what a function returns or throws, or an
 * argument of err() or ok(): a Server Action's result, or a service's result
 * that an action returns.
 */
function isReturnedAnswer(literal: ts.Node): boolean {
  const [child, n] = literalOwner(literal);
  if (!n) return false;
  if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) return true;
  if (ts.isArrowFunction(n) && n.body === child) return true;
  return (
    ts.isCallExpression(n) &&
    ts.isIdentifier(n.expression) &&
    (n.expression.text === 'err' || n.expression.text === 'ok')
  );
}

/** The values `a ?? b`, `a || b` and `c ? a : b` can be. */
function answerSides(node: ts.Expression): ts.Expression[] {
  const x = unwrap(node);
  if (
    ts.isBinaryExpression(x) &&
    (x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      x.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return [...answerSides(x.left), ...answerSides(x.right)];
  }
  if (ts.isConditionalExpression(x))
    return [...answerSides(x.whenTrue), ...answerSides(x.whenFalse)];
  return [x];
}

/** A server setting's name: FOO_KEY, FOO_SECRET, FOO_TOKEN, FOO_PASSWORD, .env, env vars, Vercel env. */
const SETTING_NAME =
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:KEY|SECRET|TOKEN|PASSWORD)\b|\.env(?:\.local)?\b|\benv vars?\b|\bVercel (?:project )?env\b/;

/** A literal's text, a template's literal parts joined. */
function literalText(
  node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression,
): string {
  return ts.isTemplateExpression(node)
    ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ')
    : node.text;
}

/** A literal that names something instead of being text: a key, a module, a type. */
function isNameLiteral(node: ts.Node): boolean {
  const p = node.parent;
  return (
    (ts.isElementAccessExpression(p) && p.argumentExpression === node) ||
    ts.isImportDeclaration(p) ||
    ts.isExportDeclaration(p) ||
    ts.isExternalModuleReference(p) ||
    ts.isLiteralTypeNode(p) ||
    (ts.isPropertyAssignment(p) && p.name === node)
  );
}

/** The left side of `=`: a write, never a read. */
function isWriteTarget(node: ts.Node): boolean {
  let n = node;
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isNonNullExpression(n.parent))) {
    n = n.parent;
  }
  const p = n.parent;
  return (
    p !== undefined &&
    ts.isBinaryExpression(p) &&
    p.left === n &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

// ── The census ───────────────────────────────────────────────────────────

/**
 * api: the answer-field rule reads JSON bodies only (a route's other objects
 * go to its own helpers, such as the snapshot's dbError). actions and
 * services: what a function returns or throws, and err().
 */
type Scope = 'api' | 'actions' | 'services';

/**
 * A module under lib/ai. What it returns can be a tool's result, which the
 * model reads as it is, so the API scope holds it to three more rules (S30
 * review): an error placed whole into a returned or thrown object, an error
 * field as a returned object's value, and an error's `hint`, `details` and
 * `internalDetail` as its text.
 */
function isAiModule(fileName: string): boolean {
  return fileName.startsWith(AI + path.sep);
}

/** `x.hint`, `x.details` of an error, or `x.internalDetail` of anything: a read, not a test. */
function isDetailRead(node: ts.Node): node is ts.PropertyAccessExpression {
  if (!ts.isPropertyAccessExpression(node) || isWriteTarget(node)) return false;
  if (node.name.text === SERVER_ONLY_PROPERTY) return !staysOnServer(node);
  return (
    DETAIL_PROPERTIES.has(node.name.text) &&
    isError(node.expression) &&
    !narrowedToAppError(node, nameOf(node.expression)) &&
    !staysOnServer(node)
  );
}

/** The lines of `source` that answer, or may answer, an error's own text. */
function hitsIn(fileName: string, source: string, scope: Scope = 'api'): Hit[] {
  const sf = parse(fileName, source);
  const ai = scope === 'api' && isAiModule(fileName);
  const lines = new Set<number>();
  const hit = (node: ts.Node) =>
    lines.add(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
  const text = (node: ts.Node, error: ts.Expression) => {
    if (isWriteTarget(node)) return;
    if (!narrowedToAppError(node, nameOf(error)) && !staysOnServer(node)) hit(node);
  };
  /** An object literal whose values are answered: a JSON body, or what an AI module returns. */
  const isAnswer = (literal: ts.Node) =>
    scope === 'api'
      ? isJsonAnswer(literal) || (ai && isReturnedAnswer(literal))
      : isReturnedAnswer(literal);
  /** The words of an app error: an error field, a name that holds an error, or what else an error says. */
  const words = (value: ts.Expression) => {
    field(value);
    const inside = (node: ts.Node) => {
      if (isDetailRead(node)) hit(node);
      ts.forEachChild(node, inside);
    };
    inside(value);
  };
  const field = (value: ts.Expression) => {
    for (const side of answerSides(value)) {
      if (isErrorField(side)) hit(side);
      // A name that holds an error or an error field (`const why = write.error`).
      else if (ts.isIdentifier(side) && isError(side) && !narrowedToAppError(side, side.text)) {
        hit(side);
      }
    }
  };
  const visit = (node: ts.Node) => {
    // An error-named field used as answer text (S31).
    if (ts.isPropertyAssignment(node) && isAnswer(node.parent)) field(node.initializer);
    if (
      scope !== 'api' &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'err' &&
      node.arguments[1]
    ) {
      field(node.arguments[1]);
    }
    // An app error's words are answered as they are: a ServiceError other
    // than internal_error, and a ForbiddenError (S31 review).
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.arguments) {
      const [first, second] = node.arguments;
      if (node.expression.text === 'ForbiddenError' && first) words(first);
      // An AI chat tool's refusal is read by the model as it is (S30).
      if (node.expression.text === 'ToolRefusal' && first) words(first);
      if (
        node.expression.text === 'ServiceError' &&
        second &&
        !(first && ts.isStringLiteralLike(first) && first.text === 'internal_error')
      ) {
        words(second);
      }
    }
    // Under lib/ai, what else an error says about itself is its text wherever
    // it is read (S30 review).
    if (ai && isDetailRead(node)) hit(node);
    // An error-to-text helper used as a value (S31 review).
    if (isHelperReference(node) && !staysOnServer(helperUse(node))) hit(node);
    // A server setting's name in text that can be answered (S31).
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)) &&
      SETTING_NAME.test(literalText(node)) &&
      !isNameLiteral(node) &&
      !staysOnServer(node)
    ) {
      hit(node);
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (TEXT_PROPERTIES.has(node.name.text) && isError(node.expression))
        text(node, node.expression);
      if (
        node.name.text === 'toString' &&
        isError(node.expression) &&
        ts.isCallExpression(node.parent)
      ) {
        text(node.parent, node.expression);
      }
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      TEXT_PROPERTIES.has(node.argumentExpression.text) &&
      isError(node.expression)
    ) {
      text(node, node.expression);
    } else if (ts.isCallExpression(node) && callsHelper(node, ERROR_TEXT_HELPERS)) {
      // An error-to-text helper's result is an error's text (never narrowed).
      if (!isWriteTarget(node) && !staysOnServer(node)) hit(node);
    } else if (ts.isCallExpression(node) && node.arguments[0] && isError(node.arguments[0])) {
      const callee = node.expression;
      const isString = ts.isIdentifier(callee) && callee.text === 'String';
      const isStringify =
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'stringify' &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'JSON';
      if (isString || isStringify) text(node, node.arguments[0]);
    } else if (ts.isTemplateSpan(node) && isError(node.expression)) {
      text(node.expression, node.expression);
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.PlusToken ||
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
    ) {
      for (const side of [node.left, node.right]) if (isError(side)) text(side, side);
    } else if (
      (ts.isShorthandPropertyAssignment(node) && isError(node.name)) ||
      (ts.isPropertyAssignment(node) &&
        ts.isIdentifier(unwrap(node.initializer)) &&
        isError(node.initializer)) ||
      (ts.isSpreadAssignment(node) && isError(node.expression))
    ) {
      // A whole error in an answer: a JSON body, or (under lib/ai) an object
      // that is returned or thrown.
      if (isJsonAnswer(node.parent) || (ai && isReturnedAnswer(node.parent))) hit(node);
    } else if (ts.isObjectBindingPattern(node)) {
      const owner = node.parent;
      const fromError =
        (ts.isVariableDeclaration(owner) &&
          ((owner.initializer !== undefined && isError(owner.initializer)) ||
            ts.isCatchClause(owner.parent))) ||
        (ts.isParameter(owner) && isRejectionHandler(owner.parent));
      if (fromError) {
        for (const el of node.elements) {
          const key = el.propertyName ?? el.name;
          if (ts.isIdentifier(key) && TEXT_PROPERTIES.has(key.text) && !staysOnServer(el)) hit(el);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const sourceLines = source.split('\n');
  return [...lines]
    .sort((a, b) => a - b)
    .map((line) => ({ line, text: (sourceLines[line - 1] ?? '').trim() }));
}

function census(kind: Scope = 'api'): Map<string, Hit[]> {
  const read = kind === 'api' ? scope() : kind === 'actions' ? actionScope() : serviceScope();
  const found = new Map<string, Hit[]>();
  for (const file of read) {
    const hits = hitsIn(file, readFileSync(file, 'utf8'), kind);
    if (hits.length > 0) found.set(path.relative(SRC, file), hits);
  }
  return found;
}

/** Every line of a file whose count is off, so a failure says where to look. */
function offList(
  found: Map<string, Hit[]>,
  allowed: Record<string, { lines: number; why: string }>,
): string[] {
  return [...found]
    .filter(([file, hits]) => hits.length !== (allowed[file]?.lines ?? 0))
    .flatMap(([file, hits]) => hits.map((hit) => `${file}:${hit.line}: ${hit.text}`));
}

/**
 * The censuses parse every module under src with the TypeScript compiler.
 * Alone each takes about a second; on a CI runner, beside the other test
 * files, the services census took 7 to 12 s on main and 15.4 s on a larger
 * tree (feat/liquid-glass, run 42564288929), past the 15 s default. They get
 * a minute: a slow runner is not a finding.
 */
const CENSUS_TIMEOUT_MS = 60_000;

/** `body` as the catch of a route, one statement per line from line 2. */
function inCatch(body: string[]): string {
  return ['export async function POST() { try { await work(); } catch (e) {', ...body, '} }'].join(
    '\n',
  );
}

describe("API routes never answer an error's own text", () => {
  it(
    "no API route answers an error's own text: every remaining line is listed, as often as listed",
    () => {
      const found = census();
      expect(offList(found, ALLOWED)).toEqual([]);
      expect(Object.fromEntries([...found].map(([file, hits]) => [file, hits.length]))).toEqual(
        Object.fromEntries(Object.entries(ALLOWED).map(([file, { lines }]) => [file, lines])),
      );
    },
    CENSUS_TIMEOUT_MS,
  );

  it('every allowed file gives its reason', () => {
    for (const [file, { lines, why }] of Object.entries(ALLOWED)) {
      expect(lines, file).toBeGreaterThan(0);
      expect(why.length, file).toBeGreaterThan(20);
    }
  });

  it('the census sees every spelling of the text (control: one per line)', () => {
    const sample = inCatch([
      "return NextResponse.json({ error: 'internal_error', message: e instanceof Error ? e.message : 'unknown' });",
      "return NextResponse.json({ error: 'internal_error', message: String(e) }, { status: 500 });",
      "if (e instanceof Error) return NextResponse.json({ error: 'internal_error', message: e.message });",
      'return NextResponse.json({ error: `internal_error: ${e}` });',
      "return NextResponse.json({ error: 'invalid_form', message: (e as Error).message });",
      'return NextResponse.json({ message: (e as { message: string }).message });',
      'return NextResponse.json({ message: (e as any).message });',
      'const { message } = e as Error; return NextResponse.json({ message });',
      'return NextResponse.json({ message: e.toString() });',
      "return NextResponse.json({ message: 'failed: ' + e });",
      'return NextResponse.json({ detail: JSON.stringify(e) });',
      "return NextResponse.json({ message: e['message'] });",
      'const stack = e instanceof Error ? e.stack : undefined; return NextResponse.json({ stack });',
      'const msg = (e as Error).message.slice(0, 200); return NextResponse.json({ message: msg });',
      'return NextResponse.json({ message: rpcErr.message });',
      'return NextResponse.json({ error: `candidate query failed: ${error.message}` });',
      'return NextResponse.json({ detail: res.error?.message ?? null });',
      'return NextResponse.json({ error }, { status: 500 });',
      'return NextResponse.json({ ...uploadErr, ok: false });',
      "return { ok: false, notes: `AI extraction unavailable (${e instanceof Error ? e.message : 'error'}).` };",
      'return work().catch((problem) => NextResponse.json({ message: String(problem) }));',
      'return work().catch(({ message }) => NextResponse.json({ message }));',
      // The error-to-text helpers are text producers, whatever their argument (S31).
      'return NextResponse.json({ message: rawErrorText(e) });',
      'return NextResponse.json({ message: nonErrorText(failure) });',
      'return NextResponse.json({ message: postgrestErrorText(res.error ?? {}, res) });',
      'return NextResponse.json({ message: reportedMessage(e as Error) });',
      'return NextResponse.json({ message: asReportableError(e).message });',
      'return NextResponse.json({ detail: `failed: ${errorTextHelpers.rawErrorText(e).slice(0, 80)}` });',
    ]);
    expect(hitsIn('sample.ts', sample).map((hit) => hit.line)).toEqual(
      Array.from({ length: 28 }, (_, i) => i + 2),
    );
  });

  it('the census counts none of what stays on the server or is a yes or no (control)', () => {
    const sample = inCatch([
      '// return NextResponse.json({ message: e instanceof Error ? e.message : "x" });',
      '/* { detail: err.message } `${error.message}` */',
      "const accept = 'image/*'; const label = 'e.message ${e}';",
      'throw new Error(`org list: ${(error as Error).message}`);',
      'void reportError(e instanceof Error ? e : new Error(String(e)), { tag: "t" });',
      "console.error('[route] failed:', e instanceof Error ? e.message : e);",
      'if (e instanceof ServiceError) return NextResponse.json({ error: e.code, message: e.message });',
      "if (e instanceof ForbiddenError) throw new ServiceError('forbidden', e.message);",
      "const words = e instanceof ServiceError && e.code !== 'internal_error' ? e.message : 'Try again.';",
      "throw new ServiceError('internal_error', rpcErr.message);",
      "if ((error.message ?? '').toLowerCase().includes('duplicate key')) return conflict();",
      'if (/timeout/i.test(err.message) || err.message === "x" || !e.message) return retry();',
      "if (e.message && e.message.includes('JWT')) return reauth(); const kind = e.stack ? 'thrown' : 'plain';",
      'const cause = e instanceof Error ? e.message : String(e); throw new Error(`read failed: ${cause}`);',
      'const raw = e instanceof Error ? e.message : String(e); const lower = raw.toLowerCase(); if (lower.startsWith("x")) return a();',
      "const { message } = e as Error; void reportError(new Error(message), { tag: 't' });",
      "const n = typeof e.message === 'string' ? e.message.length : 0;",
      "return NextResponse.json({ error: 'internal_error', message: UNEXPECTED_ERROR_MESSAGE });",
      'return items.map((entry) => entry.message);',
    ]);
    expect(hitsIn('sample.ts', sample)).toEqual([]);
    // JSX text that looks like code or a comment is text.
    expect(hitsIn('sample.tsx', 'const el = <p>// {"{"}err.message{"}"} String(e)</p>;')).toEqual(
      [],
    );
    // A ServiceError other than internal_error answers its message as it is:
    // built from an error's text, it counts.
    expect(
      hitsIn('sample.ts', inCatch(["throw new ServiceError('validation_error', e.message);"])).map(
        (hit) => hit.line,
      ),
    ).toEqual([2]);
  });

  it('the census reads app/api, the response helpers and the modules routes import, and no tests', () => {
    const read = scope().map((file) => path.relative(SRC, file));
    expect(read.length).toBeGreaterThan(300);
    expect(read).toContain('app/api/v1/cycle-counts/[id]/lines/[lineId]/record/route.ts');
    expect(read).toContain('app/api/v1/exceptions/error-response.ts');
    expect(read).toContain('lib/reports/export-errors.ts');
    expect(read).toContain('lib/reports/book-order-totals/http.ts');
    expect(read).toContain('lib/verification/error-response.ts');
    expect(read).toContain('server/lib/order-submission-http.ts');
    expect(read).toContain('server/lib/api-error-response.ts');
    // Imported by routes: text a route answers can be built here (S16 review).
    expect(read).toContain('lib/books/isbn-ai-extract.ts');
    expect(read).toContain('server/loaders/inventory-list.ts');
    // Dynamically imported too (extract-isbns-ai: `await import('@/lib/xlsx-to-csv')`).
    expect(read).toContain('lib/xlsx-to-csv.ts');
    // The AI chat's tools: what a tool returns goes into the model's context,
    // and the model's reply is answered (S31 review).
    expect(read).toContain('lib/ai/tools.ts');
    expect(read).toContain('lib/ai/chat-claude.ts');
    // A relative import out of app/api is followed like an `@/` one.
    const route = path.join(API, 'books/extract-isbns-ai/route.ts');
    expect(moduleFile('../../../../lib/books/isbn-ai-extract', route)).toBe(
      path.join(SRC, 'lib/books/isbn-ai-extract.ts'),
    );
    expect(moduleFile('@/lib/books/isbn-ai-extract', route)).toBe(
      path.join(SRC, 'lib/books/isbn-ai-extract.ts'),
    );
    expect(moduleFile('next/server', route)).toBeNull();
    expect(read.filter((file) => NOT_READ.test(file))).toEqual([]);
    expect(read.filter((file) => /\.test\.tsx?$/.test(file))).toEqual([]);
  });
});

/** `body` as an action's catch, one statement per line from line 2. */
function inActionCatch(body: string[]): string {
  return ['export async function act() { try { await work(); } catch (e) {', ...body, '} }'].join(
    '\n',
  );
}

describe("Server Actions and services never answer an error's own text (S31)", () => {
  it(
    "no Server Action answers an error's own text: every remaining line is listed, as often as listed",
    () => {
      const found = census('actions');
      expect(offList(found, ALLOWED_ACTIONS)).toEqual([]);
      expect(Object.fromEntries([...found].map(([file, hits]) => [file, hits.length]))).toEqual(
        Object.fromEntries(
          Object.entries(ALLOWED_ACTIONS).map(([file, { lines }]) => [file, lines]),
        ),
      );
    },
    CENSUS_TIMEOUT_MS,
  );

  it(
    "no service builds an error's own text into an answer: every remaining line is listed, as often as listed",
    () => {
      const found = census('services');
      expect(offList(found, ALLOWED_SERVICES)).toEqual([]);
      expect(Object.fromEntries([...found].map(([file, hits]) => [file, hits.length]))).toEqual(
        Object.fromEntries(
          Object.entries(ALLOWED_SERVICES).map(([file, { lines }]) => [file, lines]),
        ),
      );
    },
    CENSUS_TIMEOUT_MS,
  );

  it('every allowed file gives its reason', () => {
    for (const [file, { lines, why }] of [
      ...Object.entries(ALLOWED_ACTIONS),
      ...Object.entries(ALLOWED_SERVICES),
    ]) {
      expect(lines, file).toBeGreaterThan(0);
      expect(why.length, file).toBeGreaterThan(20);
    }
  });

  it('the new rules count an error field, a setting name and an error passed to a helper (control: one per line)', () => {
    const sample = inActionCatch([
      "return { ok: false, error: { code: 'internal_error', message: res.error ?? 'x' } };",
      "return err('internal_error', result.error);",
      "return err('internal_error', 'Server is missing FOO_SECRET_KEY. Add it to .env.local.');",
      "return ok({ failures: [{ id, error: summary.firstError || 'failed' }] });",
      "throw new ServiceError('validation_error', `Set NEXT_PUBLIC_PRICE_${plan} in Vercel env.`);",
      "return err('conflict', ok_ ? 'fine' : outcome.lastError);",
      // The error-to-text helpers in an action's result (S31 guard helpers).
      "return err('internal_error', nonErrorText(e));",
      "return { ok: false, error: { code: 'internal_error', message: nonErrorText(e) } };",
      'return ok({ failures: [{ id, reason: rawErrorText(e) }] });',
      "throw new ServiceError('validation_error', postgrestErrorText(res.error));",
      "return { ok: false, error: { code: 'conflict', message: asReportableError(e).message } };",
      "const why = reportedMessage(asReportableError(e)); return err('conflict', why);",
      // Never narrowed: a ServiceError's rawErrorText and reportedMessage are its internal detail.
      'if (e instanceof ServiceError) return err(e.code, rawErrorText(e));',
    ]);
    expect(hitsIn('sample.ts', sample, 'actions').map((hit) => hit.line)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    // A helper imported under another name is still a helper.
    const renamed = [
      "import { nonErrorText as describe } from '@/lib/error-text';",
      "export async function act() { try { await work(); } catch (e) { return err('internal_error', describe(e)); } }",
    ].join('\n');
    expect(hitsIn('sample.ts', renamed, 'actions').map((hit) => hit.line)).toEqual([2]);
    // A parameter a same-file call passes a catch binding is an error.
    const helper = [
      'function fail(x: unknown): never {',
      "  throw new ServiceError('validation_error', String(x));",
      '}',
      'export async function act() { try { await work(); } catch (e) { fail(e); } }',
    ].join('\n');
    expect(hitsIn('sample.ts', helper, 'services').map((hit) => hit.line)).toEqual([2]);
    // The setting rule reads the API scope too.
    expect(
      hitsIn(
        'sample.ts',
        inCatch([
          "return NextResponse.json({ message: 'Server is missing FOO_ROLE_KEY.' }, { status: 500 });",
        ]),
      ).map((hit) => hit.line),
    ).toEqual([2]);
  });

  it('the new rules count none of what stays on the server, a write or a name (control)', () => {
    const sample = inActionCatch([
      'throw new Error(`send failed: ${res.error}`);',
      "void reportError(new Error(res.error ?? 'x'), { tag: 't', extra: { message: res.error } });",
      "console.error('[x]', result.error, 'FOO_SECRET_KEY is not configured');",
      "throw new Error('FOO_SECRET_KEY is not configured');",
      "throw new ServiceError('internal_error', 'Missing FOO_API_KEY in .env.local');",
      'failure.error.message = UNEXPECTED_ERROR_MESSAGE;',
      'const headers = { Authorization: `Bearer ${env.CRON_SECRET}` }; await fetch(url, { headers });',
      "const key = process.env['FOO_SECRET_KEY'];",
      "if (res.error) return err('internal_error', UNEXPECTED_ERROR_MESSAGE);",
      "return ok({ 'FOO_SECRET_KEY': present, missing: NOT_SET_UP_MESSAGE });",
      // The helpers' text kept on the server: a report, a log line, an Error, an internal_error, a test.
      "void reportError(asReportableError(e), { tag: 't', extra: { detail: rawErrorText(e) } });",
      "console.warn('[x] failed:', nonErrorText(e), postgrestErrorText(res.error, res));",
      'throw new Error(`read failed: ${rawErrorText(e)}`);',
      "throw new ServiceError('internal_error', postgrestErrorText(res.error, res));",
      "const why = nonErrorText(e); console.error('[x]', why); if (why.includes('timeout')) return retry();",
      "if (reportedMessage(asReportableError(e)).startsWith('x')) return retry();",
    ]);
    expect(hitsIn('sample.ts', sample, 'actions')).toEqual([]);
    // In the API scope an error field counts only in a JSON body: the
    // snapshot route hands `{ err: ... }` to its own dbError.
    expect(
      hitsIn(
        'sample.ts',
        inCatch([
          "return dbError('items', { message: res.error ?? 'x' });",
          'return { ok: false, why: res.error };',
        ]),
      ),
    ).toEqual([]);
    expect(
      hitsIn('sample.ts', inCatch(['return NextResponse.json({ message: res.error });'])).map(
        (hit) => hit.line,
      ),
    ).toEqual([2]);
  });

  it("an app error's words built from an error field, a helper handed on as a function or renamed, and a const holding an error all count (S31 review, control: one per line)", () => {
    const sample = inActionCatch([
      // A ServiceError other than internal_error, and a ForbiddenError, answer their words as they are.
      "const write = await w(); if (write.error !== null) throw new ServiceError('conflict', write.error);",
      'throw new ForbiddenError(access.error);',
      "throw new ServiceError('validation_error', ok_ ? 'fine' : outcome.lastError);",
      // An error-to-text helper handed on as a function, or given another name.
      'return ok({ reasons: r.failures.map(rawErrorText) });',
      "const why = await work().then(() => null, nonErrorText); return err('conflict', why ?? 'x');",
      "const describeIt = rawErrorText; return err('conflict', describeIt(e));",
      'return ok({ reasons: r.failures.map(errorTextHelpers.postgrestErrorText) });',
      // A const that holds an error is an error, whatever its name.
      "const failure = asReportableError(e); return { ok: false, error: { code: 'conflict', message: failure.message } };",
      "const thrown = e as Error; return err('conflict', thrown.message);",
      // A name that holds an error field, answered as an app error's words.
      "const cause = write.error; throw new ServiceError('conflict', cause);",
    ]);
    expect(hitsIn('sample.ts', sample, 'actions').map((hit) => hit.line)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    // An error a same-file helper is handed (as the helper's result, not a name).
    const handed = [
      "function answer(x: Error) { return err('conflict', x.message); }",
      'export async function act() { try { await work(); } catch (e) { return answer(asReportableError(e)); } }',
    ].join('\n');
    expect(hitsIn('sample.ts', handed, 'actions').map((hit) => hit.line)).toEqual([1]);
    // The same spellings in a route.
    const route = inCatch([
      'const why = await work().catch(nonErrorText); return NextResponse.json({ message: why });',
      "throw new ServiceError('conflict', res.error);",
    ]);
    expect(hitsIn('sample.ts', route).map((hit) => hit.line)).toEqual([2, 3]);
  });

  it("what stays on the server, an app error's own sentence, an import, an export and a declaration do not count (S31 review, control)", () => {
    const sample = inActionCatch([
      "const write = await w(); if (write.error !== null) throw new ServiceError('internal_error', write.error);",
      "throw new ServiceError('conflict', 'That name is already taken.');",
      'throw new ForbiddenError();',
      "console.error('[x]', r.failures.map(rawErrorText));",
      "const failure = asReportableError(e); void reportError(failure, { tag: 't' }); console.error('[x]', failure.message);",
      "const thrown = e as Error; if (thrown.message.includes('timeout')) return retry();",
    ]);
    expect(hitsIn('sample.ts', sample, 'actions')).toEqual([]);
    const declared = [
      "import { rawErrorText, nonErrorText as describeIt } from './fetch-by-ids';",
      "export { postgrestErrorText } from './postgrest-error';",
      "export function reportedMessage(x: unknown): string { return typeof x === 'string' ? 'text' : 'other'; }",
      'type Describe = typeof rawErrorText;',
      'const names = { rawErrorText: 1, describeIt: 2 };',
    ].join('\n');
    expect(hitsIn('sample.ts', declared, 'actions')).toEqual([]);
  });

  it('the Server Action scope reads every action module and what it imports outside services, and no tests', () => {
    const read = actionScope().map((file) => path.relative(SRC, file));
    expect(read.length).toBeGreaterThan(100);
    expect(read).toContain('server/actions/digest.ts');
    expect(read).toContain('server/actions/platform/billing.ts');
    // 'use server' outside server/actions.
    expect(read).toContain('lib/onboarding/actions.ts');
    // Imported by actions, also read in the API scope.
    expect(read).toContain('lib/auth/verify-password.ts');
    expect(read).toContain('lib/email/resend.ts');
    expect(read.filter((file) => file.startsWith('server/services/'))).toEqual([]);
    expect(read.filter((file) => /\.test\.tsx?$/.test(file))).toEqual([]);
    const services = serviceScope().map((file) => path.relative(SRC, file));
    expect(services).toContain('server/services/shipping.ts');
    expect(services).toContain('server/services/lib/fetch-by-ids.ts');
    // Imported by a service only: a refusal the scan route answers is built here.
    expect(services).toContain('lib/po-scan/extract.ts');
    expect(services).not.toContain('lib/email/resend.ts');
    expect(services.filter((file) => /\.test\.tsx?$/.test(file))).toEqual([]);
  });

  it('every module that builds words an action or route answers (a non-internal ServiceError, a ForbiddenError) is read', () => {
    const read = new Set([...scope(), ...actionScope(), ...serviceScope()]);
    const unread = files(SRC).filter((file) => {
      if (read.has(file)) return false;
      const source = readFileSync(file, 'utf8');
      if (!source.includes('ServiceError(') && !source.includes('ForbiddenError(')) return false;
      let builds = false;
      const visit = (node: ts.Node) => {
        if (builds) return;
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
          const first = node.arguments?.[0];
          if (node.expression.text === 'ForbiddenError') builds = true;
          if (
            node.expression.text === 'ServiceError' &&
            !(first && ts.isStringLiteralLike(first) && first.text === 'internal_error')
          ) {
            builds = true;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(parse(file, source));
      return builds;
    });
    expect(unread.map((file) => path.relative(SRC, file))).toEqual([]);
  });

  it('the permission and account-status errors pass one fixed sentence and take no argument (why APP_ERRORS lists them)', () => {
    for (const [file, name] of [
      ['lib/auth/effective-permissions.ts', 'PermissionsUnavailableError'],
      ['lib/auth/account-status.ts', 'AccountStatusUnavailableError'],
    ] as const) {
      const sf = parse(file, readFileSync(path.join(SRC, file), 'utf8'));
      const cls = sf.statements.find(
        (st): st is ts.ClassDeclaration => ts.isClassDeclaration(st) && st.name?.text === name,
      );
      expect(cls, name).toBeDefined();
      const ctors = cls!.members.filter(ts.isConstructorDeclaration);
      expect(ctors.length, name).toBe(1);
      expect(ctors[0]!.parameters.length, name).toBe(0);
      const superCalls = (ctors[0]!.body?.statements ?? []).flatMap((st) =>
        ts.isExpressionStatement(st) &&
        ts.isCallExpression(st.expression) &&
        st.expression.expression.kind === ts.SyntaxKind.SuperKeyword
          ? [st.expression]
          : [],
      );
      expect(superCalls.length, name).toBe(1);
      expect(superCalls[0]!.arguments.length, name).toBe(1);
      expect(ts.isStringLiteralLike(superCalls[0]!.arguments[0]!), name).toBe(true);
    }
  });
});

describe("an AI chat tool's refusal is the tool's own words (S30)", () => {
  /** `body` as a tool's execute, one statement per line from line 2. */
  const inTool = (body: string[]) =>
    ['async function execute(args, ctx) { try { await work(); } catch (e) {', ...body, '} }'].join(
      '\n',
    );

  it("a refusal built from an error's text or an error field counts (control: one per line)", () => {
    const sample = inTool([
      'throw new ToolRefusal(e.message);',
      'throw new ToolRefusal(`not saved: ${e}`);',
      'throw new ToolRefusal(String(e));',
      "throw new ToolRefusal(write.error ?? 'not saved');",
      'throw new ToolRefusal(rawErrorText(e));',
    ]);
    expect(hitsIn('sample.ts', sample).map((hit) => hit.line)).toEqual([2, 3, 4, 5, 6]);
  });

  it("fixed words, a refusal's own message once it is proved one, and a cause kept for the report do not count (control)", () => {
    const sample = inTool([
      "throw new ToolRefusal('itemId is required');",
      "throw new ToolRefusal('That image address is not allowed.', { cause: e });",
      "throw new ToolUnavailableError('identifyFromPhoto', 'unavailable', { cause: e });",
      "throw new ToolUnavailableError('searchInventorySemantic', 'failed', { cause: res.error });",
      'if (e instanceof ToolRefusal) return e.message;',
      'const words = e instanceof ToolRefusal ? e.message.slice(0, 200) : TOOL_FAILED_MESSAGE; return words;',
    ]);
    expect(hitsIn('sample.ts', sample)).toEqual([]);
    // Any other typed failure's message is not proved the app's words here.
    expect(
      hitsIn('sample.ts', inTool(['if (e instanceof ToolUnavailableError) return e.message;'])).map(
        (hit) => hit.line,
      ),
    ).toEqual([2]);
  });

  it('a ToolRefusal is built only under lib/ai, which the API census reads (why APP_ERRORS lists it)', () => {
    const read = new Set(scope());
    const builders = files(SRC).filter((file) => {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('ToolRefusal(')) return false;
      let builds = false;
      const visit = (node: ts.Node) => {
        if (builds) return;
        if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'ToolRefusal'
        ) {
          builds = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(parse(file, source));
      return builds;
    });
    expect(builders.length).toBeGreaterThan(0);
    for (const file of builders) {
      const rel = path.relative(SRC, file);
      expect(rel.startsWith('lib/ai/'), rel).toBe(true);
      expect(read.has(file), rel).toBe(true);
    }
    expect(scope().map((file) => path.relative(SRC, file))).toContain('lib/ai/tool-errors.ts');
  });

  it('every fixed tool failure sentence is a string literal', () => {
    const file = path.join(AI, 'tool-errors.ts');
    const sf = parse(file, readFileSync(file, 'utf8'));
    const sentences: ts.Expression[] = [];
    const collect = (node: ts.Node, inTable: boolean) => {
      const here =
        inTable ||
        (ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'TOOL_FAILURE_SENTENCES');
      if (
        inTable &&
        ts.isPropertyAssignment(node) &&
        !ts.isObjectLiteralExpression(node.initializer)
      ) {
        sentences.push(node.initializer);
      }
      ts.forEachChild(node, (child) => collect(child, here));
    };
    collect(sf, false);
    expect(sentences.length).toBe(9);
    for (const sentence of sentences) {
      expect(ts.isStringLiteral(sentence), sentence.getText(sf)).toBe(true);
    }
  });
});

describe('an AI module never hands the model an error, whole or in part (S30 review)', () => {
  /** `body` as a tool's execute, one statement per line from line 2. */
  const inTool = (body: string[]) =>
    ['async function execute(args, ctx) { try { await work(); } catch (e) {', ...body, '} }'].join(
      '\n',
    );
  /** A module under lib/ai: the model reads what it returns. */
  const aiModule = path.join(AI, 'sample.ts');

  it('under lib/ai an error placed whole into what is returned or thrown, and an error field as a returned value, count (control: one per line)', () => {
    const sample = inTool([
      'return { error };',
      'return { ok: false, failure: e };',
      'return { rows: [], firstError };',
      'throw { ...e };',
      'return { ok: false, note: res.error };',
      "return { ok: false, note: write.error ?? 'not saved' };",
      'return rows.map((row) => ({ id: row.id, problem: row.lastError }));',
    ]);
    expect(hitsIn(aiModule, sample).map((hit) => hit.line)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    // Outside lib/ai the API scope reads JSON answers only: what a helper
    // returns goes to its route, which is read where it answers.
    expect(hitsIn('sample.ts', sample)).toEqual([]);
  });

  it("under lib/ai an error's hint, details and internalDetail count as its text (control: one per line)", () => {
    const sample = inTool([
      'throw new ToolRefusal(error.hint);',
      'throw new ToolRefusal(String(error.details));',
      "throw new ToolRefusal(`not saved: ${e.hint ?? 'no hint'}`);",
      'return { ok: false, note: error.details };',
      'if (e instanceof ServiceError) return e.internalDetail;',
      "return e instanceof ServiceError ? (e.internalDetail ?? e.message) : 'failed';",
      'return String(dataTag(failure.internalDetail));',
    ]);
    expect(hitsIn(aiModule, sample).map((hit) => hit.line)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    // In every scope they count in the words of an app error: here the three
    // refusals. The rest is counted under lib/ai only.
    expect(hitsIn('sample.ts', sample).map((hit) => hit.line)).toEqual([2, 3, 4]);
  });

  it("an app error's words built from an error's hint, details or internalDetail count in every scope (control: one per line)", () => {
    const sample = inActionCatch([
      "throw new ServiceError('validation_error', error.details ?? 'Not saved.');",
      "throw new ServiceError('conflict', `This order is ${error.details ?? 'closed'}.`);",
      'throw new ForbiddenError(error.hint);',
      "if (e instanceof ServiceError) throw new ServiceError('conflict', e.internalDetail ?? e.message);",
    ]);
    for (const scope of ['api', 'actions', 'services'] as const) {
      expect(
        hitsIn('sample.ts', sample, scope).map((hit) => hit.line),
        scope,
      ).toEqual([2, 3, 4, 5]);
    }
  });

  it("a test of the hint, a proved app error's details, a cause, a report and a tool's fixed results do not count (control)", () => {
    const sample = inTool([
      "if (error.hint === 'order_closed') throw new ToolRefusal('That order is closed.');",
      "throw new ToolRefusal(error.details === 'quantity' ? 'Quantities are whole numbers.' : 'Pick fewer items.');",
      "if (e instanceof ServiceError) { const reason = e.details?.reason; if (reason === 'mfa_required') return 'Enroll first.'; }",
      "void reportError(e, { tag: 't', extra: { hint: error.hint, detail: error.details, internal: e.internalDetail ?? null } });",
      "console.error('[tool] failed', error.hint, error.details, e.internalDetail);",
      "if ((e.internalDetail ?? '').includes('insufficient_stock')) throw new ToolRefusal('There is not enough stock.');",
      "throw new ToolUnavailableError('searchInventorySemantic', 'failed', { cause: error });",
      "throw new ServiceError('internal_error', `read failed: ${error.details}`);",
      "return { error: 'unknown_status', received: raw, allowed: [...KEYS] };",
      "return { error: 'forbidden', message: EXPORT_FORBIDDEN_COPY };",
      'return { ok: true, itemId, delta, reason, details: args.details, hint: args.hint };',
    ]);
    expect(hitsIn(aiModule, sample)).toEqual([]);
    expect(hitsIn('sample.ts', sample, 'services')).toEqual([]);
  });

  it('the tools return an `error` key in two deliberate results only: a failure is thrown, never returned', () => {
    // A returned `{ error }` is a result: the chat loop would count it, badge
    // it and audit it as a success, and nothing would report it.
    const file = path.join(AI, 'tools.ts');
    const sf = parse(file, readFileSync(file, 'utf8'));
    const found: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        ts.isObjectLiteralExpression(node.parent) &&
        node.name.getText(sf) === 'error'
      ) {
        found.push(node.getText(sf));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(found).toEqual([
      // resolveOrderStatusArg: an order status the model made up, with the
      // list it can retry from.
      "error: 'unknown_status'",
      // exportInventory: a member without the export permission gets the
      // sentence to pass on and no link.
      "error: 'forbidden'",
    ]);
  });
});

// ── What the model can read from a service's refusal (S30 review) ────────
//
// The censuses above read every module for an error's own TEXT. This part asks
// another question about a refusal's words: which of them can the AI chat's
// model read? classifyToolErrorMessage (lib/ai/chat.ts) answers a failed tool
// by the error's type and code, and hands the model a service's own words for
// one code only, validation_error: words about what the caller asked for. For
// every other code, and for every ForbiddenError, the model reads a fixed
// sentence. So the words that matter are those of every validation_error an AI
// tool can reach. Each one that is not a fixed sentence is listed below with
// what is put into it and why the model may read that; a new one fails here
// until someone reasons about it.
//
// "Can reach" is TypeScript's own answer. From every function in
// lib/ai/tools.ts and from executeToolCall (lib/ai/chat.ts), each call, each
// `new`, each JSX tag and each function used as a value is followed to its
// declaration through the app's and core's source, with the compiler's type
// checker. Where the checker cannot say which function runs, the walk takes
// every candidate: all the functions written in a table that is used as a
// value, and all the functions inside the value a name was given
// (`cache(async () => ...)`). A closure belongs to the function it is written
// in. It reads more than can run, never less on purpose.

/** A name's value at the top of a module: a const's, or a property's in a const's table. */
type ValueHolder = ts.VariableDeclaration | ts.PropertyAssignment;

/**
 * What the walk reads as one piece: a function with the closures written
 * inside it, a class's field initializers, or the value a module gives a name
 * (a table of handlers, a wrapped function). The functions written in a
 * class's fields or in a named value are pieces of their own.
 */
type Unit = ts.FunctionLikeDeclaration | ts.ClassDeclaration | ValueHolder;

function isValueHolder(node: ts.Node): node is ValueHolder {
  return ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node);
}

/** Whether a value can run or name anything: a function, a call, a `new`, or another name. */
function namesSomething(value: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found || ts.isTypeNode(node)) return;
    found =
      isFunction(node) ||
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      (ts.isIdentifier(node) && (node.parent as { name?: ts.Node }).name !== node);
    if (!found) ts.forEachChild(node, visit);
  };
  visit(value);
  return found;
}

interface ReachedSite {
  /** `file#function`: the outermost function that holds the construction. */
  where: string;
  line: number;
  /** 'ForbiddenError', a ServiceError's literal code, or null when the code is not a literal. */
  code: string | null;
  /** The code as it is written. */
  codeText: string;
  /** What in the message is not fixed words; empty for a fixed sentence. */
  built: string[];
}

interface Reach {
  /** Every reached function, as `file#function`. */
  units: string[];
  sites: ReachedSite[];
}

/** The outermost function that holds `node`. */
function outermostFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  let found: ts.FunctionLikeDeclaration | null = null;
  for (let n: ts.Node | undefined = node; n; n = n.parent) if (isFunction(n)) found = n;
  return found;
}

/** Every outermost function written in `node` (`node` itself when it is one). */
function functionsIn(node: ts.Node): ts.FunctionLikeDeclaration[] {
  const out: ts.FunctionLikeDeclaration[] = [];
  const visit = (n: ts.Node) => {
    if (isFunction(n)) out.push(n);
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** `InventoryService.adjustStock`, `saveDraftRpcError`, `adjustStockTool.execute`, `HANDLERS (value)`. */
function unitName(unit: Unit): string {
  const sf = unit.getSourceFile();
  const names: string[] = [];
  if (ts.isClassDeclaration(unit)) names.push('fields');
  else if (ts.isConstructorDeclaration(unit)) names.push('constructor');
  else if (!isValueHolder(unit) && unit.name) names.push(unit.name.getText(sf));
  for (
    let p: ts.Node | undefined =
      ts.isClassDeclaration(unit) || isValueHolder(unit) ? unit : unit.parent;
    p;
    p = p.parent
  ) {
    if (ts.isClassLike(p)) {
      names.push(p.name?.text ?? 'class');
      break;
    }
    if (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) names.push(p.name.getText(sf));
    if (ts.isVariableDeclaration(p)) {
      names.push(p.name.getText(sf));
      break;
    }
  }
  if (names.length === 0) {
    names.push(`line ${sf.getLineAndCharacterOfPosition(unit.getStart(sf)).line + 1}`);
  }
  return `${names.reverse().join('.')}${isValueHolder(unit) ? ' (value)' : ''}`;
}

/** `a ?? b`, `a || b`, `a + b`: the words can be either side's, or both. */
const WORD_OPERATORS = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.PlusToken,
]);

/**
 * Everything the functions in `seeds` can reach in `program`, and every
 * ServiceError and ForbiddenError built there. `base` is the folder the file
 * names are given from.
 */
function reachFrom(program: ts.Program, seeds: ts.Node[], base: string): Reach {
  const checker = program.getTypeChecker();
  const reached = new Set<Unit>();
  const pending: Unit[] = [];
  const sites: ReachedSite[] = [];
  /** A construction is listed once, however many pieces it is read in. */
  const listed = new Set<ts.Node>();

  const reach = (node: ts.Node) => {
    // A function inside another belongs to the outer one, and so does a value
    // named inside a function: both are read when that function is.
    const outer = outermostFunction(node);
    const unit: Unit | null = ts.isClassDeclaration(node)
      ? node
      : isFunction(node)
        ? node.body
          ? outer
          : null
        : isValueHolder(node)
          ? (outer ?? node)
          : null;
    if (!unit || reached.has(unit)) return;
    const sf = unit.getSourceFile();
    if (sf.isDeclarationFile || sf.fileName.includes('/node_modules/')) return;
    reached.add(unit);
    pending.push(unit);
  };
  /** The symbol `node` names, through an import's alias. */
  const symbolOf = (node: ts.Node): ts.Symbol | undefined => {
    try {
      const symbol = checker.getSymbolAtLocation(node);
      return symbol && symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    } catch {
      return undefined;
    }
  };
  /**
   * What a declaration can run: itself, the value it names (when that can run
   * or name anything), or a class's fields and constructors.
   */
  const runs = (declaration: ts.Node): ts.Node[] => {
    if (isFunction(declaration)) return [declaration];
    if (isValueHolder(declaration) && declaration.initializer) {
      if (isFunction(declaration.initializer)) return [declaration.initializer];
      return namesSomething(declaration.initializer) ? [declaration] : [];
    }
    // A class field is read with its class.
    if (ts.isPropertyDeclaration(declaration) && ts.isClassDeclaration(declaration.parent)) {
      return [declaration.parent];
    }
    if (ts.isClassDeclaration(declaration)) {
      return [declaration, ...declaration.members.filter(ts.isConstructorDeclaration)];
    }
    return [];
  };
  const follow = (symbol: ts.Symbol | undefined) => {
    for (const declaration of symbol?.declarations ?? []) runs(declaration).forEach(reach);
  };

  /** Whether `node` is fixed words: a literal, or made only of literals and consts that are. */
  const fixedWords = (node: ts.Expression, depth = 0): boolean => {
    const x = unwrap(node);
    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) || ts.isNumericLiteral(x)) {
      return true;
    }
    if (ts.isTemplateExpression(x)) {
      return x.templateSpans.every((span) => fixedWords(span.expression, depth));
    }
    if (ts.isConditionalExpression(x)) {
      return fixedWords(x.whenTrue, depth) && fixedWords(x.whenFalse, depth);
    }
    if (ts.isBinaryExpression(x) && WORD_OPERATORS.has(x.operatorToken.kind)) {
      return fixedWords(x.left, depth) && fixedWords(x.right, depth);
    }
    if ((ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) && depth < 4) {
      const declarations =
        symbolOf(ts.isPropertyAccessExpression(x) ? x.name : x)?.declarations ?? [];
      const [declaration] = declarations;
      if (declarations.length !== 1 || !declaration) return false;
      // A const, or a property of a const's object literal.
      let holder: ts.Node | undefined = declaration;
      if (ts.isPropertyAssignment(declaration)) {
        holder = declaration.parent;
        while (holder && !ts.isVariableDeclaration(holder) && !isFunction(holder))
          holder = holder.parent;
      }
      if (
        !holder ||
        !ts.isVariableDeclaration(holder) ||
        (ts.getCombinedNodeFlags(holder) & ts.NodeFlags.Const) === 0 ||
        !(ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) ||
        !declaration.initializer
      ) {
        return false;
      }
      return fixedWords(declaration.initializer, depth + 1);
    }
    return false;
  };
  /** What in a message is not fixed words, as written. */
  const builtParts = (node: ts.Expression): string[] => {
    const x = unwrap(node);
    if (fixedWords(x)) return [];
    if (ts.isTemplateExpression(x))
      return x.templateSpans.flatMap((span) => builtParts(span.expression));
    if (ts.isConditionalExpression(x))
      return [...builtParts(x.whenTrue), ...builtParts(x.whenFalse)];
    if (ts.isBinaryExpression(x) && WORD_OPERATORS.has(x.operatorToken.kind)) {
      return [...builtParts(x.left), ...builtParts(x.right)];
    }
    return [x.getText(x.getSourceFile()).replace(/\s+/g, ' ')];
  };

  const visitUnit = (unit: Unit) => {
    const sf = unit.getSourceFile();
    const where = `${path.relative(base, sf.fileName)}#${unitName(unit)}`;
    // In a function its closures are read with it. In a class's fields and in
    // a named value, each function is a piece of its own.
    const closuresWithIt = isFunction(unit);
    const visit = (node: ts.Node) => {
      // A type names no value and runs nothing (`fn<string>` used as a value
      // is an expression that TypeScript files under types).
      if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
      if (!closuresWithIt && isFunction(node)) {
        reach(node);
        return;
      }
      if (ts.isNewExpression(node) && !listed.has(node)) {
        const name = symbolOf(node.expression)?.name;
        if (name === 'ServiceError' || name === 'ForbiddenError') {
          listed.add(node);
          const args = node.arguments ?? [];
          const code = name === 'ServiceError' ? args[0] : undefined;
          const message = name === 'ServiceError' ? args[1] : args[0];
          sites.push({
            where,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            code:
              name === 'ForbiddenError'
                ? name
                : code && ts.isStringLiteralLike(code)
                  ? code.text
                  : null,
            codeText: code ? code.getText(sf) : name,
            built: message ? builtParts(message) : [],
          });
        }
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        let declaration: ts.Node | undefined;
        try {
          declaration = checker.getResolvedSignature(node)?.declaration;
        } catch {
          declaration = undefined;
        }
        if (declaration) runs(declaration).forEach(reach);
        // Also by the callee's name: an overload's implementation, a class
        // with no constructor of its own.
        const callee = node.expression;
        follow(symbolOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee));
      } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        follow(symbolOf(node.tagName));
      } else if (ts.isShorthandPropertyAssignment(node)) {
        follow(checker.getShorthandAssignmentValueSymbol(node));
      } else if (
        ts.isPropertyAccessExpression(node) &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)
      ) {
        // A getter, or a method or a table's function used as a value.
        follow(symbolOf(node.name));
      } else if (
        ts.isIdentifier(node) &&
        !ts.isPropertyAccessExpression(node.parent) &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
        // Not the name a declaration gives (a variable, a parameter, a key).
        (node.parent as { name?: ts.Node }).name !== node
      ) {
        // A function, or a table of functions, used as a value.
        follow(symbolOf(node));
      }
      ts.forEachChild(node, visit);
    };
    if (ts.isClassDeclaration(unit)) {
      for (const member of unit.members) {
        if (ts.isPropertyDeclaration(member) && member.initializer) visit(member.initializer);
        if (ts.isClassStaticBlockDeclaration(member)) visit(member.body);
      }
    } else if (isValueHolder(unit)) {
      if (unit.initializer) visit(unit.initializer);
    } else {
      visit(unit);
    }
  };

  seeds.forEach(reach);
  for (let unit = pending.pop(); unit !== undefined; unit = pending.pop()) visitUnit(unit);
  return {
    units: [...reached].map(
      (unit) => `${path.relative(base, unit.getSourceFile().fileName)}#${unitName(unit)}`,
    ),
    sites,
  };
}

const WEB = path.resolve(SRC, '..');

/** Everything the AI chat's tools can reach, read once. */
let toolReachMemo: Reach | undefined;
function toolReach(): Reach {
  if (toolReachMemo) return toolReachMemo;
  const config = ts.readConfigFile(path.join(WEB, 'tsconfig.json'), (file) =>
    ts.sys.readFile(file),
  );
  // The compiler options only: the program is the two modules below and what
  // they import.
  const { options } = ts.parseJsonConfigFileContent(
    config.config,
    { ...ts.sys, readDirectory: () => [] },
    WEB,
  );
  const tools = path.join(AI, 'tools.ts');
  const chat = path.join(AI, 'chat.ts');
  const program = ts.createProgram([tools, chat], {
    ...options,
    noEmit: true,
    incremental: false,
    composite: false,
    tsBuildInfoFile: undefined,
    skipLibCheck: true,
  });
  const toolsFile = program.getSourceFile(tools);
  const chatFile = program.getSourceFile(chat);
  if (!toolsFile || !chatFile)
    throw new Error('lib/ai/tools.ts or lib/ai/chat.ts is not in the program');
  // Every function of the tools module, and the boundary both chat loops call
  // each tool through.
  const seeds: ts.Node[] = functionsIn(toolsFile);
  const boundary = chatFile.statements.find(
    (st): st is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(st) && st.name?.text === 'executeToolCall',
  );
  if (!boundary) throw new Error('executeToolCall is not declared in lib/ai/chat.ts');
  seeds.push(boundary);
  toolReachMemo = reachFrom(program, seeds, SRC);
  return toolReachMemo;
}

/** A program over files that exist only here, for the walk's controls. */
function controlProgram(sources: Record<string, string>): { program: ts.Program; dir: string } {
  const dir = path.join(SRC, '__reach_control__');
  const virtual = new Map(
    Object.entries(sources).map(([name, text]) => [path.join(dir, name), text] as const),
  );
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options, true);
  const real = {
    fileExists: host.fileExists.bind(host),
    readFile: host.readFile.bind(host),
    getSourceFile: host.getSourceFile.bind(host),
    directoryExists: host.directoryExists?.bind(host),
  };
  host.fileExists = (file) => virtual.has(file) || real.fileExists(file);
  host.readFile = (file) => virtual.get(file) ?? real.readFile(file);
  host.directoryExists = (directory) =>
    directory === dir || (real.directoryExists?.(directory) ?? true);
  host.getSourceFile = (file, languageVersion, ...rest) => {
    const text = virtual.get(file);
    return text === undefined
      ? real.getSourceFile(file, languageVersion, ...rest)
      : ts.createSourceFile(file, text, languageVersion, true);
  };
  return { program: ts.createProgram([...virtual.keys()], options, host), dir };
}

/** The ServiceError codes, read from the class's constructor (server/services/context.ts). */
function serviceErrorCodes(): string[] {
  const file = path.join(SERVICES, 'context.ts');
  const sf = parse(file, readFileSync(file, 'utf8'));
  const cls = sf.statements.find(
    (st): st is ts.ClassDeclaration =>
      ts.isClassDeclaration(st) && st.name?.text === 'ServiceError',
  );
  const code = cls?.members
    .find(ts.isConstructorDeclaration)
    ?.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === 'code');
  const members = code?.type && ts.isUnionTypeNode(code.type) ? code.type.types : [];
  return members.flatMap((member) =>
    ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? [member.literal.text] : [],
  );
}

/**
 * The ServiceError codes, and what the model reads for each: the service's
 * own words (fenced as data), or a fixed sentence. A new code fails here, and
 * in the classifier's own tests (lib/ai/chat.write-guard.test.ts), until
 * someone decides which it is.
 */
const MODEL_READS: Record<string, 'words' | 'sentence'> = {
  unauthenticated: 'sentence',
  forbidden: 'sentence',
  not_found: 'sentence',
  validation_error: 'words',
  plan_limit_exceeded: 'sentence',
  module_disabled: 'sentence',
  conflict: 'sentence',
  internal_error: 'sentence',
};

/** The ServiceError codes a tool can reach today. `unauthenticated` is not one. */
const TOOL_REACHABLE_CODES = [
  'conflict',
  'forbidden',
  'internal_error',
  'module_disabled',
  'not_found',
  'plan_limit_exceeded',
  'validation_error',
];

/**
 * Reachable constructions whose code is not a literal, with why none of them
 * can be a code whose words the model reads.
 */
const TOOL_REACHABLE_COMPUTED_CODES: Record<string, { code: string; why: string }> = {
  'server/services/order-replacement.ts#replacementRefusal': {
    code: 'mapped.code',
    why: "core's mapReturnError entry for one of the six replacement hints (REPLACEMENT_HINTS), each a conflict or a forbidden entry with fixed words (pinned below)",
  },
};

/**
 * Every message a tool can reach that the model reads in the service's own
 * words (a validation_error, or a code that is not a literal) and that is not
 * a fixed sentence: the function that builds it, what is put into it, and why
 * the model may read that. Each was read at its source. None holds an error's
 * own text except the purchase order save's, whose text is the sentences the
 * app wrote into its own database function.
 */
const TOOL_REACHABLE_WORDS: Record<string, { built: string[]; why: string }> = {
  'server/services/inventory.ts#InventoryService.assertCustomFieldsValid': {
    built: ['result.error'],
    why: "validateCustomFields' own sentence about a custom field the caller filled in (packages/core customization/custom-fields.ts); it names the field by the label the organization gave it",
  },
  'server/services/inventory.ts#InventoryService.assertTrackingTypeChangeAllowed': {
    built: ['next'],
    why: "the tracking type the caller asked for, one of core's TRACKING_TYPE_VALUES words",
  },
  'server/services/inventory.ts#InventoryService.assertWarehouseServesCharter': {
    built: ['refusal'],
    why: "the caller's sentence for a charter the chosen warehouse does not service: each of its four callers in the file passes a fixed sentence",
  },
  'server/services/inventory.ts#InventoryService.create': {
    built: ['rawVariantSize', 'rawVariantSize'],
    why: 'the size the caller typed, quoted back in the two size refusals',
  },
  'server/services/inventory.ts#InventoryService.update': {
    built: ['rawSize', 'rawSize'],
    why: 'the size the caller typed, quoted back in the two size refusals',
  },
  'server/services/locations.ts#crateAwareLocationName': {
    built: ['position'],
    why: 'the rack number and row the caller gave for the crate, as formatRackPosition writes them',
  },
  'server/services/order-replacement.ts#replacementRefusal': {
    built: ['mapped.message'],
    why: "core's fixed words for the hint (RETURN_ERROR_WORDS); the code is a conflict or a forbidden one, so the model reads a fixed sentence (see TOOL_REACHABLE_COMPUTED_CODES)",
  },
  'server/services/purchase-orders.ts#deletedDestinationError': {
    built: ['locationName'],
    why: "the name of the organization's own destination location that was deleted; the two tools that draft purchase orders catch a failed save per supplier and return it as a counted failure",
  },
  'server/services/purchase-orders.ts#saveDraftRpcError': {
    built: ['message', 'message', 'message'],
    why: "save_purchase_order_draft's own sentences (migration 0366), chosen by the function's hint, never by the text: a line that is not valid, a kit's pre-assembled stock or a deleted item, named when the caller can see it. The two tools that draft purchase orders catch a failed save per supplier and return it as a counted failure",
  },
  'server/services/sports-profiles.ts#assertVariantAttributesValid': {
    built: ['problem.message'],
    why: "core's sentence for a size, size system or jersey number the caller left out (packages/core sports/required-attributes.ts); it names the category's subcategory by its label",
  },
  'server/services/sports-profiles.ts#resolveModeOverride': {
    built: ['requested'],
    why: "the tracking mode the caller asked for, one of core's TRACKING_MODES words",
  },
  'server/services/sports-profiles.ts#resolveTrackingProfile': {
    built: ['subcategoryKey'],
    why: "the category's own subcategory key, as the organization stored it, when no profile matches it",
  },
};

/**
 * The walk builds a TypeScript program over the tools and everything they
 * import (about a thousand files with the libraries' types). Alone it takes
 * two to three seconds; beside the other test files on a busy runner the
 * censuses above have taken ten times their time, so it gets three minutes.
 */
const REACH_TIMEOUT_MS = 180_000;

describe("what the model can read from a service's refusal is listed (S30 review)", () => {
  it('ServiceError has the codes the classifier was written for, each with what the model reads', () => {
    expect(serviceErrorCodes()).toEqual(Object.keys(MODEL_READS));
  });

  it("the classifier hands the model a service's own words for the listed codes only", () => {
    // Read from the source: the cases of the switch on the error's code that
    // read its message. The classifier's own tests hold what each case answers.
    const file = path.join(AI, 'chat.ts');
    const sf = parse(file, readFileSync(file, 'utf8'));
    const classifier = sf.statements.find(
      (st): st is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(st) && st.name?.text === 'classifyToolErrorMessage',
    );
    expect(classifier).toBeDefined();
    const switches: ts.SwitchStatement[] = [];
    const collect = (node: ts.Node) => {
      if (ts.isSwitchStatement(node) && node.expression.getText(sf) === 'err.code')
        switches.push(node);
      ts.forEachChild(node, collect);
    };
    collect(classifier!);
    expect(switches.length).toBe(1);
    const readsWords = (clause: ts.CaseOrDefaultClause): boolean => {
      let reads = false;
      const look = (node: ts.Node) => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === 'message') reads = true;
        ts.forEachChild(node, look);
      };
      clause.statements.forEach(look);
      return reads;
    };
    // Source text is compared with its white space folded, so wrapping a line
    // of the classifier differently is not a failure.
    const written = (node: ts.Node) => node.getText(sf).replace(/\s+/g, ' ');
    const wordCases = switches[0]!.caseBlock.clauses.flatMap((clause) =>
      readsWords(clause) ? [ts.isCaseClause(clause) ? written(clause.expression) : 'default'] : [],
    );
    expect(wordCases).toEqual(
      Object.entries(MODEL_READS)
        .filter(([, reads]) => reads === 'words')
        .map(([code]) => `'${code}'`),
    );
    // Outside that switch the function reads a message in two places only: a
    // ToolRefusal's own words, and the text it tests for the fixed sentences.
    const messageReads: string[] = [];
    const reads = (node: ts.Node) => {
      if (node === switches[0]) return;
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'message') {
        messageReads.push(written(node.parent));
      }
      ts.forEachChild(node, reads);
    };
    reads(classifier!);
    expect(messageReads).toEqual([
      'capped(err.message)',
      "err instanceof Error ? err.message : String(err ?? '')",
    ]);
  });

  it("the classifier reads one field of a refusal's details, the multi-factor gate's reason, and only to choose a fixed sentence", () => {
    // A ServiceError's details can hold a record's id or a stored name. The
    // classifier's own tests hold that none of it reaches the model; this
    // holds the source to the one read those tests were written for. Every
    // `details` in the function (a property, a key, a destructured name) is
    // that read, and the name it is kept in is only compared with the gate's
    // two reasons or used to pick one of the gate's two fixed sentences.
    const file = path.join(AI, 'chat.ts');
    const sf = parse(file, readFileSync(file, 'utf8'));
    const classifier = sf.statements.find(
      (st): st is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(st) && st.name?.text === 'classifyToolErrorMessage',
    );
    expect(classifier).toBeDefined();
    const written = (node: ts.Node) => node.getText(sf).replace(/\s+/g, ' ');
    const detailsReads: string[] = [];
    const look = (node: ts.Node) => {
      if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === 'details') {
        detailsReads.push(written(node.parent.parent));
      }
      ts.forEachChild(node, look);
    };
    look(classifier!);
    expect(detailsReads).toEqual(['err.details?.reason']);

    const holder: ts.VariableDeclaration[] = [];
    const findHolder = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        written(node.initializer) === 'err.details?.reason'
      ) {
        holder.push(node);
      }
      ts.forEachChild(node, findHolder);
    };
    findHolder(classifier!);
    expect(holder.length).toBe(1);
    expect(ts.isIdentifier(holder[0]!.name)).toBe(true);
    const name = (holder[0]!.name as ts.Identifier).text;
    const uses: string[] = [];
    const used = (node: ts.Node) => {
      const isPropertyName =
        ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
      if (
        ts.isIdentifier(node) &&
        node.text === name &&
        node.parent !== holder[0] &&
        !isPropertyName
      ) {
        uses.push(written(node.parent));
      }
      ts.forEachChild(node, used);
    };
    used(classifier!);
    expect(uses).toEqual([
      `${name} === 'aal2_required'`,
      `${name} === 'mfa_required'`,
      `TOOL_MFA_MESSAGES[${name}]`,
    ]);
  });

  it('no class extends ServiceError or ForbiddenError, so every construction is one the walk reads', () => {
    const subclasses = files(SRC).filter((file) => {
      const source = readFileSync(file, 'utf8');
      if (!/extends\s+(?:ServiceError|ForbiddenError)\b/.test(source)) return false;
      let found = false;
      const visit = (node: ts.Node) => {
        if (
          ts.isClassLike(node) &&
          node.heritageClauses?.some((clause) =>
            clause.types.some((type) =>
              /^(?:ServiceError|ForbiddenError)$/.test(type.expression.getText()),
            ),
          )
        ) {
          found = true;
        }
        if (!found) ts.forEachChild(node, visit);
      };
      visit(parse(file, source));
      return found;
    });
    expect(subclasses.map((file) => path.relative(SRC, file))).toEqual([]);
  });

  it(
    'the tools reach the listed ServiceError codes, and every reachable message the model reads that is not a fixed sentence is listed with its reason',
    () => {
      const { units, sites } = toolReach();
      // The walk went through the services: a broken one would reach little.
      expect(units.length).toBeGreaterThan(500);
      expect(units).toContain('server/services/inventory.ts#InventoryService.adjustStock');
      expect(units).toContain('lib/auth/warehouse.ts#assertWarehouseAccess');
      expect(units).toContain('server/services/context.ts#assertPermission');

      const codes = new Set(sites.flatMap((site) => (site.code === null ? [] : [site.code])));
      codes.delete('ForbiddenError');
      expect([...codes].sort()).toEqual(TOOL_REACHABLE_CODES);
      for (const code of TOOL_REACHABLE_CODES) expect(MODEL_READS[code], code).toBeDefined();

      const computed = Object.fromEntries(
        sites.filter((site) => site.code === null).map((site) => [site.where, site.codeText]),
      );
      expect(computed).toEqual(
        Object.fromEntries(
          Object.entries(TOOL_REACHABLE_COMPUTED_CODES).map(([where, { code }]) => [where, code]),
        ),
      );

      // The words the model reads: a code whose words pass, or a code that is
      // not a literal and so could be one.
      const found: Record<string, string[]> = {};
      for (const site of sites) {
        const read = site.code === null || MODEL_READS[site.code] === 'words';
        if (!read || site.built.length === 0) continue;
        (found[site.where] ??= []).push(...site.built);
      }
      for (const built of Object.values(found)) built.sort();
      expect(found).toEqual(
        Object.fromEntries(
          Object.entries(TOOL_REACHABLE_WORDS).map(([where, { built }]) => [
            where,
            [...built].sort(),
          ]),
        ),
      );
    },
    REACH_TIMEOUT_MS,
  );

  it('every listed message and every listed code gives its reason', () => {
    for (const [where, { why }] of [
      ...Object.entries(TOOL_REACHABLE_WORDS),
      ...Object.entries(TOOL_REACHABLE_COMPUTED_CODES),
    ]) {
      expect(why.length, where).toBeGreaterThan(20);
    }
  });

  it('the replacement refusal maps hints whose entries are a conflict or a forbidden one (why its code is listed)', () => {
    const service = path.join(SERVICES, 'order-replacement.ts');
    const hintsFile = parse(service, readFileSync(service, 'utf8'));
    const hints: string[] = [];
    const table = new Map<string, string>();
    const strings = (node: ts.Node | undefined): string[] =>
      node && ts.isArrayLiteralExpression(node)
        ? node.elements.flatMap((el) => (ts.isStringLiteralLike(el) ? [el.text] : []))
        : [];
    for (const st of hintsFile.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const decl of st.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === 'REPLACEMENT_HINTS') {
          hints.push(...strings(decl.initializer));
        }
      }
    }
    const core = path.resolve(SRC, '../../../packages/core/src/returns/return-error-map.ts');
    const coreFile = parse(core, readFileSync(core, 'utf8'));
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'RETURN_ERROR_TABLE' &&
        node.initializer &&
        ts.isObjectLiteralExpression(unwrap(node.initializer))
      ) {
        for (const entry of (unwrap(node.initializer) as ts.ObjectLiteralExpression).properties) {
          if (!ts.isPropertyAssignment(entry) || !ts.isObjectLiteralExpression(entry.initializer))
            continue;
          const code = entry.initializer.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && p.name.getText(coreFile) === 'code',
          );
          if (code && ts.isStringLiteralLike(code.initializer)) {
            table.set(entry.name.getText(coreFile).replace(/['"]/g, ''), code.initializer.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(coreFile);
    expect(hints.length).toBe(6);
    expect(table.size).toBeGreaterThan(40);
    for (const hint of hints) {
      expect(['conflict', 'forbidden'], hint).toContain(table.get(hint));
      expect(MODEL_READS[table.get(hint)!], hint).toBe('sentence');
    }
  });

  it('the walk follows a method, a function used as a value, a wrapped function and a table of functions, tells fixed words from built ones, and leaves out what nothing calls (control)', () => {
    const { program, dir } = controlProgram({
      'errors.ts': [
        'export class ServiceError extends Error {',
        '  constructor(public code: string, message: string) { super(message); }',
        '}',
        'export class ForbiddenError extends Error {}',
      ].join('\n'),
      'service.ts': [
        "import { ForbiddenError, ServiceError as Refusal } from './errors';",
        "export const TOO_MANY = 'Pick fewer items.';",
        'const MAX = 50;',
        "const WORDS = { busy: 'Busy. Try again.', late: 'Too late.' } as const;",
        'declare function cache<T>(fn: T): T;',
        'export function helper(size: string): void {',
        '  if (size.length > 24) throw new Refusal(\'validation_error\', `"${size}" is not a size.`);',
        '}',
        'export class Service {',
        '  private limit = makeLimit();',
        '  async run(size: string, late: boolean): Promise<void> {',
        '    this.check(size);',
        "    throw new Refusal('validation_error', late ? WORDS.late : TOO_MANY);",
        '  }',
        '  private check(size: string): void {',
        "    if (!size) throw new Refusal('validation_error', `At most ${MAX} sizes.`);",
        "    if (size === 'x') throw new ForbiddenError(`No access to ${size}.`);",
        '  }',
        '}',
        'function makeLimit(): number {',
        "  if (MAX < 0) throw new Refusal('conflict', WORDS.busy);",
        '  return MAX;',
        '}',
        'export const cached = cache(async (name: string) => {',
        "  throw new Refusal('not_found', `${name} was not found.`);",
        '});',
        'export const HANDLERS: Record<string, (words: string[]) => void> = {',
        "  join: (words) => { throw new Refusal('validation_error', words.join(' ')); },",
        '};',
        'export function mapped(entry: { code: string; message: string }): never {',
        '  throw new Refusal(entry.code, entry.message);',
        '}',
        'function byName(words: string): never {',
        "  throw new Refusal('validation_error', `by name: ${words}`);",
        '}',
        'export const REGISTRY = { named: byName };',
        'export function neverCalled(detail: string): never {',
        "  throw new Refusal('validation_error', `not reached: ${detail}`);",
        '}',
      ].join('\n'),
      'tools.ts': [
        "import { cached, helper, HANDLERS, mapped, REGISTRY, Service } from './service';",
        'export const tool = {',
        '  async execute(args: { kind: string; size: string }): Promise<void> {',
        '    helper(args.size);',
        '    await new Service().run(args.size, false);',
        '    await cached(args.size);',
        "    HANDLERS[args.kind]?.(['a']);",
        "    [{ code: 'conflict', message: 'x' }].forEach(mapped);",
        "    Object.values(REGISTRY).forEach((run) => run('x'));",
        '  },',
        '};',
      ].join('\n'),
    });
    const tools = program.getSourceFile(path.join(dir, 'tools.ts'));
    expect(tools).toBeDefined();
    const { units, sites } = reachFrom(program, functionsIn(tools!), dir);
    expect(units.sort()).toEqual([
      // Building an error runs its class: the constructor and the fields.
      'errors.ts#ForbiddenError.fields',
      'errors.ts#ServiceError.constructor',
      'errors.ts#ServiceError.fields',
      // A table used as a value, and a wrapped function, are read for what
      // they name; each function in them is a piece of its own.
      'service.ts#HANDLERS (value)',
      'service.ts#HANDLERS.join',
      'service.ts#REGISTRY (value)',
      'service.ts#Service.check',
      'service.ts#Service.fields',
      'service.ts#Service.run',
      'service.ts#byName',
      'service.ts#cached',
      'service.ts#cached (value)',
      'service.ts#helper',
      'service.ts#makeLimit',
      'service.ts#mapped',
      'tools.ts#tool.execute',
    ]);
    const seen = sites
      .map(
        (site) => `${site.where} ${site.code ?? `(${site.codeText})`} [${site.built.join(', ')}]`,
      )
      .sort();
    expect(seen).toEqual([
      "service.ts#HANDLERS.join validation_error [words.join(' ')]",
      'service.ts#Service.check ForbiddenError [size]',
      'service.ts#Service.check validation_error []',
      'service.ts#Service.run validation_error []',
      'service.ts#byName validation_error [words]',
      'service.ts#cached not_found [name]',
      'service.ts#helper validation_error [size]',
      'service.ts#makeLimit conflict []',
      'service.ts#mapped (entry.code) [entry.message]',
    ]);
  });
});
