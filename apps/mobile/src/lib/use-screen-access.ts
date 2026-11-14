import type { Permission } from '@stockpilot/core';

import { useAuth } from './auth-context';
import { refreshEnabledModules, useEnabledModulesState } from './enabled-modules';
import {
  createControlOffer,
  type CreateControlOffer,
  drawerEntryAccess,
  permissionAccess,
  type ScreenAccess,
} from './screen-access';
import { refreshCacheOwner, useCacheOwnerState } from './use-cache-owner';
import {
  refreshEffectivePermissions,
  useEffectivePermissionsState,
} from './use-effective-permissions';
import { useRole } from './use-role';

/**
 * Whether the screen behind this side-menu link opens for the member, by the
 * menu's own rule, decided only from what this account saved
 * (screen-access.ts drawerEntryAccess).
 */
export function useDrawerEntryAccess(href: string): ScreenAccess {
  const saved = useEffectivePermissionsState();
  const modules = useEnabledModulesState();
  const owner = useCacheOwnerState();
  const { user } = useAuth();
  const { role, loading: roleLoading } = useRole();
  return drawerEntryAccess(href, {
    saved,
    modules,
    owner,
    liveUserId: user?.id ?? null,
    role,
    roleLoading,
  });
}

/**
 * Whether the member holds this permission, decided only from what this
 * account saved (screen-access.ts permissionAccess).
 */
export function usePermissionAccess(permission: Permission): ScreenAccess {
  const saved = useEffectivePermissionsState();
  const owner = useCacheOwnerState();
  const { user } = useAuth();
  const { role, loading: roleLoading } = useRole();
  return permissionAccess(permission, {
    saved,
    owner,
    liveUserId: user?.id ?? null,
    role,
    roleLoading,
  });
}

/**
 * Whether a control that only leads to a write the server checks with this
 * permission is offered (screen-access.ts createControlOffer): one rule for
 * every create control.
 */
export function useCreateControlOffer(permission: Permission): CreateControlOffer {
  const access = usePermissionAccess(permission);
  const { role, loading: roleLoading } = useRole();
  return createControlOffer(access, permission, role, roleLoading);
}

/**
 * Try again after a read of the saved access failed ('unreadable'): reads the
 * saved permissions, modules and whose cache this is again. Never rejects.
 */
export function retrySavedAccess(): Promise<void> {
  return Promise.all([
    refreshEffectivePermissions(),
    refreshEnabledModules(),
    refreshCacheOwner(),
  ]).then(() => undefined);
}
