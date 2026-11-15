import { StatePanel } from '@/components/patterns/state-panel';
import { buttonVariants } from '@/components/ui/button';
import { AUTHENTICATOR_SET_UP_URL } from '@/lib/auth/authenticator-set-up';

/**
 * A prompt the dashboard layout shows where the page would be, on a full page
 * load or a refresh, for a session whose token says the code was entered but
 * that has no verified authenticator left, on a page that is not open before
 * set-up. Rendered, never a redirect: no dashboard layout redirects to a page
 * under itself.
 *
 * It is not a data stop: the page below still runs and is in the response
 * (a layout that leaves out its children does not stop them). That session's
 * reads and writes are refused where the services ask for an authenticator.
 *
 * The button is a plain anchor, so pressing it loads the security page as a
 * new document and the layout is rendered again for it. A client-side
 * navigation would keep this layout's output, and the panel with it.
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
          <a href={AUTHENTICATOR_SET_UP_URL} className={buttonVariants({ size: 'sm' })}>
            Go to Security settings
          </a>
        }
      />
    </div>
  );
}
