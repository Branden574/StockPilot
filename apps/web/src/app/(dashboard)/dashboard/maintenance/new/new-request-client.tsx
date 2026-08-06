'use client';

import { useRouter } from 'next/navigation';

import type { MaintenanceRequestFormValues } from '@stockpilot/core';
import { MaintenanceRequestForm } from '@/components/maintenance/maintenance-request-form';

interface Props {
  defaults: Partial<MaintenanceRequestFormValues>;
  sites: { id: string; name: string }[];
  categories: string[];
}

/**
 * Page-specific glue, not a reusable component (unlike MaintenanceRequestForm
 * / MaintenancePhotosPanel) — kept colocated with the route it serves rather
 * than in components/maintenance. Exists because a Server Component cannot
 * pass a plain closure as a prop to a Client Component: `onSaved` has to be
 * constructed here, on the client, where `useRouter()` is available.
 *
 * The photo upload panel is deliberately NOT rendered on this page — there
 * is no request id to attach photos to until after Save. It appears on the
 * detail page (Task 15) that `?review=1` lands on next.
 */
export function NewMaintenanceRequestClient({ defaults, sites, categories }: Props) {
  const router = useRouter();

  return (
    <MaintenanceRequestForm
      defaults={defaults}
      sites={sites}
      categories={categories}
      onSaved={(id) => router.push(`/dashboard/maintenance/${id}?review=1`)}
    />
  );
}
