/**
 * Demo data for the glass landing's product previews (Landing.dc.html). The
 * repository is public: every name here is invented (a fictional workspace,
 * "North/East/West Campus", first names only, made-up codes), never a real
 * school, customer, person or ISBN. The board's photos come from the design's
 * own asset store and are not shipped: the previews draw tinted tiles instead
 * (recorded in stage3/site-rows.md).
 */

export type ThumbKind =
  'shirt' | 'book' | 'vest' | 'bottle' | 'planner' | 'charger' | 'kit' | 'marker';

export const WORKSPACE = { name: 'Northwind Schools', initials: 'NS' } as const;

export interface HeroRow {
  name: string;
  code: string;
  site: string;
  location: string;
  locationQty: number;
  onHand: number;
  available: number;
  thumb: ThumbKind;
  low?: boolean;
  staging?: boolean;
  child?: boolean;
}

export const HERO_ROWS: readonly HeroRow[] = [
  {
    name: 'Staff Polo · Navy · XS',
    code: 'APP-POLO-NVY-XS',
    site: 'North Campus',
    location: '31-C',
    locationQty: 12,
    onHand: 12,
    available: 12,
    thumb: 'shirt',
    child: true,
  },
  {
    name: 'Staff Polo · Navy · S',
    code: 'APP-POLO-NVY-S',
    site: 'North Campus',
    location: '31-C',
    locationQty: 28,
    onHand: 40,
    available: 40,
    thumb: 'shirt',
    child: true,
  },
  {
    name: 'Staff Polo · Navy · M',
    code: 'APP-POLO-NVY-M',
    site: 'North Campus',
    location: '31-C',
    locationQty: 6,
    onHand: 6,
    available: 4,
    thumb: 'shirt',
    child: true,
    low: true,
  },
  {
    name: 'Staff Polo · Navy · L',
    code: 'APP-POLO-NVY-L',
    site: 'North Campus',
    location: '32-A',
    locationQty: 24,
    onHand: 24,
    available: 22,
    thumb: 'shirt',
    child: true,
  },
  {
    name: 'Algebra I · Grade 9',
    code: 'BK-ALG1-G9',
    site: 'North Campus',
    location: 'Staging',
    locationQty: 52,
    onHand: 104,
    available: 92,
    thumb: 'book',
    staging: true,
  },
  {
    name: 'Geometry · Grade 10',
    code: 'BK-GEO-G10',
    site: 'East Campus',
    location: 'Green 3',
    locationQty: 60,
    onHand: 60,
    available: 48,
    thumb: 'book',
  },
  {
    name: 'Safety Vest · Hi-Vis',
    code: 'SAF-VEST-HV',
    site: 'No charter',
    location: '12-A',
    locationQty: 46,
    onHand: 46,
    available: 46,
    thumb: 'vest',
  },
];

export const QUESTIONS = [
  {
    icon: 'box',
    q: 'What do we have?',
    a: 'Items and books with on hand, available and reserved—per warehouse and per charter.',
  },
  {
    icon: 'pin',
    q: 'Where is it?',
    a: 'Every unit sits on a rack, in a crate, in staging or unplaced. A label never moves stock; a placement does.',
  },
  {
    icon: 'users',
    q: 'Who needs it?',
    a: 'Requests from sites and staff, with pickup or delivery, a needed-by time and a clear approval path.',
  },
  {
    icon: 'history',
    q: 'What happened to it?',
    a: 'An append-only ledger answers who changed what, when, by how much and why.',
  },
] as const;

export const CHAIN = [
  { label: 'Pending', time: '8:14 AM', state: 'done' },
  { label: 'Approved', time: '9:30 AM', state: 'done' },
  { label: 'Picking', time: '10:05 AM', state: 'now' },
  { label: 'Ready for delivery', time: '—', state: 'todo' },
  { label: 'Delivered · signed', time: '—', state: 'todo' },
] as const;

export const LEDGER = [
  { delta: '−2', tone: 'danger', item: 'Staff Polo · Navy · M', who: 'Luis · 10:42' },
  { delta: '+26', tone: 'ok', item: 'Biology · PO-000412', who: 'Luis · 8:41' },
  { delta: '0', tone: 'muted', item: 'Algebra I · Blue 12 → 14', who: 'Alex · 9:12' },
  { delta: '−1', tone: 'danger', item: 'USB-C Charger · count', who: 'Maya · 8:58' },
] as const;

export const SHOP = [
  { name: 'Staff Polo · Navy', thumb: 'shirt', availability: 'Available: 4 in M', tone: 'warn' },
  { name: 'Safety Vest · Hi-Vis', thumb: 'vest', availability: 'Available: 46', tone: 'ok' },
  { name: 'Water Bottle · 24 oz', thumb: 'bottle', availability: 'Available: 64', tone: 'ok' },
  {
    name: 'Planner · Black',
    thumb: 'planner',
    availability: 'Not in stock right now',
    tone: 'muted',
  },
] as const;

export const COUNT_LINES = [
  {
    name: 'USB-C Charger · 65W',
    location: '14-B',
    system: 10,
    counted: 9,
    diff: '−1',
    tone: 'danger',
    thumb: 'charger',
  },
  {
    name: 'Staff Polo · Navy · M',
    location: '31-C',
    system: 6,
    counted: 6,
    diff: '0',
    tone: 'muted',
    thumb: 'shirt',
  },
  {
    name: 'Algebra I · Grade 9',
    location: 'Blue 12 · Rack 4',
    system: 52,
    counted: 54,
    diff: '+2',
    tone: 'ok',
    thumb: 'book',
  },
  {
    name: 'First Aid Kit · Classroom',
    location: '9-A',
    system: 15,
    counted: 14,
    diff: '−1',
    tone: 'danger',
    thumb: 'kit',
  },
] as const;

export const BOOK_TOTALS = [
  { title: 'Algebra I · Grade 9', orders: '14 orders · latest Oct 30', copies: 118 },
  { title: 'Biology: Living Systems · Grade 10', orders: '11 orders · latest Oct 29', copies: 96 },
  { title: 'World History and the Modern Era', orders: '9 orders · latest Oct 27', copies: 84 },
] as const;

export const ORDER_LINES = [
  { name: 'Staff Polo · Navy · M', qty: 2, thumb: 'shirt' },
  { name: 'Algebra I · Grade 9', qty: 20, thumb: 'book' },
  { name: 'Geometry · Grade 10', qty: 12, thumb: 'book' },
  { name: 'Whiteboard Markers · 4-pack', qty: 6, thumb: 'marker' },
] as const;

export const TABLET_ORDERS = [
  { number: 'SO-000231', line: 'North Campus · Pending', current: true },
  { number: 'SO-000230', line: 'East Campus · Pending' },
  { number: 'SO-000229', line: 'East Campus · Picking' },
  { number: 'SO-000226', line: 'West Campus · Ready' },
] as const;

/**
 * The roles list: the roles an admin can invite (ASSIGNABLE_ROLES), under the
 * names and descriptions the app's Team page shows (ROLE_LABELS), never the
 * board's names (DECISIONS.md D10: role names unchanged in every appearance),
 * then the requester link. Initials and tones are decoration.
 */
export const ROLE_TONES: Record<string, { initials: string; tone: number }> = {
  admin: { initials: 'SA', tone: 4 },
  manager: { initials: 'MG', tone: 1 },
  staff: { initials: 'WU', tone: 3 },
  viewer: { initials: 'RO', tone: 5 },
};

export const REQUESTER_LINK = {
  name: 'Requester link',
  initials: 'RQ',
  tone: 6,
  description: 'Submit order and return requests from a link, without a full account.',
} as const;

export const FAQ = [
  {
    q: 'How do I get access?',
    a: 'StockPilot is invite-only. Your organization’s admin invites you from the Team page; open the link in that email to set up your account. If you think you should have access, contact the team.',
  },
  {
    q: 'Is there a free trial or self-serve sign-up?',
    a: 'No. Accounts are created by invitation, and new workspaces are set up by the StockPilot team with your organization.',
  },
  {
    q: 'Does it work on phones and tablets?',
    a: 'Yes. The web app works in a mobile browser, and the native apps for iPhone, iPad and Android handle scanning, counting, receiving and returns on the floor.',
  },
  {
    q: 'What happens to stock when an item is hidden from ordering?',
    a: 'Nothing. Hiding an item from Place an Order only removes it from new orders. Its stock, existing orders and reports stay exactly as they were.',
  },
  {
    q: 'Can books and apparel live in the same workspace?',
    a: 'Yes. Books carry ISBN, grade and crate details; apparel sizes are separate records shown together as a family. Grouping never merges stock.',
  },
  {
    q: 'How is our data protected?',
    a: 'Each organization’s data is isolated at the database level, sign-in supports an authenticator, and every sensitive change is audited. The Security page has the details.',
  },
] as const;
