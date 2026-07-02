import { StorefrontPageSkeleton } from '@/components/orders/storefront/storefront-skeleton';

/**
 * Route-level loading state for /dashboard/orders/new (perf plan P5).
 * Renders the REAL storefront skeleton (dark frame, head + setup-bar
 * placeholders, catalog grid + cart rail) instead of the generic
 * dashboard PageSkeleton, so soft navigations show the branded
 * "store is opening" state in ~0ms while the page segment's context
 * chain and streamed catalog resolve.
 */
export default function Loading() {
  return <StorefrontPageSkeleton />;
}
