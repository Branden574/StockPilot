import { can, hasPermission, type Permission, type Role } from '@stockpilot/core';

export class PermissionDeniedError extends Error {
  readonly code = 'forbidden' as const;
  constructor(public permission: Permission) {
    super(`Permission denied: ${permission}`);
  }
}

export function assertPermission(role: Role, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw new PermissionDeniedError(permission);
  }
}

export { can, hasPermission };
