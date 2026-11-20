'use client';

import { RefreshCw } from 'lucide-react';

import { StatePanel } from '@/components/patterns/state-panel';
import { Button } from '@/components/ui/button';
import { ACCESS_UNCHECKED_DIGEST, knownErrorState } from '@/lib/known-error-states';

/** The words of the pages' own "couldn't check your access" card. */
const CARD = knownErrorState({ digest: ACCESS_UNCHECKED_DIGEST })!;

/**
 * What the dashboard layout shows IN PLACE of the page, on a page that is not
 * open before set-up, for a session whose token says aal2 while the member
 * has no verified authenticator left, when the organization's authenticator
 * policy could not be read (the row came back hidden, or with a value that is
 * not a policy). The sibling of AuthenticatorSetUpPanel, which that session
 * gets when the policy was read: here whether set-up is owed is not known, so
 * it says what the pages' own card says, and offers Try again.
 *
 * The page's own rule refuses that session too (requireOrgContext(),
 * lib/auth/step-up-gate.ts aal2SessionHeldForUnreadPolicy), before any work;
 * this panel is what the layout draws instead of the page's children.
 *
 * TRY AGAIN IS A FULL PAGE LOAD, as on AccessUncheckedBanner: the layout is
 * rendered again with the page, and nothing is opened by it.
 */
export function AccessUncheckedPanel() {
  return (
    <div className="w-full px-4 py-16 sm:px-8 sm:py-24" data-access-unchecked-panel="">
      <StatePanel
        kind="failed"
        size="page"
        headingLevel={1}
        title={CARD.title}
        description={CARD.body}
        action={
          <Button type="button" size="sm" onClick={() => window.location.reload()}>
            <RefreshCw aria-hidden /> Try again
          </Button>
        }
      />
    </div>
  );
}
