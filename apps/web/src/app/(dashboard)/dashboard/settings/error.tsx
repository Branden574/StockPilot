'use client';

import { RefreshCw } from 'lucide-react';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
import {
  activeSettingsEntry,
  SETTINGS_HUB_HREF,
  SETTINGS_NAV_GROUPS,
  SettingsPage,
} from '@/components/settings/settings-nav';
import { Button } from '@/components/ui/button';
import { reportError } from '@/lib/error-reporter';

/**
 * A settings page could not be read.
 *
 * Without this boundary a settings page that threw (a failed server read)
 * rose to the dashboard's boundary, which replaced the whole settings area,
 * its sub-nav included, with "Something broke loading this page", so every
 * other settings page was out of reach from there. This file sits below the
 * settings layout (an error file never wraps the layout of its own segment),
 * so the sub-nav stays and only the page's column shows the failure: the
 * page's own title and way back, the failed-read panel (DESIGN-SPEC 6.21
 * states) with the error id, and Try again, which reads the page again.
 *
 * The thrown message is never shown: a server error reaches the browser as a
 * generic sentence with a digest, and the digest is what matches the logs.
 */
export default function SettingsError({
  error,
  retry,
  reset,
}: {
  error: unknown;
  retry?: () => void;
  reset?: () => void;
}) {
  const pathname = usePathname();
  const onHub = pathname === SETTINGS_HUB_HREF;
  const entry = onHub ? null : activeSettingsEntry(SETTINGS_NAV_GROUPS, pathname);
  const digest =
    error instanceof Error ? ((error as Error & { digest?: string }).digest ?? null) : null;

  React.useEffect(() => {
    void reportError(error, {
      tag: 'settings.render',
      level: 'error',
      extra: { digest, path: pathname },
    });
  }, [error, digest, pathname]);

  return (
    <SettingsPage>
      <PageHeader
        title={entry?.title ?? 'Settings'}
        back={
          onHub ? undefined : (
            <PageHeaderBackLink href={SETTINGS_HUB_HREF}>← Back to settings</PageHeaderBackLink>
          )
        }
      />
      <StatePanel
        kind="failed"
        live="assertive"
        headingLevel={null}
        title="We couldn't load this settings page"
        description={
          <>
            Something went wrong reading it. This is usually temporary, so try again in a moment.
            {onHub ? null : ' The other settings pages still work.'}
            {digest ? (
              <span className="mt-1 block font-mono text-[11px]">Error id: {digest}</span>
            ) : null}
          </>
        }
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => (retry ?? reset)?.()}>
            <RefreshCw aria-hidden /> Try again
          </Button>
        }
      />
    </SettingsPage>
  );
}
