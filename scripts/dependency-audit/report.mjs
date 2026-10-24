#!/usr/bin/env node
/**
 * The dependency audit of the weekly Security Scan
 * (.github/workflows/security-scan.yml, job "Dependency audit").
 *
 * WHY IT EXISTS. CI had no dependency audit: the scan ran Semgrep and
 * TruffleHog only, and a vulnerable dependency reached us only as a
 * Dependabot alert, which fails no build and is seen only by someone who
 * opens the Security tab. On 2026-10-24 `pnpm audit --prod` listed four
 * critical advisories (Next.js twice, dompurify, shell-quote) and nothing in
 * CI said so. This reads that audit and decides the job:
 *
 *   - every advisory at high or critical in a production dependency is
 *     listed in the job summary (package, advisory, ranges, how it is
 *     reached), so a new one is seen without waiting for an alert;
 *   - the job FAILS on a critical advisory unless allow-list.json dismisses
 *     it with a reason and a review date that has not passed; high and lower
 *     never fail the job, they are reported;
 *   - it fails CLOSED: an audit that did not answer (registry down, an error
 *     object, unreadable JSON) or an allow-list that does not parse fails the
 *     job with the reason, never passes it with nothing checked.
 *
 * WHAT IT CANNOT LEAK. The job holds no secret (no `secrets.*`, a read-only
 * token that checkout does not persist, no install, so no package script
 * runs). This script reads two files and prints advisory metadata from the
 * registry: package names, advisory ids and titles, version ranges and
 * dependency paths. Every printed value is put on one line (control
 * characters dropped), "##[" is broken up and table pipes are escaped, and
 * every line starts with this script's own words, so registry text can
 * neither break the table nor form a command the Actions runner reads from a
 * log line ("::name::" at the start of a line, "##[name]" anywhere in one).
 * The workflow also prints the report between ::stop-commands:: and a marker
 * that is random per run, so the runner reads no command from it at all.
 *
 * Usage: node scripts/dependency-audit/report.mjs <pnpm-audit.json> [allow-list.json]
 * Prints Markdown on stdout. Exit 0 pass, 1 a critical advisory is not
 * dismissed, 2 the audit or the allow-list could not be read.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];

/** Severities listed in the report. */
const REPORTED = new Set(['high', 'critical']);

const GHSA_ID = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class AuditInputError extends Error {}

/**
 * One line of plain text from a registry value: control characters (line
 * breaks included) become spaces, runs of spaces become one, "##[" (the
 * runner's older command form, read anywhere in a line) becomes "# #[", and
 * the text is cut to at most `max` characters, never inside a character. A
 * value that is not a string is ''.
 */
export function oneLine(value, max = 200) {
  if (typeof value !== 'string') return '';
  const flat = value
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/##\[/g, '# #[')
    .trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : flat;
}

/** A table cell: one line, pipes and backslashes escaped. */
function cell(value, max) {
  return oneLine(value, max).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/**
 * The advisories in `pnpm audit --json` output, or an AuditInputError when it
 * is not a report: unreadable JSON, pnpm's `{ "error": ... }` (the registry
 * did not answer), or no advisories object.
 */
export function parseAudit(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AuditInputError('pnpm audit printed no JSON report (empty or unreadable output).');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AuditInputError('pnpm audit printed no JSON report.');
  }
  if (data.error) {
    const code = oneLine(data.error.code, 60) || 'unknown';
    throw new AuditInputError(`pnpm audit did not get an answer from the registry (${code}).`);
  }
  if (!data.advisories || typeof data.advisories !== 'object' || Array.isArray(data.advisories)) {
    throw new AuditInputError('pnpm audit printed a report with no advisories object.');
  }
  const advisories = [];
  for (const raw of Object.values(data.advisories)) {
    const severity = typeof raw?.severity === 'string' ? raw.severity.toLowerCase() : '';
    if (!SEVERITIES.includes(severity)) {
      throw new AuditInputError(
        `An advisory for ${oneLine(raw?.module_name, 80) || 'an unnamed package'} has no known severity.`,
      );
    }
    // Paths are filled only where node_modules exists (a local run); the CI
    // job installs nothing, so there it has the installed versions alone.
    const paths = [];
    const versions = [];
    for (const finding of Array.isArray(raw.findings) ? raw.findings : []) {
      if (typeof finding?.version === 'string' && !versions.includes(finding.version)) {
        versions.push(finding.version);
      }
      for (const p of Array.isArray(finding?.paths) ? finding.paths : []) {
        if (typeof p === 'string') paths.push(p);
      }
    }
    advisories.push({
      id: typeof raw.github_advisory_id === 'string' ? raw.github_advisory_id : `npm-${raw.id}`,
      package: typeof raw.module_name === 'string' ? raw.module_name : '',
      severity,
      title: raw.title,
      vulnerable: raw.vulnerable_versions,
      patched: raw.patched_versions,
      versions,
      paths,
    });
  }
  return advisories;
}

/**
 * The allow-list: `{ "dismissed": [ { advisory, package, reason, reviewBy, ... } ] }`.
 * Every entry names one GitHub advisory id and its package, says why in a
 * sentence, and carries a review date (YYYY-MM-DD). An entry missing any of
 * them is an AuditInputError, so a typo can never dismiss anything.
 */
export function parseAllowlist(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AuditInputError('The allow-list is not valid JSON.');
  }
  if (!data || !Array.isArray(data.dismissed)) {
    throw new AuditInputError('The allow-list has no "dismissed" list.');
  }
  return data.dismissed.map((entry, i) => {
    const where = `Allow-list entry ${i + 1}`;
    if (!entry || typeof entry !== 'object')
      throw new AuditInputError(`${where} is not an object.`);
    if (typeof entry.advisory !== 'string' || !GHSA_ID.test(entry.advisory)) {
      throw new AuditInputError(`${where} has no GitHub advisory id (GHSA-xxxx-xxxx-xxxx).`);
    }
    if (typeof entry.package !== 'string' || entry.package.trim() === '') {
      throw new AuditInputError(`${where} (${entry.advisory}) names no package.`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) {
      throw new AuditInputError(`${where} (${entry.advisory}) gives no reason.`);
    }
    if (
      typeof entry.reviewBy !== 'string' ||
      !ISO_DAY.test(entry.reviewBy) ||
      Number.isNaN(Date.parse(entry.reviewBy))
    ) {
      throw new AuditInputError(`${where} (${entry.advisory}) has no review date (YYYY-MM-DD).`);
    }
    return {
      advisory: entry.advisory,
      package: entry.package.trim(),
      reason: entry.reason.trim(),
      reviewBy: entry.reviewBy,
      alert: typeof entry.alert === 'string' ? entry.alert : null,
    };
  });
}

/**
 * Decide the job. `today` is YYYY-MM-DD (UTC). An entry dismisses an advisory
 * when its advisory id and package both match and its review date is today
 * or later; after that date it dismisses nothing until someone reviews it.
 */
export function evaluate(advisories, allowlist, today) {
  const rows = advisories
    .filter((a) => REPORTED.has(a.severity))
    .map((a) => {
      const entry = allowlist.find((e) => e.advisory === a.id && e.package === a.package) ?? null;
      const expired = entry !== null && entry.reviewBy < today;
      return { ...a, entry, dismissed: entry !== null && !expired, expired };
    })
    .sort(
      (x, y) =>
        SEVERITIES.indexOf(y.severity) - SEVERITIES.indexOf(x.severity) ||
        x.package.localeCompare(y.package) ||
        x.id.localeCompare(y.id),
    );
  const failing = rows.filter((r) => r.severity === 'critical' && !r.dismissed);
  const matched = new Set(
    advisories.flatMap((a) =>
      allowlist
        .filter((e) => e.advisory === a.id && e.package === a.package)
        .map((e) => e.advisory),
    ),
  );
  const unused = allowlist.filter((e) => !matched.has(e.advisory));
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const a of advisories) counts[a.severity] += 1;
  return { rows, failing, unused, counts, passed: failing.length === 0 };
}

function statusOf(row) {
  if (row.dismissed) {
    return `dismissed until ${row.entry.reviewBy}${row.entry.alert ? ` (${row.entry.alert})` : ''}: ${row.entry.reason}`;
  }
  if (row.expired) return `allow-list review date ${row.entry.reviewBy} has passed: review it`;
  return row.severity === 'critical' ? 'FAILS the scan' : 'reported';
}

/** The job summary, in Markdown. */
export function renderReport(result) {
  const { rows, failing, unused, counts, passed } = result;
  const lines = ['## Dependency audit (`pnpm audit --prod`)', ''];
  lines.push(
    `Production dependencies: ${counts.critical} critical, ${counts.high} high, ${counts.moderate} moderate, ${counts.low} low advisories.`,
    '',
  );
  if (passed) {
    lines.push(
      failing.length === 0 && rows.some((r) => r.severity === 'critical')
        ? 'Result: passed. Every critical advisory is dismissed on the allow-list.'
        : 'Result: passed. No critical advisory.',
    );
  } else {
    lines.push(
      `Result: FAILED. ${failing.length} critical ${failing.length === 1 ? 'advisory is' : 'advisories are'} not dismissed: ` +
        failing.map((r) => `${cell(r.package, 60)} ${cell(r.id, 40)}`).join(', ') +
        '. Upgrade the package (a pnpm override for a transitive one), or dismiss it in scripts/dependency-audit/allow-list.json with a reason and a review date.',
    );
  }
  lines.push('');
  if (rows.length > 0) {
    lines.push('| Severity | Package | Advisory | Vulnerable | Patched | Installed | Status |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of rows) {
      const installed = [
        cell(r.versions.join(', '), 80),
        r.paths.length === 0
          ? ''
          : `via ${cell(r.paths[0], 160)}${r.paths.length > 1 ? ` (+${r.paths.length - 1} more paths)` : ''}`,
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(
        `| ${r.severity} | ${cell(r.package, 60)} | ${cell(r.id, 40)} ${cell(r.title, 120)} | ${cell(r.vulnerable, 60)} | ${cell(r.patched, 60)} | ${installed} | ${cell(statusOf(r), 300)} |`,
      );
    }
    lines.push(
      '',
      'What depends on a package: `pnpm why <package> --prod` in a checkout with dependencies installed.',
    );
    lines.push('');
  }
  for (const e of unused) {
    lines.push(
      `Allow-list entry ${cell(e.advisory, 40)} (${cell(e.package, 60)}) matches no advisory any more: remove it.`,
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Run as a script. Returns the exit code. */
export function main(
  argv,
  {
    readFile = (p) => readFileSync(p, 'utf8'),
    out = (s) => process.stdout.write(s),
    now = new Date(),
  } = {},
) {
  const [
    auditPath,
    allowPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'allow-list.json'),
  ] = argv;
  if (!auditPath) {
    out('Usage: node scripts/dependency-audit/report.mjs <pnpm-audit.json> [allow-list.json]\n');
    return 2;
  }
  try {
    const advisories = parseAudit(readFile(auditPath));
    const allowlist = parseAllowlist(readFile(allowPath));
    const result = evaluate(advisories, allowlist, now.toISOString().slice(0, 10));
    out(renderReport(result));
    return result.passed ? 0 : 1;
  } catch (e) {
    const reason =
      e instanceof AuditInputError
        ? e.message
        : `could not read the input (${oneLine(e?.code ?? e?.name, 40) || 'error'}).`;
    out(
      `## Dependency audit (\`pnpm audit --prod\`)\n\nResult: FAILED. The audit was not checked: ${cell(reason, 300)}\n`,
    );
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
