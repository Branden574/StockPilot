import { render, screen } from '@testing-library/react';
import { isValidElement, Suspense, type ReactElement, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SECURITY_ALERTS_WORDS } from '@stockpilot/core';

/**
 * The platform console's security alerts page (part 5, stage 4a).
 * Security invariant. Pinned: the gate (requirePlatformAdmin) runs first, exactly as
 * the attack map's page, and a refused gate renders nothing and reads
 * nothing; the section is inside <Suspense>, whose fallback says the alerts
 * are being checked, so the header never waits for its read; a title and a
 * link back to Security; the page is always rendered on request; it is in the
 * Liquid Glass console frame (the owner's word): it imports exactly
 * pages/admin.css then pages/platform.css, and no other glass stylesheet.
 */

const h = vi.hoisted(() => ({
  order: [] as string[],
  gate: vi.fn(),
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({
      href,
      children,
      className,
    }: {
      href: string;
      children: React.ReactNode;
      className?: string;
    }) => React.createElement('a', { href, className }, children),
  };
});
vi.mock('@/lib/auth/platform-admin', () => ({
  requirePlatformAdmin: async () => {
    h.order.push('gate');
    return h.gate();
  },
}));
vi.mock('@/components/platform/platform-security-alerts-section', () => ({
  PlatformSecurityAlertsSection: () => {
    h.order.push('section');
    return <section aria-label="Security alerts section" />;
  },
}));

import { PlatformSecurityAlertsSection } from '@/components/platform/platform-security-alerts-section';

import Page, { dynamic, metadata } from './page';

/** Every element of a rendered tree, with the elements it sits inside. */
function elements(
  node: ReactNode,
  inside: ReactElement[] = [],
): Array<{ el: ReactElement; inside: ReactElement[] }> {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child, inside));
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<{ children?: ReactNode }>;
  return [{ el, inside }, ...elements(el.props.children, [...inside, el])];
}

beforeEach(() => {
  h.order = [];
  h.gate.mockResolvedValue({ userId: 'p1', email: 'owner@example.com' });
});

describe('the security alerts page', () => {
  it('asks requirePlatformAdmin first; the section renders after it', async () => {
    render(await Page());
    expect(h.order).toEqual(['gate', 'section']);
    expect(
      screen.getByRole('heading', { level: 1, name: SECURITY_ALERTS_WORDS.title }),
    ).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Security alerts section' })).toBeTruthy();
  });

  it('a refused gate renders nothing and reads nothing', async () => {
    h.gate.mockRejectedValueOnce(new Error('NEXT_NOT_FOUND'));
    await expect(Page()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(h.order).toEqual(['gate']);
  });

  it('the section is inside <Suspense>, so the header never waits for its read', async () => {
    const tree = elements(await Page());
    const section = tree.find((e) => e.el.type === PlatformSecurityAlertsSection);
    expect(section).toBeDefined();
    const boundary = section!.inside.find((e) => e.type === Suspense) as
      ReactElement<{ fallback: ReactNode }> | undefined;
    expect(boundary).toBeDefined();
    render(<>{boundary!.props.fallback}</>);
    expect(screen.getByRole('status')).toHaveTextContent(SECURITY_ALERTS_WORDS.loading);
  });

  it('the loading fallback carries the record-only banner too (F2)', async () => {
    const tree = elements(await Page());
    const section = tree.find((e) => e.el.type === PlatformSecurityAlertsSection);
    const boundary = section!.inside.find((e) => e.type === Suspense) as ReactElement<{
      fallback: ReactNode;
    }>;
    render(<>{boundary.props.fallback}</>);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(SECURITY_ALERTS_WORDS.recordOnlyBanner);
    expect(screen.getByRole('status')).toHaveTextContent(SECURITY_ALERTS_WORDS.loading);
  });

  it('links back to Security; always rendered on request; its own title', async () => {
    render(await Page());
    expect(screen.getByRole('link', { name: /Security/ })).toHaveAttribute(
      'href',
      '/platform/security',
    );
    expect(dynamic).toBe('force-dynamic');
    expect(metadata.title).toBe('Security alerts · Platform');
  });

  it('imports exactly the console frame stylesheets, admin.css then platform.css, and no other Liquid Glass stylesheet', () => {
    const source = readFileSync(path.resolve(__dirname, 'page.tsx'), 'utf8');
    // The import statements themselves: a comment naming the files must not count.
    const glass = [
      ...source.matchAll(/^import ['"](@\/styles\/liquid-glass\/[^'"]*)['"];?$/gm),
    ].map((m) => m[1]);
    expect(glass).toEqual([
      '@/styles/liquid-glass/pages/admin.css',
      '@/styles/liquid-glass/pages/platform.css',
    ]);
    // Nothing else names a glass stylesheet in any other form (from, require, import()).
    expect(source.match(/['"]@\/styles\/liquid-glass\//g) ?? []).toHaveLength(2);
  });
});
