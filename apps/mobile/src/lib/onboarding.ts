import { supabase } from './supabase';

/**
 * Mobile onboarding state + tour registry (owner PRD §11/§13). Shares the
 * web's user_onboarding table (mig 0259, RLS owner-only) so completing a
 * tour on either platform is remembered on both. Writes go direct through
 * the user-authed supabase client — this is user-owned preference data, not
 * org-permissioned inventory (which must use the REST API).
 */

export interface MobileTourStep {
  title: string;
  body: string;
}

export interface MobileTourDefinition {
  id: string;
  version: number;
  name: string;
  steps: MobileTourStep[];
}

interface Entry {
  v?: number;
}

export interface MobileTourState {
  completed: Record<string, Entry | undefined>;
  dismissed: Record<string, Entry | undefined>;
}

export async function getTourState(): Promise<MobileTourState> {
  try {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return { completed: {}, dismissed: {} };
    const { data } = await supabase
      .from('user_onboarding')
      .select('completed_tours, dismissed_tours')
      .eq('user_id', auth.user.id)
      .maybeSingle();
    return {
      completed: (data?.completed_tours as MobileTourState['completed']) ?? {},
      dismissed: (data?.dismissed_tours as MobileTourState['dismissed']) ?? {},
    };
  } catch {
    // Fail open: worst case a tour is offered once more.
    return { completed: {}, dismissed: {} };
  }
}

export async function recordTourOutcome(
  tourId: string,
  version: number,
  outcome: 'completed' | 'dismissed',
): Promise<void> {
  try {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return;
    const field = outcome === 'completed' ? 'completed_tours' : 'dismissed_tours';
    const { data: row } = await supabase
      .from('user_onboarding')
      .select('completed_tours, dismissed_tours')
      .eq('user_id', auth.user.id)
      .maybeSingle();
    const current = (row?.[field] as Record<string, unknown> | null) ?? {};
    await supabase.from('user_onboarding').upsert(
      {
        user_id: auth.user.id,
        [field]: {
          ...current,
          [tourId]: { v: version, at: new Date().toISOString(), platform: 'mobile' },
        },
      },
      { onConflict: 'user_id' },
    );
  } catch {
    // Best-effort.
  }
}

/* ------------------------------------------------------------------ */
/* Tours (ids namespaced `mobile-*` so web and mobile versions of the  */
/* same page are tracked independently — their steps differ).          */
/* ------------------------------------------------------------------ */

export const MOBILE_HOME_TOUR: MobileTourDefinition = {
  id: 'mobile-home',
  version: 1,
  name: 'app',
  steps: [
    {
      title: 'Welcome to StockPilot',
      body: 'The tabs below cover daily work — Home, Inventory, Scan, Orders. Everything else (schedule, reports, imports, settings) lives in the drawer: tap the menu icon top-left.',
    },
    {
      title: 'Scan is the fast path',
      body: 'The center Scan tab reads barcodes and ISBNs. Point it at a book cover and the AI can identify it even without a barcode.',
    },
    {
      title: 'Stays in sync with the web',
      body: 'Same data, live. Notifications, orders, and stock changes made here show up on the web app instantly — and your tour progress is shared too.',
    },
  ],
};

export const MOBILE_INVENTORY_TOUR: MobileTourDefinition = {
  id: 'mobile-inventory',
  version: 1,
  name: 'Inventory',
  steps: [
    {
      title: 'Every item, in your pocket',
      body: 'Search by name or SKU, and pull down to refresh. Items load 50 at a time, so even huge catalogs stay fast.',
    },
    {
      title: 'Tap an item for everything',
      body: 'Stock levels by location, serial numbers, photos, and movement history — plus Adjust and Transfer if your role allows it.',
    },
    {
      title: 'On hand vs placed',
      body: 'An item can be on hand but not yet placed on a rack. Only placed stock can be picked for orders — use put-away (web Staging page) to place it.',
    },
  ],
};

export const MOBILE_ORDERS_TOUR: MobileTourDefinition = {
  id: 'mobile-orders',
  version: 1,
  name: 'Orders',
  steps: [
    {
      title: 'The queue, wherever you are',
      body: 'Orders move pending → approved → picking → packing → staged → completed. Tap one to see its lines, status, and history.',
    },
    {
      title: 'Claim before you pick',
      body: 'Press “Claim picking” on an order to lock it to you — that is what prevents two people picking the same order. Digital picking then walks you line by line.',
    },
    {
      title: 'Fulfilled means handed over',
      body: 'Picked and staged units are not “fulfilled” yet — hand-over at pickup/delivery (with signature) is what counts units as fulfilled. Shortfalls send the order to Backordered instead of cancelling it.',
    },
  ],
};
