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
 *
 * The title is the page's own word unless the org renamed the Categories
 * sidebar entry in Settings > Navigation: the page resolves that through
 * effectiveNavLabel and passes it here (PLAN rule 10).
 */
export function CategoriesHeader({
  view,
  title = 'Categories',
  actions,
  primaryAction,
}: {
  view: 'active' | 'archived';
  /** The h1: "Categories", or the org's rename of its sidebar entry. */
  title?: string;
  /** Secondary actions after the toggle ("Set up Sports"). */
  actions?: React.ReactNode;
  /** "New category" (accent). */
  primaryAction?: React.ReactNode;
}) {
  return (
    <PageHeader
      title={title}
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
