import { formatRelative } from '@/lib/utils';

/**
 * Renders a relative-time string ("15 minutes ago") with
 * `suppressHydrationWarning` so the server-vs-client clock drift
 * inherent to `formatRelative` doesn't trip React's hydration check
 * and unmount the surrounding tree (React error #418).
 *
 * Use this anywhere you'd otherwise write `{formatRelative(x)}` inside
 * JSX. For string-concat / non-JSX contexts keep using `formatRelative`
 * directly — those aren't hydrated by React so there's nothing to warn
 * about.
 */
export function RelativeTime({
  date,
  className,
  prefix,
  fallback = '—',
}: {
  date: Date | string | null | undefined;
  className?: string;
  /** Optional leading text rendered before the relative value (e.g. "created "). */
  prefix?: string;
  /** Rendered when `date` is null/undefined. Default em-dash. */
  fallback?: string;
}) {
  if (!date) {
    return <span className={className}>{fallback}</span>;
  }
  return (
    <span className={className} suppressHydrationWarning>
      {prefix ?? ''}
      {formatRelative(date)}
    </span>
  );
}
