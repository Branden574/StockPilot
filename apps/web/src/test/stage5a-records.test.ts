import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  checkRehearsal,
  rehearsalFileNames,
  sameBytes,
  snapshotDifferences,
  type DeviceSnapshot,
} from '../../tests/e2e/appearance/stage5a-records';

/** The kill switch and rehearsal comparisons (plan 8.2 cases 11 and 12). */

const SNAPSHOT: DeviceSnapshot = {
  cookie: null,
  local: {
    'sp-appearance': null,
    'sp-lg-intro-seen': null,
    'sp-style-server-at': null,
    theme: 'dark',
  },
  session: { 'sp-lg-fallback': null, 'sp-appearance-anon': null },
  info: { 'sp-appearance-sync': null },
};

function rehearsal(
  override: (step: number) => Partial<DeviceSnapshot> = () => ({}),
  row = (_: number) => 'liquid-glass|dark|2031-04-15 10:00:00+00\n',
) {
  const files = new Map<string, string>();
  for (let step = 1; step <= 5; step += 1) {
    const names = rehearsalFileNames(step);
    files.set(names.device, canonicalJson({ ...SNAPSHOT, ...override(step) }));
    files.set(names.row, row(step));
  }
  return files;
}

describe('stage 5 device records', () => {
  it('writes canonical JSON (sorted keys, final newline)', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n',
    );
  });

  it('names every difference of the compared part, never the sync record', () => {
    const after: DeviceSnapshot = {
      ...SNAPSHOT,
      cookie: 'liquid-glass',
      local: { ...SNAPSHOT.local, 'sp-appearance': '{"v":2,"style":"liquid-glass"}' },
      info: { 'sp-appearance-sync': '{"v":2}' },
    };
    expect(snapshotDifferences(SNAPSHOT, after)).toEqual([
      'cookie sp_style: null -> liquid-glass',
      'local sp-appearance: null -> {"v":2,"style":"liquid-glass"}',
    ]);
    expect(
      snapshotDifferences(SNAPSHOT, { ...SNAPSHOT, info: { 'sp-appearance-sync': 'x' } }),
    ).toEqual([]);
  });

  it('names the first differing line', () => {
    expect(
      sameBytes([
        { name: 'a', text: 'x\ny' },
        { name: 'b', text: 'x\nz' },
      ]),
    ).toEqual(['b differs from a at line 2: "y" vs "z"']);
  });

  it('the rehearsal passes five identical steps, the sync record ignored', () => {
    expect(rehearsalFileNames(3)).toEqual({
      device: 'rehearsal-3-default.json',
      row: 'account-row-3-default.txt',
    });
    expect(
      checkRehearsal(rehearsal((step) => ({ info: { 'sp-appearance-sync': `s${step}` } }))),
    ).toEqual([]);
  });

  it('the rehearsal fails a written cookie, a moved row and a missing step', () => {
    expect(
      checkRehearsal(rehearsal((step) => (step === 3 ? { cookie: 'liquid-glass' } : {}))),
    ).toHaveLength(1);
    expect(
      checkRehearsal(
        rehearsal(undefined, (step) =>
          step === 4
            ? 'liquid-glass|dark|2031-04-15 10:05:00+00\n'
            : 'liquid-glass|dark|2031-04-15 10:00:00+00\n',
        ),
      ),
    ).toEqual([
      expect.stringContaining('account-row-4-opt-in.txt differs from account-row-1-off.txt'),
    ]);
    const files = rehearsal();
    files.delete('rehearsal-5-off.json');
    expect(checkRehearsal(files)).toEqual(['missing rehearsal-5-off.json']);
  });
});
