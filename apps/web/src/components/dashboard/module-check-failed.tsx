import { StatePanel } from '@/components/patterns/state-panel';
import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

import { TryAgainButton } from './try-again-button';

/**
 * Rendered by a module's page in place of its content when the module's state
 * could not be read (`checkModuleAccess` answered `checkFailed`). A failed
 * read is not "module off": the module-off panel would tell an admin to
 * switch on a module that is on, and everyone else to ask for it. Access
 * still fails closed: the page reads and offers nothing it would only show
 * with the module on. Try again asks the server for the page again.
 *
 * The look is ModuleNotEnabled's (StatePanel at page size, its title the
 * page's only h1, the same gutters), with the failed-read icon.
 */
export function ModuleCheckFailed({ moduleId }: { moduleId: ModuleId }) {
  const title = MODULE_REGISTRY[moduleId].title;
  return (
    <div className="w-full px-4 py-16 sm:px-8 sm:py-24">
      <StatePanel
        kind="failed"
        size="page"
        headingLevel={1}
        title={<>We couldn&apos;t check whether {title} is on</>}
        description="This is usually temporary. Try again in a moment."
        action={<TryAgainButton />}
      />
    </div>
  );
}
