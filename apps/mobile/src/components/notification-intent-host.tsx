import { useNetworkState } from 'expo-network';
import {
  type Href,
  useNavigationContainerRef,
  usePathname,
  useRouter,
  useSegments,
} from 'expo-router';
import * as React from 'react';

import { NotificationIntentNotice } from '@/components/notification-intent-notice';
import { useAuth } from '@/lib/auth-context';
import { useColdLaunchGate } from '@/lib/cold-launch-gate';
import { isOfflineState } from '@/lib/exceptions-api';
import {
  notificationIntents,
  usePendingNotificationIntent,
  type CapturedIntent,
} from '@/lib/notification-intent';
import {
  createWorkspaceChecks,
  focusedStackRoute,
  nextOpenStep,
  resolutionReason,
  resolveTargetWorkspace,
  stepAfterResolution,
  targetNoun,
  type IntentNotice,
  type NoticeActionId,
} from '@/lib/notification-open';
import {
  errorClassOf,
  pushOpenDiag,
  reportPushOpenError,
  type PushOpenReason,
} from '@/lib/push-open-diagnostics';
import { supabase } from '@/lib/supabase';
import { setTourVisible, useWhatsNewOpen } from '@/lib/tour-targets';
import {
  getWorkspaceSnapshot,
  retryWorkspace,
  setActiveOrg,
  useWorkspaceSnapshot,
} from '@/lib/use-workspace';

/** The interruption lock (tour-targets.ts): What's New waits while it shows. */
const NOTICE_LOCK_ID = 'notification-notice';

/** A notice on screen, for one tap. */
interface ShownNotice {
  seq: number;
  notice: IntentNotice;
  /** A workspace switch is under way. */
  busy: boolean;
}

/**
 * The root Stack's focused route from the LIVE navigation state
 * (notification-open.ts focusedStackRoute), or null when it cannot be read:
 * the effect then waits, as for a navigator that is not mounted.
 */
function liveStackRoute(navigation: {
  isReady(): boolean;
  getRootState(): unknown;
}): string | null {
  if (!navigation.isReady()) return null;
  try {
    return focusedStackRoute(navigation.getRootState());
  } catch {
    return null;
  }
}

/** The native route's first segment, for the diagnostics' route kind. */
function routeKindOf(path: string): string {
  return path.split('?')[0]?.split('/')[1] ?? '';
}

/**
 * OPENS A TAPPED NOTIFICATION (Phase 3, iPhone push tap).
 *
 * notification-intent.ts captures the tap from the first moment of the JS
 * runtime; this opens it once the app can show it. RootGate mounts it with
 * the Stack, so never over MFA, the Face ID lock or a disabled account.
 * Every wait is a real signal (notification-open.ts nextOpenStep): MFA still
 * being checked after a password sign-in, the navigator and its live route,
 * the sign-in group, whose tap it is, the workspace. Nothing is consumed
 * before the final step, so a gate that unmounts this (and the navigator)
 * cannot lose the destination: it is opened when the shell comes back.
 *
 * It opens with router.push, over Home on a cold start (Back goes Home) and
 * over the current screen otherwise; the order screen's own RLS-scoped read
 * is the re-authorisation. A user in more than one workspace has an order or
 * a return checked first, and is offered the switch, never switched
 * silently. That read answers within 15 seconds (then Try again), and a read
 * still out after about 400 ms puts up a Checking notice, so a slow
 * connection never looks like a dead tap (notification-open.ts
 * createWorkspaceChecks). A tap never approves, posts stock, opens Outlook or
 * sends email: this only reads and navigates
 * (notification-intent-wiring.test.ts).
 */
export function NotificationIntentHost() {
  const { user, mfaPending } = useAuth();
  const intent = usePendingNotificationIntent();
  const segments = useSegments();
  const pathname = usePathname();
  const navigation = useNavigationContainerRef();
  const router = useRouter();
  const workspace = useWorkspaceSnapshot();
  const { splashActive } = useColdLaunchGate();
  const whatsNewOpen = useWhatsNewOpen();
  const offline = isOfflineState(useNetworkState());

  const [shown, setShown] = React.useState<ShownNotice | null>(null);
  // A notice belongs to one tap: a newer tap, or none, closes it.
  const notice = shown && intent && shown.seq === intent.seq ? shown : null;
  /** This host's workspace reads, one at a time (notification-open.ts). */
  const [checks] = React.useState(() =>
    createWorkspaceChecks(() => notificationIntents.peek()?.seq ?? null),
  );

  const mounted = React.useRef(false);
  /** The last wait reported, so a wait leaves one breadcrumb. */
  const lastWait = React.useRef<string | null>(null);
  const currentPath = React.useRef(pathname);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  React.useEffect(() => {
    currentPath.current = pathname;
  }, [pathname]);

  // A newer tap, or none (a sign-out, a Close that finished the tap), ends a
  // workspace check still out for an older one, timer and all; an unmount
  // ends any. Each answer, and a timed-out read too, ends its own.
  const pendingSeq = intent?.seq ?? null;
  React.useEffect(() => {
    checks.keepOnly(pendingSeq);
  }, [checks, pendingSeq]);
  React.useEffect(() => () => checks.cancel(), [checks]);

  const userId = user?.id ?? null;
  const userEmail = user?.email ?? null;

  /** Open the page, unless it is already in front, and finish the tap. */
  const open = React.useCallback(
    (it: CapturedIntent, path: string, outcome: PushOpenReason) => {
      if (currentPath.current === path) {
        notificationIntents.finish(it, 'already-there');
        return;
      }
      try {
        router.push(path as Href);
      } catch (err) {
        reportPushOpenError(err);
        pushOpenDiag({
          stage: 'error',
          source: it.source,
          reason: 'navigate-failed',
          errorClass: errorClassOf(err),
        });
        notificationIntents.finish(it, 'navigate-failed');
        return;
      }
      pushOpenDiag({ stage: 'navigate', source: it.source, routeKind: routeKindOf(path) });
      notificationIntents.finish(it, outcome);
    },
    [router],
  );

  React.useEffect(() => {
    if (!intent || notice || checks.running(intent.seq)) return;
    const take = notificationIntents.take(
      userId ? { id: userId, email: userEmail } : null,
      Date.now(),
    );
    const step = nextOpenStep({
      take,
      forSeq: intent.seq,
      mfaPending,
      routerReady: navigation.isReady(),
      stackRoute: liveStackRoute(navigation),
      segments,
      pathname,
      workspace,
    });
    // Every branch acts on the tap take() handed over, which nextOpenStep
    // has matched to this render's: a newer tap captured since is idle here
    // and opened by the re-render it causes, never opened as this one.
    if (step.kind === 'idle' || take.kind === 'none') return;
    const it = take.intent;
    switch (step.kind) {
      case 'wait': {
        const key = `${it.seq}:${step.reason}`;
        if (lastWait.current === key) return;
        lastWait.current = key;
        pushOpenDiag({ stage: 'wait', source: it.source, reason: step.reason });
        return;
      }
      case 'drop':
        notificationIntents.finish(it, step.reason);
        return;
      case 'stay':
        notificationIntents.finish(it, 'already-there');
        return;
      case 'navigate':
        open(it, step.path, 'navigated');
        return;
      case 'notice':
        pushOpenDiag({ stage: 'notice', source: it.source, reason: step.notice.kind });
        // eslint-disable-next-line react-hooks/set-state-in-effect -- the notice answers a tap the store has just handed over; take() reads the clock, so no render can derive it
        setShown({ seq: it.seq, notice: step.notice, busy: false });
        return;
      case 'resolve': {
        const { seq, source, target } = it;
        if (!target.ok) return;
        pushOpenDiag({ stage: 'resolve', source, routeKind: target.routeKind });
        // The read always answers (its 15 s deadline is an answer too), and
        // only this attempt's answer counts: Try again starts another.
        checks.start(seq, () => resolveTargetWorkspace(supabase, step.table, step.id), {
          // Still reading after a moment: say so, so a slow connection never
          // looks like a dead tap (orchestrator decision (b)).
          checking: () => {
            pushOpenDiag({ stage: 'notice', source, reason: 'checking' });
            setShown({
              seq,
              notice: { kind: 'checking', noun: targetNoun(target.routeKind) },
              busy: false,
            });
          },
          answer: (resolution) => {
            const current = notificationIntents.peek();
            const next = stepAfterResolution({
              answerSeq: seq,
              currentSeq: current?.seq ?? null,
              resolution,
              native: target.native,
              routeKind: target.routeKind,
              workspace: getWorkspaceSnapshot(),
              pathname: currentPath.current,
            });
            pushOpenDiag({
              stage: 'resolve',
              source,
              reason: resolutionReason(resolution, next),
              ...(resolution.kind === 'error' ? { errorClass: resolution.errorClass } : {}),
            });
            if (!current || next.kind === 'idle') return;
            // The answer replaces the Checking notice, or ends it.
            if (next.kind === 'notice') {
              pushOpenDiag({ stage: 'notice', source, reason: next.notice.kind });
              setShown({ seq, notice: next.notice, busy: false });
              return;
            }
            setShown(null);
            if (next.kind === 'navigate') open(current, next.path, 'navigated');
            else if (next.kind === 'stay') notificationIntents.finish(current, 'already-there');
          },
        });
        return;
      }
    }
  }, [
    intent,
    notice,
    userId,
    userEmail,
    mfaPending,
    navigation,
    segments,
    pathname,
    workspace,
    open,
    checks,
  ]);

  const onAction = (id: NoticeActionId) => {
    if (!notice) return;
    const pending = notificationIntents.peek();
    const it = pending && pending.seq === notice.seq ? pending : null;
    if (!it) {
      setShown(null);
      return;
    }
    switch (id) {
      case 'switch': {
        if (notice.notice.kind !== 'switch' || notice.busy || offline) return;
        const { orgId, native } = notice.notice;
        const { seq } = notice;
        setShown({ ...notice, busy: true });
        // The drawer's own switch: it replaces this phone's offline copy of
        // the old workspace and loads the new one.
        setActiveOrg(orgId).then(
          () => {
            if (!mounted.current) return;
            const now = notificationIntents.peek();
            if (!now || now.seq !== seq) return; // a newer tap took over
            setShown(null);
            if (getWorkspaceSnapshot().activeOrgId === orgId) open(now, native, 'switched');
            else notificationIntents.finish(now, 'switch-failed');
          },
          (err: unknown) => {
            pushOpenDiag({
              stage: 'error',
              source: it.source,
              reason: 'switch-failed',
              errorClass: errorClassOf(err),
            });
            if (mounted.current) setShown((s) => (s && s.seq === seq ? { ...s, busy: false } : s));
          },
        );
        return;
      }
      case 'retry':
        setShown(null);
        // No workspace on screen (a start offline): load it again as well. The
        // effect then waits for it and reads the order's workspace again.
        if (!getWorkspaceSnapshot().activeOrgId) void retryWorkspace();
        return;
      case 'open-notifications':
        setShown(null);
        open(it, '/notifications', 'open-inbox');
        return;
      case 'not-now':
        setShown(null);
        notificationIntents.finish(it, 'not-now');
        return;
      case 'ok':
        setShown(null);
        notificationIntents.finish(it, 'ok');
        return;
      case 'close':
        setShown(null);
        notificationIntents.finish(it, 'closed');
        return;
    }
  };

  // The notice waits for the cold-launch splash and for What's New, and holds
  // the interruption lock while it shows so What's New waits for it in turn.
  const visible = notice !== null && !splashActive && !whatsNewOpen;
  React.useEffect(() => {
    if (!visible) return;
    setTourVisible(NOTICE_LOCK_ID, true);
    return () => setTourVisible(NOTICE_LOCK_ID, false);
  }, [visible]);

  if (!visible || !notice) return null;
  return (
    <NotificationIntentNotice
      notice={notice.notice}
      busy={notice.busy}
      offline={offline}
      onAction={onAction}
    />
  );
}
