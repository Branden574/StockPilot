import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const now = new Date();
  // Only routes that actually exist. StockPilot is invite-only, so
  // there's no public marketing site — only the landing page and
  // signin matter for any external indexing. Listing /pricing,
  // /about, /contact, /legal/terms, /legal/privacy here while none
  // of them are real routes confused Next.js's RSC prefetch and
  // generated 404s that showed up in browser devtools.
  const routes = ['', '/signin'];
  return routes.map((path) => ({
    url: `${base}${path}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority: path === '' ? 1.0 : 0.7,
  }));
}
