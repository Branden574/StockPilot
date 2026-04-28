export const ROLES = ['owner', 'admin', 'manager', 'staff', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export interface RoleDefinition {
  id: Role;
  name: string;
  description: string;
  rank: number;
}

export const ROLE_DEFINITIONS: Record<Role, RoleDefinition> = {
  owner: {
    id: 'owner',
    name: 'Owner',
    description: 'Full control including billing and organization deletion.',
    rank: 100,
  },
  admin: {
    id: 'admin',
    name: 'Admin',
    description: 'Manage inventory, team, and settings.',
    rank: 80,
  },
  manager: {
    id: 'manager',
    name: 'Manager',
    description: 'Manage inventory, suppliers, and purchase orders.',
    rank: 60,
  },
  staff: {
    id: 'staff',
    name: 'Staff',
    description: 'Add, edit, and adjust stock. Scan items.',
    rank: 40,
  },
  viewer: {
    id: 'viewer',
    name: 'Viewer',
    description: 'Read-only access.',
    rank: 20,
  },
};

export function roleRank(role: Role): number {
  return ROLE_DEFINITIONS[role].rank;
}

export function isAtLeast(role: Role, minimum: Role): boolean {
  return roleRank(role) >= roleRank(minimum);
}
