/**
 * Device records and account rows as comparable text, for the kill switch
 * (plan 8.2 case 11) and the default-rollout rehearsal (case 12: off ->
 * opt-in -> default -> opt-in -> off "leaves device records and the account
 * row byte-identical"). Pure; the unit test is src/test/stage5a-records.test.ts.
 *
 * NO IMPORTS and only erasable TypeScript: rehearsal-compare.mjs loads this
 * file with Node's own type stripping (Node 22.18 and later).
 *
 * A device snapshot holds exactly the appearance keys this browser keeps
 * (packages/core APPEARANCE_STORAGE_KEYS, web) and next-themes' `theme`, each
 * present with its value or null, and the Design cookie's value (its expiry
 * is not part of it: a re-issue moves it). The account sync record is kept
 * apart, under `info`, and not compared: it is bookkeeping of which account
 * the device last read, which a build with the account sync writes and an
 * `off` build never reads.
 */

/** The localStorage keys of a device record (core APPEARANCE_STORAGE_KEYS + next-themes). */
export const DEVICE_LOCAL_KEYS = [
  'sp-appearance',
  'sp-lg-intro-seen',
  'sp-style-server-at',
  'theme',
] as const;
/** The sessionStorage keys (this tab's crash fallback and signed-out stamp). */
export const DEVICE_SESSION_KEYS = ['sp-lg-fallback', 'sp-appearance-anon'] as const;
/** Kept apart, never compared. */
export const INFO_LOCAL_KEYS = ['sp-appearance-sync'] as const;
export const STYLE_COOKIE = 'sp_style';

export interface DeviceSnapshot {
  cookie: string | null;
  local: Record<string, string | null>;
  session: Record<string, string | null>;
  info: Record<string, string | null>;
}

/** JSON with sorted keys and a final newline: byte-comparable. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** The part of a snapshot that must stay byte-identical. */
export function comparedPart(snapshot: DeviceSnapshot): string {
  return canonicalJson({
    cookie: snapshot.cookie,
    local: snapshot.local,
    session: snapshot.session,
  });
}

/** Where two snapshots' compared parts differ, one line per key. */
export function snapshotDifferences(a: DeviceSnapshot, b: DeviceSnapshot): string[] {
  const out: string[] = [];
  if (a.cookie !== b.cookie) out.push(`cookie ${STYLE_COOKIE}: ${a.cookie} -> ${b.cookie}`);
  for (const part of ['local', 'session'] as const) {
    const keys = new Set([...Object.keys(a[part]), ...Object.keys(b[part])]);
    for (const key of [...keys].sort()) {
      const x = a[part][key] ?? null;
      const y = b[part][key] ?? null;
      if (x !== y) out.push(`${part} ${key}: ${x} -> ${y}`);
    }
  }
  return out;
}

export interface NamedText {
  name: string;
  text: string;
}

/**
 * Compares texts byte for byte against the first, in order. Returns one line
 * per text that differs, naming the first differing line.
 */
export function sameBytes(list: readonly NamedText[]): string[] {
  if (list.length === 0) return ['nothing to compare'];
  const [first, ...rest] = list;
  const out: string[] = [];
  for (const item of rest) {
    if (item.text === first!.text) continue;
    const a = first!.text.split('\n');
    const b = item.text.split('\n');
    let at = 0;
    while (at < Math.max(a.length, b.length) && a[at] === b[at]) at += 1;
    out.push(
      `${item.name} differs from ${first!.name} at line ${at + 1}: ${JSON.stringify(a[at] ?? '<end>')} vs ${JSON.stringify(b[at] ?? '<end>')}`,
    );
  }
  return out;
}

/** The rehearsal's order of builds (plan 8.2 case 12, R15). */
export const REHEARSAL_ORDER = ['off', 'opt-in', 'default', 'opt-in', 'off'] as const;

/** `rehearsal-<n>-<rollout>.json` / `account-row-<n>-<rollout>.txt` for step n (1-based). */
export function rehearsalFileNames(step: number): { device: string; row: string } {
  const rollout = REHEARSAL_ORDER[step - 1];
  if (rollout === undefined)
    throw new Error(`The rehearsal has steps 1 to ${REHEARSAL_ORDER.length}.`);
  return { device: `rehearsal-${step}-${rollout}.json`, row: `account-row-${step}-${rollout}.txt` };
}

/**
 * The whole rehearsal check over a folder's files (name -> text): every step's
 * device snapshot and account row present, each compared part and each row
 * byte-identical to step 1's. Returns the findings (empty: pass).
 */
export function checkRehearsal(files: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  const devices: NamedText[] = [];
  const rows: NamedText[] = [];
  for (let step = 1; step <= REHEARSAL_ORDER.length; step += 1) {
    const names = rehearsalFileNames(step);
    const device = files.get(names.device);
    const row = files.get(names.row);
    if (device === undefined) out.push(`missing ${names.device}`);
    else {
      try {
        devices.push({
          name: names.device,
          text: comparedPart(JSON.parse(device) as DeviceSnapshot),
        });
      } catch {
        out.push(`${names.device} is not a device snapshot`);
      }
    }
    if (row === undefined) out.push(`missing ${names.row}`);
    else rows.push({ name: names.row, text: row });
  }
  if (out.length) return out;
  out.push(...sameBytes(devices));
  // An empty dump (no row) passes only when every step's is empty too.
  out.push(...sameBytes(rows));
  return out;
}
