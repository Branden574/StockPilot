export const PLAN_IDS = ['free', 'pro', 'business', 'enterprise'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanLimits {
  members: number;
  items: number;
  locations: number;
  imagesPerItem: number;
  attachmentsPerItem: number;
  apiAccess: boolean;
  purchaseOrders: boolean;
  advancedReports: boolean;
  activityLogs: boolean;
  prioritySupport: boolean;
  sso: boolean;
  customRoles: boolean;
  /** Automatic reordering (daily auto-PO from reorder points). Pro and above. */
  autoReorder: boolean;
  /** Recurring PO templates (time-based standing orders). Pro and above. */
  recurringPos: boolean;
  /** Inventory restore points (snapshots + safe-reconcile restore). Business and above. */
  restorePoints: boolean;
}

export interface PlanDefinition {
  id: PlanId;
  name: string;
  description: string;
  monthlyPrice: number;
  yearlyPrice: number;
  highlight?: boolean;
  cta: string;
  limits: PlanLimits;
  features: string[];
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  // Default plan every new org lands on. Originally a 100-item /
  // 1-user / 1-location SaaS free tier. After the 2026-05-04 pivot
  // to an invite-only internal-company tool, the gates aren't doing
  // useful work — limits bumped to internal-tool comfortable ceilings
  // so the owner doesn't hit "Free plan limit exceeded" toasts while
  // running a real warehouse. Per-row plan_limit_exceeded errors
  // become unreachable in normal use without ripping out the
  // assertPlanLimit machinery (which we keep so the architecture is
  // there if SaaS ever comes back).
  free: {
    id: 'free',
    name: 'Free',
    description: 'For individuals getting started',
    monthlyPrice: 0,
    yearlyPrice: 0,
    cta: 'Get started',
    limits: {
      members: 100,
      items: 10000,
      locations: 100,
      imagesPerItem: 20,
      attachmentsPerItem: 20,
      apiAccess: false,
      purchaseOrders: false,
      advancedReports: false,
      activityLogs: false,
      prioritySupport: false,
      sso: false,
      customRoles: false,
      autoReorder: false,
      recurringPos: false,
      restorePoints: false,
    },
    features: ['Up to 10,000 items', '100 team members', '100 locations', 'Manual entry', 'Basic CSV export'],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    description: 'For growing teams and small businesses',
    monthlyPrice: 19,
    yearlyPrice: 190,
    highlight: true,
    cta: 'Start free trial',
    limits: {
      members: 5,
      items: 5000,
      locations: 5,
      imagesPerItem: 10,
      attachmentsPerItem: 5,
      apiAccess: false,
      purchaseOrders: false,
      advancedReports: false,
      activityLogs: true,
      prioritySupport: false,
      sso: false,
      customRoles: false,
      autoReorder: true,
      recurringPos: true,
      restorePoints: false,
    },
    features: [
      'Up to 5,000 items',
      '5 team members',
      '5 locations',
      'Barcode & QR scanning',
      'Low-stock alerts',
      'Suppliers',
      'CSV import/export',
      'Basic reports',
    ],
  },
  business: {
    id: 'business',
    name: 'Business',
    description: 'For multi-location operations',
    monthlyPrice: 59,
    yearlyPrice: 590,
    cta: 'Start free trial',
    limits: {
      members: 25,
      items: 50000,
      locations: Number.POSITIVE_INFINITY,
      imagesPerItem: 25,
      attachmentsPerItem: 25,
      apiAccess: false,
      purchaseOrders: true,
      advancedReports: true,
      activityLogs: true,
      prioritySupport: true,
      sso: false,
      customRoles: true,
      autoReorder: true,
      recurringPos: true,
      restorePoints: true,
    },
    features: [
      'Up to 50,000 items',
      '25 team members',
      'Unlimited locations',
      'Purchase orders',
      'Advanced reports',
      'Custom roles',
      'Activity logs',
      'Priority support',
    ],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    description: 'Custom-fit for large organizations',
    monthlyPrice: -1,
    yearlyPrice: -1,
    cta: 'Contact sales',
    limits: {
      members: Number.POSITIVE_INFINITY,
      items: Number.POSITIVE_INFINITY,
      locations: Number.POSITIVE_INFINITY,
      imagesPerItem: Number.POSITIVE_INFINITY,
      attachmentsPerItem: Number.POSITIVE_INFINITY,
      apiAccess: true,
      purchaseOrders: true,
      advancedReports: true,
      activityLogs: true,
      prioritySupport: true,
      sso: true,
      customRoles: true,
      autoReorder: true,
      recurringPos: true,
      restorePoints: true,
    },
    features: [
      'Unlimited everything',
      'SSO / SAML',
      'API access',
      'Custom integrations',
      'Dedicated support',
      'SLA',
    ],
  },
};

export const TRIAL_DAYS = 14 as const;

export function getPlan(planId: PlanId): PlanDefinition {
  return PLANS[planId];
}

export function isUnlimited(value: number): boolean {
  return !Number.isFinite(value);
}
