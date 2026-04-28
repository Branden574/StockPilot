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
  free: {
    id: 'free',
    name: 'Free',
    description: 'For individuals getting started',
    monthlyPrice: 0,
    yearlyPrice: 0,
    cta: 'Get started',
    limits: {
      members: 1,
      items: 100,
      locations: 1,
      imagesPerItem: 3,
      attachmentsPerItem: 1,
      apiAccess: false,
      purchaseOrders: false,
      advancedReports: false,
      activityLogs: false,
      prioritySupport: false,
      sso: false,
      customRoles: false,
    },
    features: ['Up to 100 items', '1 user', '1 location', 'Manual entry', 'Basic CSV export'],
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
