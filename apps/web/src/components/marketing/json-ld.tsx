/**
 * Structured data for SEO + rich results. Renders a single <script> tag with
 * SoftwareApplication + Organization schema.
 *
 * The JSON-LD payload is constructed entirely from static constants and the
 * NEXT_PUBLIC_APP_URL env var (validated by Zod at startup). No user-supplied
 * data ever flows into this string, so dangerouslySetInnerHTML is safe here.
 * Next.js officially recommends this pattern for JSON-LD — see
 * https://nextjs.org/docs/app/guides/json-ld
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
        offers: {
          '@type': 'AggregateOffer',
          lowPrice: '0',
          highPrice: '59',
          priceCurrency: 'USD',
          offerCount: 4,
        },
        description:
          "Premium multi-tenant inventory management SaaS. Track stock across locations, scan barcodes from a phone, and reorder before you run out.",
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
