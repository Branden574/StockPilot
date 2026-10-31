import { describe, expect, it, vi } from 'vitest';

/**
 * The book page route: the browser tab's title (CONFLICTS D16: book detail had
 * none) and what it hands the shared ItemDetail (the books edit route, the
 * back link's words, the validated `?return=` and `?tab=`).
 */
const itemDetail = vi.hoisted(() => vi.fn((_props: Record<string, unknown>) => null));
vi.mock('@/components/inventory/item-detail', () => ({ ItemDetail: itemDetail }));

class NotFound extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFound('notFound');
  },
}));

import BookDetailPage, { metadata } from './page';

const ID = '33333333-3333-4333-8333-333333333333';

async function render(search: { tab?: string; return?: string }) {
  const tree = (await BookDetailPage({
    params: Promise.resolve({ id: ID }),
    searchParams: Promise.resolve(search),
  })) as { type: unknown; props: Record<string, unknown> };
  expect(tree.type).toBe(itemDetail);
  return tree.props;
}

describe('/dashboard/books/[id]', () => {
  it('has a title of its own, which the dashboard template makes "Book · StockPilot"', () => {
    expect(metadata.title).toBe('Book');
  });

  it('opens the book edit form and goes back to Books by default', async () => {
    const props = await render({});
    expect(props).toMatchObject({
      id: ID,
      backHref: '/dashboard/books',
      backLabel: 'Back to books',
      editHref: `/dashboard/books/${ID}/edit`,
      returnParam: undefined,
    });
  });

  it('keeps a validated ?return= and passes ?tab=; refuses one that leaves the app', async () => {
    const ok = await render({ return: '/dashboard/books?q=algebra', tab: 'activity' });
    expect(ok).toMatchObject({
      backHref: '/dashboard/books?q=algebra',
      returnParam: '/dashboard/books?q=algebra',
      tab: 'activity',
    });
    const bad = await render({ return: '//evil.example' });
    expect(bad.backHref).toBe('/dashboard/books');
    expect(bad.returnParam).toBeUndefined();
  });
});

// B63: a mistyped or cut-off link is Page not found before ItemDetail starts
// its reads (the book's read answered an invalid-uuid error, which reached
// the error boundary as "Something broke loading this page").
describe('/dashboard/books/[id]: an id that is not a uuid', () => {
  it('is the not-found page: no ItemDetail is handed the id', async () => {
    for (const id of ['not-a-uuid', ID.slice(0, -1)]) {
      await expect(
        BookDetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }),
        id,
      ).rejects.toBeInstanceOf(NotFound);
    }
  });
});
