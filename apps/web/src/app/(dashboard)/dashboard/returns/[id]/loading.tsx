import { PageSkeleton } from '@/components/dashboard/skeletons';

/**
 * The workbench's own skeleton (returns RX-1): a page shape rather than the
 * list's table rows it used to inherit from returns/loading.tsx. A route with
 * its own loading.tsx stays out of lib/navigation/route-skeletons.ts (the
 * late-skeleton guard refuses an entry that would stack on it).
 */
export default function ReturnWorkbenchLoading() {
  return <PageSkeleton />;
}
