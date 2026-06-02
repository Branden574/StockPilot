import 'server-only';

import { env } from '@/lib/env';

export interface GoogleBooksClient {
  fetchVolumeByIsbn(isbn: string): Promise<unknown | null>;
}

/**
 * Stateless Google Books client. Free endpoint; `country=US` so saleInfo
 * prices are returned; optional API key (env.GOOGLE_BOOKS_API_KEY) raises
 * quota. Returns parsed JSON, or null on any non-200 (incl. 429) — a pull
 * miss is never a hard failure.
 */
export const googleBooksClient: GoogleBooksClient = {
  async fetchVolumeByIsbn(isbn: string): Promise<unknown | null> {
    const digits = isbn.replace(/[\s-]/g, '');
    const params = new URLSearchParams({ q: `isbn:${digits}`, country: 'US' });
    if (env.GOOGLE_BOOKS_API_KEY) params.set('key', env.GOOGLE_BOOKS_API_KEY);
    try {
      const res = await fetch(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        console.warn(`[google-books] ${res.status} for isbn ${digits}`);
        return null;
      }
      return (await res.json()) as unknown;
    } catch (e) {
      console.warn('[google-books] fetch failed', e);
      return null;
    }
  },
};
