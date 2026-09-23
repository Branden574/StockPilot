// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Exception Center settles each rule group on its own and names the ones
 * whose read failed (`failedRules`). The page must say those checks are
 * unknown, and must never show "Nothing needs attention" while one is out:
 * silence from a check that did not run is not "clean".
 */

const { list } = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('next/navigation', () => ({ notFound: vi.fn() }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement('a', { href }, children),
  };
});
vi.mock('@/server/services/exceptions', () => ({
  ExceptionsService: { forCurrentUser: vi.fn(async () => ({ list })) },
}));

import ExceptionsPage from './page';

beforeEach(() => vi.clearAllMocks());

describe('Exceptions page', () => {
  it('names a failed check and does not claim nothing needs attention', async () => {
    list.mockResolvedValue({ exceptions: [], truncatedRules: [], failedRules: ['over_reserved'] });
    render(await ExceptionsPage());
    expect(screen.getByRole('alert')).toHaveTextContent(
      'One check could not run: Promised more than is owned. What it would show is unknown, not clean.',
    );
    expect(screen.queryByText('Nothing needs attention')).not.toBeInTheDocument();
  });

  it('with every check run and nothing found, says nothing needs attention', async () => {
    list.mockResolvedValue({ exceptions: [], truncatedRules: [], failedRules: [] });
    render(await ExceptionsPage());
    expect(screen.getByText('Nothing needs attention')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
