/**
 * Structured data for SEO + rich results. Renders a single <script> tag with
 * SoftwareApplication + Organization schema.
 *
 * The JSON-LD payload is constructed entirely from static constants and the
 * NEXT_PUBLIC_APP_URL env var (validated by Zod at startup). No user-supplied
 * data ever flows into this string, so the React inline-HTML escape hatch is
 * safe here. Next.js officially recommends this pattern for JSON-LD — see
 * https://nextjs.org/docs/app/guides/json-ld
 *
 * Framing is intentionally neutral — StockPilot pivoted from public SaaS to
 * an invite-only internal inventory tool on 2026-05-04. The old payload
 * advertised pricing tiers ($0–$59) and "multi-tenant SaaS" language; both
 * are gone. We keep the schema entries because Google still indexes the
 * sign-in / marketing routes, but the language matches what the product
 * actually is now.
 */
export function MarketingJsonLd() {
  const url = process.env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com';
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        name: 'StockPilot',
        operatingSystem: 'Web, iOS, Android',
        applicationCategory: 'BusinessApplication',
        description:
          'Invite-only inventory management for warehouses, book collections, and supply teams. Track stock across locations, scan barcodes, and reorder before you run out.',
        url,
      },
      {
        '@type': 'Organization',
        name: 'StockPilot',
        url,
      },
    ],
  };
  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
