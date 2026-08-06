/**
 * Multi-page workflow guides (owner PRD §4) and the tour → route map the
 * Help center uses for replay links. Guides are DATA: ordered steps with
 * deep links; links may carry ?tour=<id> to auto-start that page's tour
 * on arrival (see PageTour's deep-link effect).
 */

export interface WorkflowStep {
  title: string;
  body: string;
  href?: string;
  linkText?: string;
}

export interface WorkflowGuide {
  id: string;
  name: string;
  summary: string;
  steps: WorkflowStep[];
}

/** Static page for each tour id; tours on detail pages (per-record URLs) have none. */
export const TOUR_ROUTES: Record<string, string | undefined> = {
  dashboard: '/dashboard',
  'items-page': '/dashboard/inventory',
  'new-item-form': '/dashboard/inventory/new',
  'staging-page': '/dashboard/inventory/staging',
  'orders-page': '/dashboard/orders',
  'order-create': '/dashboard/orders/new',
  'order-detail': undefined,
  'po-imports': '/dashboard/purchase-orders/imports',
  'settings-hub': '/dashboard/settings',
  'nav-settings': '/dashboard/settings/navigation',
  reports: '/dashboard/reports',
  'ai-assistant': '/dashboard/ai',
  'item-detail': undefined,
  'maintenance-requests': '/dashboard/maintenance',
};

export const WORKFLOW_GUIDES: WorkflowGuide[] = [
  {
    id: 'receive-po',
    name: 'Receive inventory from a vendor PO',
    summary:
      'From a vendor document to pickable stock on a rack — and why nothing changes your counts until the receive step.',
    steps: [
      {
        title: 'Create the import',
        body: 'Scan the vendor PO PDF with AI (it extracts every line and shows a confidence score) or upload a CSV. This only stages what is EXPECTED — stock is untouched.',
        href: '/dashboard/purchase-orders/imports/new',
        linkText: 'New import',
      },
      {
        title: 'Map lines and approve',
        body: 'Every inventory line must be matched to an internal item or skipped — suggested matches are advisory, never automatic. Approving creates a purchase order.',
        href: '/dashboard/purchase-orders/imports?tour=po-imports',
        linkText: 'PO imports (with tour)',
      },
      {
        title: 'Receive the purchase order',
        body: 'This is the moment stock counts change. Received quantities land in the staging location; the variance column shows what is still to come.',
        href: '/dashboard/purchase-orders',
        linkText: 'Purchase orders',
      },
      {
        title: 'Put stock away',
        body: 'Staged stock counts in your totals but cannot be picked. Place it into racks or crates from the Staging page to make it order-ready.',
        href: '/dashboard/inventory/staging?tour=staging-page',
        linkText: 'Staging (with tour)',
      },
    ],
  },
  {
    id: 'fulfill-order',
    name: 'Fulfill an order end-to-end',
    summary:
      'Request → approval → picking → packing → hand-over, including the claim lock and what “fulfilled” really means.',
    steps: [
      {
        title: 'Place the request',
        body: 'Browse the storefront, build a cart, set a needed-by date (it auto-schedules a calendar event on approval), and submit. This creates a PENDING request — nothing is reserved yet.',
        href: '/dashboard/orders/new?tour=order-create',
        linkText: 'Place an order (with tour)',
      },
      {
        title: 'Approve it',
        body: 'A manager reviews the request under Needs approval. Approving reserves the stock and unlocks the fulfillment pipeline.',
        href: '/dashboard/orders?status=needs_approval',
        linkText: 'Needs approval queue',
      },
      {
        title: 'Claim picking',
        body: 'Open the order and press Claim picking — it locks the order to one picker so two people never pick the same order. Managers can release a stale claim.',
      },
      {
        title: 'Pick, then pack',
        body: 'Work the pick slip (short lines can be partially picked), then generate the packing slip. Picked and staged units are NOT fulfilled yet.',
      },
      {
        title: 'Stage and hand over',
        body: 'Stage for pickup or delivery, then complete with a signature. Hand-over is what marks units fulfilled; if stock ran short, the order goes to Backordered until you resume or close it.',
        href: '/dashboard/orders?status=backordered',
        linkText: 'Backordered tab',
      },
    ],
  },
  {
    id: 'customize-workspace',
    name: 'Make the workspace yours (admins)',
    summary:
      'Rename terminology, switch off unused modules, and tune roles so the app matches how your team already works.',
    steps: [
      {
        title: 'Rename what things are called',
        body: 'Charters → Schools, Items → Inventory, Staging → Receiving — the sidebar, page titles, and pickers follow everywhere, on web and mobile.',
        href: '/dashboard/settings/navigation?tour=nav-settings',
        linkText: 'Navigation & labels (with tour)',
      },
      {
        title: 'Turn off what you do not use',
        body: 'Disabled modules disappear app-wide for every member. You can re-enable them any time without losing data.',
        href: '/dashboard/settings/modules',
        linkText: 'Modules',
      },
      {
        title: 'Tune who can do what',
        body: 'Grant or revoke permissions per role — or per person. Buttons, navigation, and data access all follow the grants.',
        href: '/dashboard/settings/roles',
        linkText: 'Roles & permissions',
      },
    ],
  },
];
