import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The imports LIST and DETAIL pages label an import by its human name (mig
 * 0333) while keeping the real uploaded filename visible.
 *
 * Both are async SERVER components that instantiate services at module scope,
 * so they are pinned the way this directory already pins its other server-page
 * invariant (see page.test.tsx's "RSC serialization guard"): source text.
 *
 * HONEST LIMIT: a source pin proves what the file SAYS, not what React renders.
 * The rendering behavior itself is covered where it is testable — the service
 * returns display_name (po-imports.display-name.test.ts) and the forms send it
 * (po-scan-form.display-name.test.tsx) — and the visual result still wants an
 * authed browser walk over a list holding one named and one unnamed import.
 */

const listSrc = readFileSync(path.resolve(__dirname, 'page.tsx'), 'utf8');
const detailSrc = readFileSync(path.resolve(__dirname, '[id]', 'page.tsx'), 'utf8');

describe('imports LIST — name first, filename still visible', () => {
  it('links the row by display_name with a file_name fallback', () => {
    expect(listSrc).toMatch(/\{i\.display_name \?\? i\.file_name\}/);
  });

  it('still renders the source filename as secondary text under the name', () => {
    expect(listSrc).toMatch(
      /\{i\.display_name && \(\s*<p className="text-muted-foreground mt-0\.5 truncate text-xs">\s*\{i\.file_name\}/,
    );
  });

  it('never labels the row by the raw filename alone', () => {
    // The only two file_name references left are the fallback and the
    // secondary line above; a bare `{i.file_name}` as the link text is gone.
    expect(listSrc).not.toMatch(/className="font-medium hover:underline"\s*>\s*\{i\.file_name\}/);
  });
});

describe('imports DETAIL — the name is the H1, the filename is metadata', () => {
  it('titles the page with display_name and falls back to file_name', () => {
    expect(detailSrc).toMatch(/\{header\.display_name \?\? header\.file_name\}/);
  });

  it('shows "Source file: <file_name>" below the title', () => {
    expect(detailSrc).toMatch(/Source file: \{header\.file_name\}/);
  });

  it('wires the rename affordance with the current name AND the filename', () => {
    expect(detailSrc).toMatch(/<PoImportRenameButton/);
    expect(detailSrc).toMatch(/currentName=\{header\.display_name\}/);
    expect(detailSrc).toMatch(/fileName=\{header\.file_name\}/);
  });
});
