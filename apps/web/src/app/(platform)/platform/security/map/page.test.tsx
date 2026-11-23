import { render, screen } from '@testing-library/react';
import { isValidElement, Suspense, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SECURITY_MAP_WORDS } from '@stockpilot/core';

/**
 * The platform console's attack map page. Security invariant. Pinned: the
 * gate (requirePlatformAdmin) runs first, and a refused gate renders
 * nothing and reads nothing; the map section is inside <Suspense>, so the
 * header never waits for its read; a title and a link back to Security; the
 * page is always rendered on request.
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
vi.mock('@/components/platform/platform-security-map-section', () => ({
  PlatformSecurityMapSection: () => {
    h.order.push('section');
    return <section aria-label="Attack map section" />;
  },
}));

import { PlatformSecurityMapSection } from '@/components/platform/platform-security-map-section';

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

describe('the attack map page', () => {
  it('asks requirePlatformAdmin first; the section renders after it', async () => {
    render(await Page());
    expect(h.order).toEqual(['gate', 'section']);
    expect(screen.getByRole('heading', { level: 1, name: SECURITY_MAP_WORDS.title })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Attack map section' })).toBeTruthy();
  });

  it('a refused gate renders nothing and reads nothing', async () => {
    h.gate.mockRejectedValueOnce(new Error('NEXT_NOT_FOUND'));
    await expect(Page()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(h.order).toEqual(['gate']);
  });

  it('the section is inside <Suspense>, so the header never waits for its read', async () => {
    const tree = elements(await Page());
    const section = tree.find((e) => e.el.type === PlatformSecurityMapSection);
    expect(section).toBeDefined();
    const boundary = section!.inside.find((e) => e.type === Suspense) as
      ReactElement<{ fallback: ReactNode }> | undefined;
    expect(boundary).toBeDefined();
    render(<>{boundary!.props.fallback}</>);
    expect(screen.getByText(SECURITY_MAP_WORDS.loading)).toBeInTheDocument();
  });

  it('links back to Security; always rendered on request; its own title', async () => {
    render(await Page());
    expect(screen.getByRole('link', { name: /Security/ })).toHaveAttribute(
      'href',
      '/platform/security',
    );
    expect(dynamic).toBe('force-dynamic');
    expect(metadata.title).toBe('Attack map · Platform');
  });
});
