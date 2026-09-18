'use client';

import { usePathname } from 'next/navigation';
import * as React from 'react';

import { capture } from '@/lib/analytics';
import { refreshRequired } from '@/lib/updates/detector';
import {
  UNREAD_NOTICE_DELAY_MS,
  acknowledgeReloadOutcome,
  cancelRefresh,
  checkForUpdate,
  closeWhatsNew,
  dismissNotice,
  noteNoticeShown,
  openWhatsNew,
  recheckUnsaved,
  requestRefresh,
  retryRelease,
  selectNotice,
  startUpdateCenter,
  useUpdateState,
  type Notice,
} from '@/lib/updates/update-store';

import { WHATS_NEW_ENTRY_ID } from './constants';
import { ReleaseDrawer } from './release-drawer';
import { UpdateCard, updateAnnouncement, type UpdateCardModel } from './update-card';

/**
 * True while a product tour is on screen. Tours and the What's New notice share
 * a corner and a rule: one interruption at a time. The old modal checked this
 * ONCE, 1.2s after load, and never again, so it could stack on a tour that
 * started later and never appeared after one that ended. This watches.
 */
function useTourOpen(): boolean {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const read = () => setOpen(document.querySelector('[data-tour-open]') !== null);
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return open;
}

function toModel(notice: Notice, reloadFailed: boolean): UpdateCardModel | null {
  if (notice.kind === 'none') return null;
  if (reloadFailed && (notice.kind === 'update' || notice.kind === 'rollback'))
    return { kind: 'reload-failed' };
  if (notice.kind === 'rollback') return { kind: 'rollback' };
  if (notice.kind === 'unread') return { kind: 'unread', release: notice.release };
  return { kind: 'update', release: notice.release };
}

/**
 * The product-update experience for the dashboard: one notice, one drawer.
 * Replaces VersionNotifier and the auto-opening What's New modal, which were two
 * systems answering one question from two corners of the screen.
 *
 * It renders exactly ONE notice at a time (selectNotice), never opens the drawer
 * by itself, and never reloads by itself.
 */
export function UpdateCenter({
  userId,
  organizationId,
}: {
  userId: string;
  organizationId: string;
}) {
  const state = useUpdateState();
  const pathname = usePathname();
  const tourOpen = useTourOpen();
  const cardRef = React.useRef<HTMLDivElement>(null);

  // Person AND organization: the release list is filtered by role, permissions
  // and modules, all of which belong to the pair. Switching either is a soft
  // navigation, and the store has to be told.
  React.useEffect(() => startUpdateCenter(userId, organizationId), [userId, organizationId]);

  // While "you have unsaved changes" is on screen, keep checking that it is still
  // true. The person is being asked to go and save; when they have, the card must
  // stop saying otherwise. It only ever clears the claim. It never reloads.
  const confirming = state.blockedBy.length > 0;
  React.useEffect(() => {
    if (!confirming) return;
    const t = window.setInterval(recheckUnsaved, 1_000);
    return () => window.clearInterval(t);
  }, [confirming]);

  // The person just navigated: a good, cheap moment to ask. Deduped in the store.
  React.useEffect(() => {
    void checkForUpdate();
  }, [pathname]);

  const notice = selectNotice(state);

  // "What's new" with no refresh behind it is not urgent. Let the page paint
  // first, as the modal it replaces did. A pending refresh is shown at once.
  const [unreadReady, setUnreadReady] = React.useState(false);
  React.useEffect(() => {
    const t = window.setTimeout(() => setUnreadReady(true), UNREAD_NOTICE_DELAY_MS);
    return () => window.clearTimeout(t);
  }, []);

  const startingTour =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('tour');
  const visible =
    notice.kind !== 'none' &&
    !state.drawerOpen &&
    !tourOpen &&
    !(notice.kind === 'unread' && (!unreadReady || startingTour));
  const model = visible ? toModel(notice, state.reloadOutcome === 'not_reached') : null;

  // The notice object is rebuilt every render; this key is its identity. An
  // impression is the key becoming visible, not a render of it.
  const noticeKey =
    notice.kind === 'none'
      ? null
      : notice.kind === 'unread'
        ? `unread:${notice.release.id}@${notice.release.revision}`
        : `${notice.kind}:${notice.build}`;
  const shownKey = model ? noticeKey : null;
  const noticeRef = React.useRef(notice);
  React.useEffect(() => {
    noticeRef.current = notice;
  });
  React.useEffect(() => {
    if (shownKey) noteNoticeShown(noticeRef.current);
  }, [shownKey]);

  // Transient toasts share this corner and paint above everything. Lift their
  // stack by the card's height so they land on top of it, not over it.
  // Keyed on whether there IS a card, not on `model`: that object is rebuilt on
  // every render, which tore down and rebuilt the observer each time. The
  // observer itself follows the card's height (the confirmation is taller).
  const hasCard = model !== null;
  React.useEffect(() => {
    const root = document.documentElement;
    if (!hasCard || !cardRef.current) {
      root.style.removeProperty('--sp-update-card-offset');
      root.removeAttribute('data-sp-update-card');
      return;
    }
    const apply = () => {
      const h = cardRef.current?.getBoundingClientRect().height ?? 0;
      root.style.setProperty('--sp-update-card-offset', `${Math.round(h) + 12}px`);
      root.setAttribute('data-sp-update-card', '');
    };
    apply();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    if (ro && cardRef.current) ro.observe(cardRef.current);
    return () => {
      ro?.disconnect();
      root.style.removeProperty('--sp-update-card-offset');
      root.removeAttribute('data-sp-update-card');
    };
  }, [hasCard]);

  const needsRefresh = refreshRequired(state.status);

  return (
    <>
      {/* Exists BEFORE any text is put in it, or screen readers say nothing. Text
          only: the card's buttons are not part of the announcement. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {model ? updateAnnouncement(model, state.blockedBy) : ''}
      </div>

      {model ? (
        <div
          ref={cardRef}
          className="pointer-events-none fixed inset-x-4 bottom-4 z-40 flex justify-end sm:inset-x-auto sm:bottom-6 sm:right-6"
        >
          <UpdateCard
            model={model}
            blockedBy={state.blockedBy}
            onWhatsNew={() =>
              openWhatsNew('release' in notice ? notice.release?.id : null, 'notification')
            }
            onRefresh={() => {
              acknowledgeReloadOutcome();
              requestRefresh();
            }}
            onRefreshAnyway={() => requestRefresh({ force: true })}
            onKeepWorking={cancelRefresh}
            onDismiss={() => dismissNotice(notice)}
          />
        </div>
      ) : null}

      <ReleaseDrawer
        open={state.drawerOpen}
        detail={state.detail}
        refreshRequired={needsRefresh}
        rolledBack={state.status === 'rolled_back'}
        blockedBy={state.drawerOpen ? state.blockedBy : []}
        saveFailed={state.saveFailed}
        onClose={closeWhatsNew}
        onRetry={retryRelease}
        onRefresh={() => requestRefresh()}
        onRefreshAnyway={() => requestRefresh({ force: true })}
        onKeepWorking={cancelRefresh}
        onLinkClick={(entry) => {
          capture('release_feature_link_clicked', { entryId: entry.id, entryPoint: 'drawer' });
          closeWhatsNew();
        }}
        returnFocusTo={() => document.getElementById(WHATS_NEW_ENTRY_ID)}
      />
    </>
  );
}
