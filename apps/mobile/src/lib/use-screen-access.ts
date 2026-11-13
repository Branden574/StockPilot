import { useEnabledModulesState } from './enabled-modules';
import { drawerEntryAccess, type ScreenAccess } from './screen-access';
import { useEffectivePermissionsState } from './use-effective-permissions';
import { useRole } from './use-role';

/**
 * Whether the screen behind this side-menu link opens for the member, by the
 * menu's own rule, once the saved permissions, the saved modules and (with
 * nothing saved) the role are known (screen-access.ts drawerEntryAccess).
 */
export function useDrawerEntryAccess(href: string): ScreenAccess {
  const saved = useEffectivePermissionsState();
  const modules = useEnabledModulesState();
  const { role, loading: roleLoading } = useRole();
  return drawerEntryAccess(href, { saved, modules, role, roleLoading });
}
