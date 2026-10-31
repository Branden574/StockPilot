import type { ModuleId } from '@stockpilot/core';

import { ModuleCheckFailed } from './module-check-failed';
import { ModuleNotEnabled } from './module-not-enabled';

/**
 * What a module's page shows in place of its content when `checkModuleAccess`
 * did not answer "on": the module-off panel when the module is off, and "We
 * couldn't check whether this module is on" with Try again when its state
 * could not be read (`checkFailed`). A failed read is not "off": the module-off
 * panel would send an admin to switch on a module that is on, and everyone
 * else to ask for it, until a reload. Either way the page reads and offers
 * nothing, so access still fails closed.
 *
 * Every gated page draws its panel through here (a guard test holds every
 * other file to it), so a page can never tell one of the two apart from the
 * other again. `access` is the answer `checkModuleAccess` gave for `moduleId`.
 */
export function ModuleUnavailable({
  moduleId,
  access,
}: {
  moduleId: ModuleId;
  access: { canManage: boolean; checkFailed?: boolean };
}) {
  return access.checkFailed ? (
    <ModuleCheckFailed moduleId={moduleId} />
  ) : (
    <ModuleNotEnabled moduleId={moduleId} canManage={access.canManage} />
  );
}
