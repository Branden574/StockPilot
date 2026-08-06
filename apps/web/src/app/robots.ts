import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // /r/ is the public order-request landing page. Each org's
        // token is in the URL, so search-engine indexing would put
        // the token in the public Google cache and make it
        // enumerable. Same logic for /p/items/[id] — these are
        // legitimately public but we'd rather not be indexable.
        // /m/ is the public maintenance-request share page (Task 10) —
        // same reasoning: the token lives in the URL itself.
        disallow: ['/dashboard/', '/onboarding', '/auth/', '/api/', '/r/', '/p/', '/m/'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
