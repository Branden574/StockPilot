import { TablePageSkeleton } from '@/components/dashboard/skeletons';

/** The bundle list's shape: the header, the view and search row, the table card. */
export default function BundlesLoading() {
  return <TablePageSkeleton rows={6} />;
}
