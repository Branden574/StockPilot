import { Image, Text, View } from '@react-pdf/renderer';

import { formatDateForPdf, pdfStyles } from './styles';

interface BrandedHeaderProps {
  orgName: string;
  orgLogoUrl: string | null;
  /** Document title — e.g. "Purchase Order #PO-1234". Right-aligned. */
  title: string;
  /** Optional second line under the title (date, warehouse name, etc). */
  subtitle?: string;
  /** Document date for the right column. Defaults to "now" when omitted. */
  documentDate?: Date | string | null;
}

/**
 * Shared header used across every branded PDF export. Renders the org's
 * logo (when available) + name on the left, and the document title /
 * subtitle / date on the right, separated by a hairline rule.
 *
 * The logo is fetched at render time by @react-pdf — it accepts an http(s)
 * URL string. If the URL is null or fails to load, we fall back to large
 * type so a logo-less org still gets a clean header. Failures inside
 * @react-pdf's image fetcher don't throw to the route handler; they just
 * skip the image and we already render the org name text alongside it.
 */
export function BrandedHeader({
  orgName,
  orgLogoUrl,
  title,
  subtitle,
  documentDate,
}: BrandedHeaderProps) {
  const dateLabel = formatDateForPdf(documentDate ?? new Date());
  return (
    <View style={pdfStyles.headerWrap}>
      <View style={pdfStyles.headerLeft}>
        {orgLogoUrl ? (
          // eslint-disable-next-line jsx-a11y/alt-text
          <Image src={orgLogoUrl} style={pdfStyles.headerLogo} />
        ) : null}
        <View>
          <Text style={pdfStyles.headerOrgName}>{orgName}</Text>
          <Text style={pdfStyles.headerOrgMeta}>StockPilot</Text>
        </View>
      </View>
      <View style={pdfStyles.headerRight}>
        <Text style={pdfStyles.headerTitle}>{title}</Text>
        {subtitle ? (
          <Text style={pdfStyles.headerSubtitle}>{subtitle}</Text>
        ) : null}
        <Text style={pdfStyles.headerSubtitle}>{dateLabel}</Text>
      </View>
    </View>
  );
}
