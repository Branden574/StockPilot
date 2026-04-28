import type { PlanId } from '../constants/plans';
import type { Role } from '../constants/roles';

import type { ISODate, UUID } from './common';

export interface UserProfile {
  id: UUID;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  defaultOrganizationId: UUID | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface Organization {
  id: UUID;
  name: string;
  slug: string;
  logoUrl: string | null;
  industry: string | null;
  size: string | null;
  timezone: string;
  currency: string;
  plan: PlanId;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  trialEndsAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface OrganizationMember {
  id: UUID;
  organizationId: UUID;
  userId: UUID;
  role: Role;
  invitedBy: UUID | null;
  invitedAt: ISODate | null;
  acceptedAt: ISODate | null;
  createdAt: ISODate;
}

export interface OrganizationInvite {
  id: UUID;
  organizationId: UUID;
  email: string;
  role: Role;
  token: string;
  expiresAt: ISODate;
  invitedBy: UUID;
  acceptedAt: ISODate | null;
  createdAt: ISODate;
}

export interface CurrentSession {
  user: UserProfile;
  organization: Organization;
  role: Role;
}
