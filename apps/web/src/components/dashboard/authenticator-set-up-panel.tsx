import Link from 'next/link';

import { StatePanel } from '@/components/patterns/state-panel';
import { Button } from '@/components/ui/button';
import { AUTHENTICATOR_SET_UP_URL } from '@/lib/auth/authenticator-set-up';

/**
 * What the dashboard layout shows in place of the page when the member must
 * set up an authenticator first and the page's own check did not send them to
 * set-up (a session whose token still says aal2 after its last verified factor
 * was removed: the pages answer that from the token alone). Rendered, never a
 * redirect: no dashboard layout redirects to a page under itself.
 */
export function AuthenticatorSetUpPanel() {
  return (
    <div className="w-full px-4 py-16 sm:px-8 sm:py-24">
      <StatePanel
        kind="forbidden"
        size="page"
        headingLevel={1}
        title="Set up an authenticator to continue"
        description="Your organization requires two-factor authentication. Set up your authenticator app in Security settings, then come back."
        action={
          <Button asChild size="sm">
            <Link href={AUTHENTICATOR_SET_UP_URL} prefetch={false}>
              Go to Security settings
            </Link>
          </Button>
        }
      />
    </div>
  );
}
