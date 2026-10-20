'use client';

import { Download } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { buildMovementsQueryString, type MovementsFilterQuery } from '@/lib/movements-filters';

const EXPORT_PATH = '/api/movements/export.csv';

const NO_FILTERS: MovementsFilterQuery = { q: '', type: '', from: '', to: '' };

/**
 * The Export CSV href for a set of filters. It is built by the same
 * buildMovementsQueryString the server pager uses, so the file always holds
 * exactly the filters on screen.
 */
export function movementsExportHref(filters: MovementsFilterQuery): string {
  const qs = buildMovementsQueryString(filters);
  return qs ? `${EXPORT_PATH}?${qs}` : EXPORT_PATH;
}

interface InstantMovementsFilters {
  filters: MovementsFilterQuery;
  setFilters: (next: MovementsFilterQuery) => void;
}

const InstantMovementsFiltersContext = React.createContext<InstantMovementsFilters | null>(null);

/**
 * Holds the instant ledger's filters for the whole page, so the page header's
 * Export CSV (where the reference puts Export) exports what the table below it
 * shows. In instant mode the filters live in the browser, not in the URL;
 * without this the export had to sit beside the filters inside the table.
 * The server-paged ledger reads its filters from the URL and hands the header
 * a finished href instead.
 */
export function MovementsInstantFiltersProvider({ children }: { children: React.ReactNode }) {
  const [filters, setFilters] = React.useState<MovementsFilterQuery>(NO_FILTERS);
  const value = React.useMemo(() => ({ filters, setFilters }), [filters]);
  return (
    <InstantMovementsFiltersContext.Provider value={value}>
      {children}
    </InstantMovementsFiltersContext.Provider>
  );
}

/** The instant ledger's shared filters, or null outside the provider. */
export function useInstantMovementsFilters(): InstantMovementsFilters | null {
  return React.useContext(InstantMovementsFiltersContext);
}

/**
 * Export CSV: a download link to the export route with the active filters.
 * `href` is the server ledger's finished link; without it the link follows the
 * instant ledger's filters through the provider.
 */
export function MovementsExportButton({ href }: { href?: string }) {
  const instant = useInstantMovementsFilters();
  const resolved = href ?? movementsExportHref(instant?.filters ?? NO_FILTERS);
  return (
    <Button asChild variant="outline">
      <a href={resolved} download aria-label="Export movements to CSV">
        <Download aria-hidden="true" />
        Export CSV
      </a>
    </Button>
  );
}
