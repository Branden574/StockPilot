import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * TYPE-LEVEL regression guard for `TransferStockBody['newRack']`.
 *
 * WHY A COMPILER IS RUN INSIDE A UNIT TEST
 * ════════════════════════════════════════
 * The defect this guards is invisible at runtime: the wire body is built by
 * `newLocationFields()` and handed to `transferStock()` through an `as NewRack`
 * CAST in move-stock-modal.tsx, and a cast is erased before a single byte is
 * sent. So no value assertion can ever fail on it. The only observer that can
 * see the drift is `tsc` — hence a tiny virtual program compiled against the
 * REAL `./stock-api` module graph, with diagnostics collected for the probe
 * file only (so another file being mid-edit elsewhere in the app cannot make
 * this test red for an unrelated reason).
 *
 * WHAT DRIFTED
 * ════════════
 * `NewRack` declared rack XOR crate (`crateNumber?: never` on the rack branch,
 * `rackNumber?: never` on the crate branch). The server declares the opposite:
 * packages/core/src/inventory/new-location.ts says A CRATE SITS ON A RACK, so
 * the rack pair alongside crate fields is that crate's POSITION and BOTH are
 * kept — `rack_and_crate` was deliberately deleted from its problem union. The
 * phone already sends both (move-stock-form.ts `newLocationFields`), and the
 * cast hid the contradiction. A future caller typing against `NewRack` could
 * not express a positioned crate and would mint a position-less "Crate #9"
 * that does not dedupe against "Crate #9 on rack A1" — the 0270 key, and the
 * REPRO A class the core module exists to prevent.
 */

const LIB_DIR = __dirname;
const PROBE_PATH = path.resolve(LIB_DIR, '__stock-api-type-probe__.ts');

/**
 * Compile `source` as if it were a file sitting next to stock-api.ts and return
 * the error messages FOR THAT FILE. The probe never touches the disk: it is
 * served from memory by an overridden CompilerHost, so a concurrently running
 * `tsc --noEmit` in this workspace never sees a half-written scratch file.
 */
function typeErrorsFor(source: string): string[] {
  const configPath = ts.findConfigFile(LIB_DIR, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) throw new Error('apps/mobile/tsconfig.json not found');
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(configPath));
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    // The probe's own correctness is the subject; third-party .d.ts noise is
    // not, and checking it would make this test hostage to a dependency bump.
    skipLibCheck: true,
    types: [],
  };

  const host = ts.createCompilerHost(options, true);
  const realGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
    path.resolve(fileName) === PROBE_PATH
      ? ts.createSourceFile(fileName, source, languageVersion, true)
      : realGetSourceFile(fileName, languageVersion, onError, shouldCreate);
  host.fileExists = (fileName) =>
    path.resolve(fileName) === PROBE_PATH || ts.sys.fileExists(fileName);
  host.readFile = (fileName) =>
    path.resolve(fileName) === PROBE_PATH ? source : ts.sys.readFile(fileName);

  const program = ts.createProgram([PROBE_PATH], options, host);
  const probe = program.getSourceFile(PROBE_PATH);
  if (!probe) throw new Error('probe source file was not added to the program');
  return [...program.getSyntacticDiagnostics(probe), ...program.getSemanticDiagnostics(probe)].map(
    (d) => ts.flattenDiagnosticMessageText(d.messageText, ' '),
  );
}

describe("TransferStockBody['newRack'] — a crate SITS ON a rack", () => {
  it('accepts a POSITIONED crate: crate number plus the rack pair that locates it', () => {
    // The exact body move-stock-form.ts `newLocationFields()` returns for a
    // book placed into crate 9 on rack A1 — and the exact body the transfer
    // route accepts (newLocationFieldsShape + refineNewLocation).
    expect(
      typeErrorsFor(`
        import type { TransferStockBody } from './stock-api';

        export const positionedCrate: NonNullable<TransferStockBody['newRack']> = {
          crateNumber: '9',
          crateColor: 'Blue',
          rackNumber: 'A1',
          rackRow: 'B',
        };
      `),
    ).toEqual([]);
  });

  it('still accepts a plain rack and a position-less crate', () => {
    // Both remain legitimate permanent shapes (production holds a crate with
    // no rack at all — the Blue Shelf), so widening must not have traded one
    // wrong exclusion for another.
    expect(
      typeErrorsFor(`
        import type { TransferStockBody } from './stock-api';

        export const rack: NonNullable<TransferStockBody['newRack']> = {
          rackNumber: '22',
          rackRow: 'B',
        };
        export const looseCrate: NonNullable<TransferStockBody['newRack']> = {
          crateNumber: 'Bin',
          crateColor: 'gray',
        };
      `),
    ).toEqual([]);
  });

  it('is the SAME shape core declares, in both directions', () => {
    // Mutual assignability, not one-way: a field added to (or dropped from)
    // either side is drift, and drift is what let the phone and the server
    // disagree about what a crate is in the first place.
    expect(
      typeErrorsFor(`
        import type { NewLocationFields } from '@stockpilot/core';

        import type { TransferStockBody } from './stock-api';

        type Wire = NonNullable<TransferStockBody['newRack']>;
        type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

        export const identical: Same<Wire, NewLocationFields> = true;
      `),
    ).toEqual([]);
  });
});
