import { Image, Text, View } from '@react-pdf/renderer';

import { formatDateForPdf, pdfStyles } from './styles';

/**
 * Whether react-pdf may be handed `src` for an <Image>: a base64 data: URI of
 * PNG or JPEG bytes, which it decodes with no I/O. Given anything else,
 * <Image> fetches it with the global fetch (following redirects) or, for a
 * string that is not an absolute URL, reads it as a file on the server.
 */
export function isEmbeddableImageDataUri(src: unknown): src is string {
  return typeof src === 'string' && /^data:image\/(?:png|jpeg);base64,/.test(src);
}

interface BrandedHeaderProps {
  orgName: string;
  /**
   * The logo as a data: URI of PNG or JPEG bytes (prefetchPdfLogo in
   * image-prefetch.ts), or null. organizations.logo_url itself is never passed
   * here: an org admin sets it and the database does not hold it to the logo
   * bucket. Any value that is not such a data: URI is drawn as no logo.
   */
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
 * The logo arrives as bytes (a data: URI the route built through the guarded
 * fetch), never as a URL for @react-pdf to fetch. With no logo the header
 * still prints the org name, so a logo-less org still gets a clean header.
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
        {isEmbeddableImageDataUri(orgLogoUrl) ? (
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
