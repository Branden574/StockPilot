import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The Procedures pages' redesign rules that jsdom cannot see (PLAN P4.D3
 * "Keep"; CONFLICTS area 20): no blurred or translucent sticky header, no
 * decorative gradient on the cards, and the Markdown body rendered with
 * `skipHtml` and no raw-HTML plugin.
 */
const COMPONENTS = path.resolve(__dirname);
const PAGES = path.resolve(__dirname, '../../app/(dashboard)/dashboard/procedures');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) return files(abs);
    return /\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [abs] : [];
  });
}

const sources = [...files(COMPONENTS), ...files(PAGES)].map((abs) => ({
  file: path.relative(path.resolve(__dirname, '../..'), abs),
  src: readFileSync(abs, 'utf8'),
}));

describe('Procedures look rules', () => {
  it('reads the files it guards (not vacuous)', () => {
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining([
        'components/procedures/procedure-card.tsx',
        'components/procedures/markdown-body.tsx',
        'app/(dashboard)/dashboard/procedures/[id]/page.tsx',
      ]),
    );
  });

  it('no backdrop blur and no gradient anywhere in the Procedures pages', () => {
    const hits = sources.filter((s) => /backdrop-blur|linear-gradient|bg-gradient/.test(s.src));
    expect(hits.map((h) => h.file)).toEqual([]);
  });

  it('the detail header stays sticky on an opaque surface', () => {
    const detail = sources.find((s) => s.file.endsWith('procedures/[id]/page.tsx'))!.src;
    const header = /data-slot="procedure-sticky-header"\s+className="([^"]+)"/.exec(detail);
    expect(header).not.toBeNull();
    const classes = header![1]!.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['sticky', 'top-0', 'bg-card', 'border-b']));
    expect(classes.some((c) => c.includes('/'))).toBe(false); // no translucent fill
  });

  it('Markdown keeps skipHtml and never adds rehype-raw', () => {
    const md = sources.find((s) => s.file.endsWith('markdown-body.tsx'))!.src;
    expect(md).toMatch(/\bskipHtml\b/);
    expect(md).not.toMatch(/import[^;]*rehype-raw/);
  });
});
