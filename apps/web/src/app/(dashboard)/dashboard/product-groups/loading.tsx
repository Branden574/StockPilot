import { TablePageSkeleton } from '@/components/dashboard/skeletons';

/** Per-section loading UI — the app-wide nav perf convention: every dashboard
 *  section streams its own skeleton rather than blocking the shell. */
export default function ProductGroupsLoading() {
  return <TablePageSkeleton rows={6} />;
}
