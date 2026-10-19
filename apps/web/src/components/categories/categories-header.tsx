import * as React from 'react';

import { PageHeader } from '@/components/patterns/page-header';
import { ArchiveViewToggle } from '@/components/ui/archive-view-toggle';

/**
 * The Categories page header (DESIGN-SPEC 6.1): the h1, the Active or
 * Archived subline, and the actions row: the Active / Archived toggle, "Set up
 * Sports" and "New category". Server-safe (no hooks of its own), so the page
 * paints it at once as the Suspense fallback while the list streams, and
 * CategoriesManager draws the same header with its buttons once the list is
 * in hand. The actions row wraps, so at 390 px both buttons stay inside the
 * page (P2.6c hand-off: the old row overflowed by 42 to 73 px).
 */
export function CategoriesHeader({
  view,
  actions,
  primaryAction,
}: {
  view: 'active' | 'archived';
  /** Secondary actions after the toggle ("Set up Sports"). */
  actions?: React.ReactNode;
  /** "New category" (accent). */
  primaryAction?: React.ReactNode;
}) {
  return (
    <PageHeader
      title="Categories"
      subline={
        view === 'archived'
          ? 'Categories you archived. Restore one to bring it back into filters and item forms.'
          : 'Group items so filters and reports stay tidy.'
      }
      actions={
        <>
          <ArchiveViewToggle view={view} />
          {actions}
        </>
      }
      primaryAction={primaryAction}
    />
  );
}
