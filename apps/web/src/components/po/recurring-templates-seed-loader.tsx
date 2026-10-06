'use client';

import { useSearchParams } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import {
  RECURRING_PO_SEED_PARAM,
  takeRecurringPoSeed,
  type RecurringPoSeed,
} from '@/lib/purchase-orders/recurring-seed';

import {
  RecurringTemplatesPanel,
  type RecurringLineLabel,
  type RecurringSeedDestination,
  type RecurringTemplateRow,
} from './recurring-templates-panel';

interface ItemOption {
  id: string;
  name: string;
  sku: string;
  unit_cost: number;
}

interface SupplierOption {
  id: string;
  name: string;
}

interface LocationOption {
  id: string;
  name: string;
}

interface Props {
  initial: RecurringTemplateRow[];
  items: ItemOption[];
  suppliers: SupplierOption[];
  locations: LocationOption[];
  entitled: boolean;
  /** Labels for items saved template lines point at that `items` lacks. */
  lineLabels?: RecurringLineLabel[];
  /** Where the purchase order ?from= names went, as the server read it. */
  seedDestination?: RecurringSeedDestination | null;
}

const SEED_LOST =
  "The purchase order's details did not reach this page. Open the purchase order and select Make recurring again.";

/**
 * Takes the "Make recurring" seed (lib/purchase-orders/recurring-seed.ts) and
 * opens RecurringTemplatesPanel's create form filled in with it.
 *
 * The seed is in sessionStorage, which only the browser can read, so it is
 * taken after mount, in a layout effect (before the browser paints, so a
 * Make recurring navigation never shows the list first). The panel reads
 * `seed` only when it mounts; until 2026-10-05 the seed arrived after that
 * and was silently ignored. `key` now remounts the panel with the seed.
 *
 * Only the seed stored for the PO named by ?from= is used. A plain visit
 * removes any seed left behind without opening it, and a seed that is there
 * but cannot be used (another PO's, or not a seed) is reported.
 */
export function RecurringTemplatesSeedLoader(props: Props) {
  const fromPoId = useSearchParams().get(RECURRING_PO_SEED_PARAM);
  const [handoff, setHandoff] = React.useState<{ key: number; seed: RecurringPoSeed | null }>({
    key: 0,
    seed: null,
  });
  // The address the seed was last taken for. StrictMode runs this effect twice
  // for one mount; the second run must not take again (and report the empty
  // storage it would find as a lost seed).
  const takenFor = React.useRef<string | null | undefined>(undefined);

  React.useLayoutEffect(() => {
    if (takenFor.current === fromPoId) return;
    takenFor.current = fromPoId;
    const taken = takeRecurringPoSeed();
    if (fromPoId === null) return;
    if (taken.kind === 'seed' && taken.poId === fromPoId) {
      const seed = taken.seed;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the seed is in sessionStorage, readable only in the browser after mount
      setHandoff((prev) => ({ key: prev.key + 1, seed }));
    } else if (taken.kind !== 'none') {
      toast.error(SEED_LOST);
    }
  }, [fromPoId]);

  return <RecurringTemplatesPanel key={handoff.key} {...props} seed={handoff.seed} />;
}
