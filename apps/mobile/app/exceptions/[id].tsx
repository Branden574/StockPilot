import { useNetworkState } from 'expo-network';
import { type Href, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  ESCALATE_TO_MAINTENANCE_HELP,
  ESCALATE_TO_MAINTENANCE_LABEL,
  EXCEPTION_ACTION_LABELS,
  EXCEPTION_FIRST_CHECK_PENDING_COPY,
  exceptionCheckedAtCopy,
  EXCEPTION_RULES,
  activeRecountCopy,
  describeOccurrence,
  describeTimelineEvent,
  exceptionActDisabledReason,
  isRecountableRule,
  occurrenceState,
  occurrenceStateLabel,
  recountDisabledReason,
  recurrenceBadge,
  OCCURRENCE_RESOLVED_REASON_COPY,
  RECOUNT_COUNTS_TOTAL_COPY,
  recountUnavailableCopy,
  type OccurrenceState,
} from '@stockpilot/core';

import { ExceptionEvidenceSection } from '@/components/exception-evidence-section';
import { ExceptionNoteSheet } from '@/components/exception-note-sheet';
import { ExceptionRecountSheet } from '@/components/exception-recount-sheet';
import { ItemVerificationCard, MIN_TAP, useItemVerification } from '@/components/item-verification-card';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Eyebrow, Mono } from '@/components/ui/text';
import { useAuth } from '@/lib/auth-context';
import { showWriteCta } from '@/lib/cta-gating';
import { useEnabledModules } from '@/lib/enabled-modules';
import { escalateFormRoute, escalationSectionView } from '@/lib/exception-escalation';
import { evidenceTick, evidenceTimelineLines } from '@/lib/exception-evidence';
import {
  describeExceptionsRequestError,
  EXCEPTION_WORKSPACE_UNAVAILABLE,
  exceptionActionRoute,
  exceptionActionsFor,
  exceptionTimeLabel,
  getException,
  isOfflineState,
  recalledDetail,
  rememberDetail,
  type ExceptionSheetMode,
  type MobileExceptionDetail,
} from '@/lib/exceptions-api';
import { useEffectivePermissions } from '@/lib/use-effective-permissions';
import { useOrg } from '@/lib/use-org';
import { useRole } from '@/lib/use-role';
import { useTheme } from '@/lib/use-theme';
import { retryWorkspace } from '@/lib/use-workspace';
import { canOpenCountScreen } from '@/lib/verification-api';

/**
 * One exception (F1-1): the native twin of /dashboard/exceptions/[id]. Reads
 * GET /api/v1/exceptions/[id] (the service the web page renders): the
 * condition in core's words, possible causes, what clears it, the timeline
 * and every earlier occurrence of the same condition.
 *
 * Acknowledge and Add note open ExceptionNoteSheet. Both are offered only when
 * the server says this reader may act (canAct), and both are DISABLED, with
 * the reason, while the phone is offline (core exceptionActDisabledReason,
 * fed the live network state). Nothing here resolves an exception.
 *
 * A failed read is an error on screen, never a blank page; offline, the copy
 * this session last loaded is shown with its time.
 *
 * RECOUNT (F1-2): on a count_variance or over_reserved exception, the linked
 * recount and how far it has got (tap to open the count), and a Recount button
 * for a reader the server says can start one (canRecount). It needs a
 * connection: offline the button is disabled with the reason. A closed
 * recount's timeline entry says what it found (core describeTimelineEvent).
 *
 * LAST PHYSICAL COUNT (F1-3): the item's card (components/item-verification-card.tsx),
 * with its own read, so a failure there never hides the exception. The
 * location, when the exception has one, opens the location screen. The card
 * offers no "Count this item" here, as on the web: a holding rule is not
 * settled by counting the item (recounting a Staging or archived-location
 * holding can correct the wrong place, core EXCEPTION_RULES.recountable), and
 * a rule a count can settle has the Recount button. "Count this item" stays
 * on the item screen.
 *
 * PHOTOS (F1-4): components/exception-evidence-section.tsx, fed the detail's
 * `evidence` block. Online only: offline its add control is disabled with the
 * reason and nothing is queued. A photo counts as added only once the server
 * recorded it; the section re-reads this screen after each one. Evidence
 * events in the timeline are worded by core describeEvidenceEvent (the
 * photo's two times, each named by its clock).
 *
 * ESCALATE TO MAINTENANCE (F1-5, Outlook rule 3): the MAINTENANCE section
 * (lib/exception-escalation.ts escalationSectionView). "Escalated: MR-..."
 * shows to every reader of an escalated exception and opens the request for
 * a reader who can open it, with "Email draft opened" or "not yet opened"
 * (all StockPilot records; never "sent"). "Escalate to maintenance" is
 * offered on the web's gates: the server's canEscalate AND this phone's
 * enabled modules and maintenance_requests:submit. It opens the request form
 * prefilled from this exception (app/maintenance/new.tsx), where Save is the
 * explicit act; nothing is emailed from here, and the email opens only if
 * the person taps it on the request. Online only: offline the button is
 * disabled with the reason and nothing is kept to try later. Escalating
 * neither acknowledges nor resolves. Coming back from the form or the
 * request re-reads this screen, so the badge and the draft state are current.
 *
 * NO WORKSPACE (a launch offline, or a failed first read after signing in):
 * the read never starts, so the screen says so with Try again, which loads
 * the workspace again (retryWorkspace), as the location screen does.
 */

type Loaded =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      detail: MobileExceptionDetail;
      receivedAt: string;
      banner: string | null;
      /** When the read that produced `detail` started (evidenceTick): the
       *  Photos section retires an added photo's row once a read that
       *  started after it lands. 0 for a copy remembered from before. */
      readTick: number;
    }
  | { kind: 'error'; message: string };

export default function ExceptionDetailScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { orgId, loading: workspaceLoading } = useOrg();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const offline = isOfflineState(useNetworkState());
  // Escalate (F1-5): the phone's own view of the web's gates. Cosmetic; the
  // server's canEscalate and the database decide.
  const enabledModules = useEnabledModules();
  const maintenanceEnabled = enabledModules.has('maintenance_requests');
  const perms = useEffectivePermissions();
  const canSubmitMaintenance = showWriteCta(perms, 'maintenance_requests:submit');

  const [stored, setState] = React.useState<Loaded>({ kind: 'loading' });
  const [refreshing, setRefreshing] = React.useState(false);
  const [sheet, setSheet] = React.useState<ExceptionSheetMode | null>(null);
  const [recountOpen, setRecountOpen] = React.useState(false);
  // Bumped whenever this screen re-reads, so the card re-reads with it.
  const [verificationNonce, setVerificationNonce] = React.useState(0);
  const [retryingWorkspace, setRetryingWorkspace] = React.useState(false);
  const seqRef = React.useRef(0);

  const load = React.useCallback(async () => {
    // Offline there is nothing to ask; the view below is derived instead.
    if (!id || !orgId || offline) return;
    const seq = ++seqRef.current;
    const readTick = evidenceTick();
    try {
      const detail = await getException(id);
      if (seq !== seqRef.current) return;
      if (detail.organizationId !== orgId) {
        setState({
          kind: 'error',
          message: 'The server answered for a different workspace. Go back and switch workspace from the menu.',
        });
        return;
      }
      const receivedAt = new Date();
      rememberDetail(userId, orgId, detail, receivedAt);
      setState({ kind: 'ready', detail, receivedAt: receivedAt.toISOString(), banner: null, readTick });
    } catch (e) {
      if (seq !== seqRef.current) return;
      const status = (e as { status?: unknown }).status;
      const kept = recalledDetail(userId, orgId, id);
      if (status === 404) {
        setState({ kind: 'error', message: 'This exception is not available to you, or it no longer exists.' });
        return;
      }
      // Worded by status for a 429 or 5xx, so a bare code never shows.
      const message = describeExceptionsRequestError(e, 'Could not load this exception.');
      setState(
        kept
          ? {
              kind: 'ready',
              detail: kept.detail,
              receivedAt: kept.receivedAt,
              banner: `Could not refresh. Showing this exception as of ${exceptionTimeLabel(kept.receivedAt, kept.detail.timeZone)}.`,
              readTick: 0,
            }
          : { kind: 'error', message },
      );
    }
  }, [id, orgId, userId, offline]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await (offline returns before any set; that view is derived); the effect synchronizes with the server
    void load();
  }, [load]);

  // Set when this screen sends the person to the escalate form or to the
  // linked request. The next focus re-reads once, so coming back shows the
  // new badge, or "Email draft opened" after a draft opened there. A plain
  // focus (the first one, or load changing while focused) reads nothing
  // extra: the effect above already did.
  const rereadOnReturn = React.useRef(false);
  useFocusEffect(
    React.useCallback(() => {
      if (!rereadOnReturn.current) return;
      rereadOnReturn.current = false;
      void load();
    }, [load]),
  );

  // Offline the view is DERIVED, never fetched: the copy on screen (or the
  // one this session remembered) with its time, or a plain "needs a
  // connection". The act buttons are disabled below either way.
  // Only ever an answer for THIS id (a view for another occurrence is never
  // shown under this one's heading).
  const mine = stored.kind === 'ready' && stored.detail.occurrence.id !== id ? null : stored;
  let state: Loaded;
  if (offline) {
    const kept =
      mine?.kind === 'ready'
        ? { detail: mine.detail, receivedAt: mine.receivedAt, readTick: mine.readTick }
        : id
          ? recalledDetail(userId, orgId, id)
          : null;
    state = kept
      ? {
          kind: 'ready',
          detail: kept.detail,
          receivedAt: kept.receivedAt,
          banner: `You are offline. Showing this exception as of ${exceptionTimeLabel(kept.receivedAt, kept.detail.timeZone)}.`,
          readTick: 'readTick' in kept ? kept.readTick : 0,
        }
      : {
          kind: 'error',
          message:
            'You are offline. This exception needs a connection to load. Reconnect and pull down to try again.',
        };
  } else {
    state = mine ?? { kind: 'loading' };
  }

  async function refresh() {
    setRefreshing(true);
    setVerificationNonce((n) => n + 1);
    await load();
    setRefreshing(false);
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/exceptions' as Href);
  };

  // Try again with no workspace: load the workspace again; the read above
  // starts once it is there.
  async function reloadWorkspace() {
    setRetryingWorkspace(true);
    try {
      await retryWorkspace();
    } finally {
      setRetryingWorkspace(false);
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ArrowLeft} onPress={goBack} accessibilityLabel="Back" minTap />
        </View>
      </SafeAreaView>

      {!orgId && !workspaceLoading ? (
        <View style={{ paddingHorizontal: 20, marginTop: 9 }}>
          <Card padding={16}>
            <Body size={14.5} accessibilityRole="alert">
              {EXCEPTION_WORKSPACE_UNAVAILABLE}
            </Body>
            <Button
              variant="outline"
              size="sm"
              disabled={retryingWorkspace}
              onPress={() => void reloadWorkspace()}
              style={{ alignSelf: 'flex-start', marginTop: 14, minHeight: MIN_TAP }}
            >
              Try again
            </Button>
          </Card>
        </View>
      ) : state.kind === 'loading' ? (
        <ActivityIndicator color={c.ink4} style={{ marginTop: 29 }} />
      ) : state.kind === 'error' ? (
        <View style={{ paddingHorizontal: 20, marginTop: 9 }}>
          <Card padding={16}>
            <Body size={14.5} accessibilityRole="alert">
              {state.message}
            </Body>
            <View style={{ marginTop: 14, alignSelf: 'flex-start' }}>
              <Button variant="outline" size="sm" onPress={() => void refresh()} style={{ minHeight: MIN_TAP }}>
                Try again
              </Button>
            </View>
          </Card>
        </View>
      ) : (
        <Detail
          detail={state.detail}
          banner={state.banner}
          readTick={state.readTick}
          offline={offline}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          onOpenSheet={setSheet}
          onRecount={() => setRecountOpen(true)}
          maintenanceEnabled={maintenanceEnabled}
          canSubmitMaintenance={canSubmitMaintenance}
          onEscalate={(occurrence) => {
            rereadOnReturn.current = true;
            router.push(escalateFormRoute(occurrence) as unknown as Href);
          }}
          onOpenRequest={(requestId) => {
            rereadOnReturn.current = true;
            router.push(`/maintenance/${requestId}` as Href);
          }}
          onNavigate={(href) => router.push(href as Href)}
          onPhotosChanged={() => void load()}
          verificationRefreshKey={verificationNonce}
        />
      )}

      {state.kind === 'ready' ? (
        <ExceptionNoteSheet
          visible={sheet !== null}
          mode={sheet ?? 'note'}
          occurrence={state.detail.occurrence}
          online={!offline}
          onClose={() => setSheet(null)}
          onDone={() => {
            setSheet(null);
            // Re-read, so the chip and the timeline show what was just saved.
            void load();
          }}
        />
      ) : null}

      {state.kind === 'ready' ? (
        <ExceptionRecountSheet
          visible={recountOpen}
          title={
            state.detail.occurrence.reference
              ? `Recount for ${state.detail.occurrence.reference}`
              : 'Recount'
          }
          occurrenceIds={[state.detail.occurrence.id]}
          orgId={orgId ?? null}
          online={!offline}
          timeZone={state.detail.timeZone}
          onClose={() => setRecountOpen(false)}
          onDone={() => {
            setRecountOpen(false);
            // Re-read, so the state chip and the timeline show the recount.
            setVerificationNonce((n) => n + 1);
            void load();
          }}
          onOpenCount={(cycleCountId) => {
            setRecountOpen(false);
            router.push(`/cycle-count/${cycleCountId}` as Href);
          }}
        />
      ) : null}
    </View>
  );
}

function statePillTone(state: OccurrenceState): 'default' | 'ok' | 'warn' {
  if (state.kind === 'resolved') return 'ok';
  if (state.kind === 'open') return 'warn';
  return 'default';
}

function Detail({
  detail,
  banner,
  readTick,
  offline,
  refreshing,
  onRefresh,
  onOpenSheet,
  onRecount,
  maintenanceEnabled,
  canSubmitMaintenance,
  onEscalate,
  onOpenRequest,
  onNavigate,
  onPhotosChanged,
  verificationRefreshKey,
}: {
  detail: MobileExceptionDetail;
  banner: string | null;
  readTick: number;
  offline: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenSheet: (mode: ExceptionSheetMode) => void;
  onRecount: () => void;
  /** The maintenance_requests module is on for this workspace (this phone's
   *  view). */
  maintenanceEnabled: boolean;
  /** This reader holds maintenance_requests:submit (this phone's view). */
  canSubmitMaintenance: boolean;
  onEscalate: (occurrence: { id: string; locationId: string | null }) => void;
  onOpenRequest: (requestId: string) => void;
  onNavigate: (href: string) => void;
  onPhotosChanged: () => void;
  verificationRefreshKey: number;
}) {
  const { c } = useTheme();
  const o = detail.occurrence;
  // The item's last physical count (F1-3), read for the workspace this
  // exception belongs to. Not read for an item this reader cannot see (the
  // ITEM fact says so; the card would only repeat it).
  const verification = useItemVerification(
    o.item ? o.itemId : null,
    detail.organizationId,
    verificationRefreshKey,
  );
  // Counts are linked only for a reader who can open them (the web's rule).
  const { role } = useRole();
  const canOpenCounts = canOpenCountScreen(role, useEffectivePermissions());
  const meta = EXCEPTION_RULES[o.rule];
  const d = describeOccurrence(o.rule, o.facts, {
    itemName: o.item?.name ?? null,
    conditionSince: o.conditionSince,
    asOf: o.resolvedAt ?? new Date(),
  });
  const state = occurrenceState(
    {
      resolvedAt: o.resolvedAt,
      resolvedReason: o.resolvedReason,
      acknowledgedAt: o.acknowledgedAt,
      acknowledgedBy: o.acknowledgedBy?.id ?? null,
      recount: o.recount,
    },
    detail.syncState?.lastEvaluatedAt ?? null,
  );
  const recurred = recurrenceBadge(o.recurrenceIndex);
  const resolved = o.resolvedAt !== null;
  // Resolved or not permitted: the reason, and no buttons. Offline: the
  // buttons stay, DISABLED, with the reason.
  const disabledReason = exceptionActDisabledReason({ resolved, canAct: o.canAct, online: !offline });
  const showActButtons = !resolved && o.canAct;
  // Recount (F1-2): only where a count can settle the condition. Permission
  // first (a reader who may not start one is told so, online or not), then
  // the connection.
  const showRecount = isRecountableRule(o.rule) && !resolved;
  const recountReason = o.canRecount ? recountDisabledReason({ canRecount: true, online: !offline }) : null;
  // Escalate to maintenance (F1-5): the badge, the draft state, the button or
  // why not. Fed the live network state: offline the button is disabled.
  const escalation = escalationSectionView({
    occurrence: o,
    maintenanceEnabled,
    canSubmit: canSubmitMaintenance,
    online: !offline,
  });

  return (
    <ScrollView
      contentContainerStyle={styles.body}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.ink} />}
    >
      {banner ? (
        <Card padding={12}>
          <Body size={13.5} accessibilityRole="alert">
            {banner}
          </Body>
        </Card>
      ) : null}

      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          {o.reference ? (
            <Mono size={12} color={c.ink4}>
              {o.reference}
            </Mono>
          ) : null}
          <Pill status={meta.severity === 'critical' ? 'crit' : 'warn'} dot={false}>
            {meta.severity === 'critical' ? 'Critical' : 'Warning'}
          </Pill>
        </View>
        <Eyebrow>{meta.label.toUpperCase()}</Eyebrow>
        {/* The title is the item name (content): no cap, per the Dynamic Type
            policy. Display's default ceiling is for chrome headings. */}
        <Display size={26} maxFontSizeMultiplier={0}>
          {d.title}
        </Display>
        <Body size={15}>{d.detail}</Body>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
          <Pill status={statePillTone(state)} dot={false}>
            {occurrenceStateLabel(state)}
          </Pill>
          {recurred ? (
            <Pill status="default" dot={false}>
              {recurred}
            </Pill>
          ) : null}
          {escalation.badge ? (
            <Pill status="default" dot={false}>
              {escalation.badge}
            </Pill>
          ) : null}
        </View>
      </View>

      <Card padding={14}>
        <Fact label="ITEM" value={o.item ? `${o.item.name}${o.item.sku ? ` (${o.item.sku})` : ''}` : 'Not visible to you'} />
        {o.location && o.locationId ? (
          <Fact
            label="LOCATION"
            value={`${o.location.name}${o.location.archived ? ' (archived)' : ''}`}
            onPress={() => onNavigate(`/location/${o.locationId}`)}
            hint="Opens the location"
          />
        ) : o.location ? (
          <Fact label="LOCATION" value={`${o.location.name}${o.location.archived ? ' (archived)' : ''}`} />
        ) : null}
        <Fact
          label="FIRST SEEN"
          value={
            o.presentWhenTrackingBegan
              ? `Already present when tracking began, ${exceptionTimeLabel(o.firstSeenAt, detail.timeZone)}`
              : exceptionTimeLabel(o.firstSeenAt, detail.timeZone)
          }
        />
        {!resolved ? <Fact label="LAST SEEN BY A CHECK" value={exceptionTimeLabel(o.lastSeenAt, detail.timeZone)} /> : null}
        {o.acknowledgedAt ? (
          <Fact
            label="ACKNOWLEDGED"
            value={`${o.acknowledgedBy?.label ?? 'Former member'}, ${exceptionTimeLabel(o.acknowledgedAt, detail.timeZone)}`}
          />
        ) : null}
        {o.resolvedAt ? (
          <Fact
            label="RESOLVED"
            value={`${exceptionTimeLabel(o.resolvedAt, detail.timeZone)}: ${OCCURRENCE_RESOLVED_REASON_COPY[o.resolvedReason ?? 'cleared']}`}
          />
        ) : null}
      </Card>

      <View style={{ gap: 8 }}>
        {exceptionActionsFor(o.rule).map((kind) => (
          <Button key={kind} variant="outline" block onPress={() => onNavigate(exceptionActionRoute(kind, o.itemId))}>
            {EXCEPTION_ACTION_LABELS[kind]}
          </Button>
        ))}
      </View>

      <View style={{ gap: 8 }}>
        {showActButtons ? (
          <View style={{ gap: 8 }}>
            {o.acknowledgedAt === null ? (
              <Button block disabled={disabledReason !== null} onPress={() => onOpenSheet('acknowledge')}>
                Acknowledge
              </Button>
            ) : null}
            <Button
              block
              variant="outline"
              disabled={disabledReason !== null}
              onPress={() => onOpenSheet('note')}
            >
              Add note
            </Button>
          </View>
        ) : null}
        {disabledReason ? (
          <Body size={13} muted>
            {disabledReason}
          </Body>
        ) : null}
      </View>

      <ExceptionEvidenceSection
        occurrenceId={o.id}
        block={detail.evidence}
        readTick={readTick}
        resolved={resolved}
        canAct={o.canAct}
        online={!offline}
        timeZone={detail.timeZone}
        onChanged={onPhotosChanged}
      />

      {showRecount ? (
        <Section title="RECOUNT">
          {o.recount ? (
            <Pressable
              accessibilityRole="link"
              onPress={() => onNavigate(`/cycle-count/${o.recount!.cycleCountId}`)}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            >
              <Body size={14.5} color={c.ink}>
                {activeRecountCopy(o.recount)}
              </Body>
            </Pressable>
          ) : (
            <Body size={14} muted>
              No recount is linked to this exception.
            </Body>
          )}
          {o.canRecount ? (
            <>
              <Body size={13.5} muted>
                {RECOUNT_COUNTS_TOTAL_COPY}
              </Body>
              <Button block variant="outline" disabled={recountReason !== null} onPress={onRecount}>
                Recount
              </Button>
              {recountReason ? (
                <Body size={13} muted>
                  {recountReason}
                </Body>
              ) : null}
            </>
          ) : (
            <Body size={13.5} muted>
              {recountUnavailableCopy(o.recountUnavailableReason)}
            </Body>
          )}
        </Section>
      ) : null}

      {escalation.show ? (
        <Section title="MAINTENANCE">
          {escalation.badge && escalation.openRequestId ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={escalation.badge}
              accessibilityHint="Opens the maintenance request"
              onPress={() => onOpenRequest(escalation.openRequestId!)}
              style={({ pressed }) => ({ minHeight: MIN_TAP, justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
            >
              <Body size={14.5} color={c.ink} style={{ textDecorationLine: 'underline' }}>
                {escalation.badge}
              </Body>
            </Pressable>
          ) : escalation.badge ? (
            <Body size={14.5} color={c.ink}>
              {escalation.badge}
            </Body>
          ) : null}
          {escalation.escalatedAt ? (
            <Mono size={11} color={c.ink4}>
              {`${escalation.escalatedBy ?? 'Former member'}, ${exceptionTimeLabel(escalation.escalatedAt, detail.timeZone)}`}
            </Mono>
          ) : null}
          {escalation.requestState ? (
            <Body size={13.5} muted>
              {escalation.requestState}
            </Body>
          ) : null}
          {escalation.offerButton ? (
            <>
              <Body size={13.5} muted>
                {ESCALATE_TO_MAINTENANCE_HELP}
              </Body>
              <Button
                block
                variant="outline"
                disabled={escalation.buttonDisabledReason !== null}
                onPress={() => onEscalate(o)}
              >
                {ESCALATE_TO_MAINTENANCE_LABEL}
              </Button>
              {escalation.buttonDisabledReason ? (
                <Body size={13} muted>
                  {escalation.buttonDisabledReason}
                </Body>
              ) : null}
            </>
          ) : null}
          {escalation.note ? (
            <Body size={13.5} muted>
              {escalation.note}
            </Body>
          ) : null}
        </Section>
      ) : null}

      {o.item ? (
        <ItemVerificationCard
          view={verification.view}
          onRetry={verification.reload}
          canOpenCounts={canOpenCounts}
          onOpenCount={(cycleCountId) => onNavigate(`/cycle-count/${cycleCountId}`)}
          onOpenMovements={() => onNavigate(`/item/${o.itemId}?tab=movements`)}
          onOpenIssue={(occurrenceId) => onNavigate(`/exceptions/${occurrenceId}`)}
          // No "Count this item" here (see the header): the web's rule.
          excludeIssueId={o.id}
        />
      ) : null}

      <Section title="WHAT CAN CAUSE THIS">
        {meta.explanations.map((e) => (
          <Body key={e} size={14}>
            {`• ${e}`}
          </Body>
        ))}
      </Section>

      <Section title="WHAT CLEARS THIS">
        <Body size={14}>{meta.clearedBy}</Body>
      </Section>

      <Section title="TIMELINE">
        {detail.timeline.length === 0 ? (
          <Body size={14} muted>
            No events yet.
          </Body>
        ) : (
          detail.timeline.map((e) =>
            e.kind === 'evidence_added' || e.kind === 'evidence_removed' ? (
              <EvidenceEvent
                key={e.id}
                lines={evidenceTimelineLines({
                  kind: e.kind,
                  actorLabel: e.actor?.label ?? null,
                  note: e.note,
                  evidence: e.evidence,
                  timeZone: detail.timeZone,
                })}
                at={exceptionTimeLabel(e.at, detail.timeZone)}
              />
            ) : (
              <View key={e.id} style={{ gap: 2 }}>
                <Body size={14} color={c.ink}>
                  {describeTimelineEvent({
                    kind: e.kind,
                    actorLabel: e.actor?.label ?? null,
                    cycleCountNumber: e.cycleCount?.countNumber ?? null,
                    resolvedReason: o.resolvedReason,
                    recountOutcome: e.cycleCount?.outcome ?? null,
                    maintenanceRequestReference: e.maintenanceRequestReference,
                  })}
                </Body>
                <Mono size={11} color={c.ink4}>
                  {exceptionTimeLabel(e.at, detail.timeZone)}
                </Mono>
                {e.note ? (
                  <Body size={14} muted>
                    {e.note}
                  </Body>
                ) : null}
              </View>
            ),
          )
        )}
      </Section>

      {detail.history.length > 1 ? (
        <Section title="THIS CONDITION OVER TIME">
          {detail.history.map((h) => (
            <Pressable
              key={h.id}
              disabled={h.isCurrent}
              accessibilityRole={h.isCurrent ? 'text' : 'link'}
              onPress={() => onNavigate(`/exceptions/${h.id}`)}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, gap: 2 })}
            >
              <Body size={14} color={c.ink}>
                {`${h.reference ?? 'Exception'}${h.isCurrent ? ' (this one)' : ''}`}
              </Body>
              <Mono size={11} color={c.ink4}>
                {h.resolvedAt
                  ? `First seen ${exceptionTimeLabel(h.firstSeenAt, detail.timeZone)}, resolved ${exceptionTimeLabel(h.resolvedAt, detail.timeZone)}: ${OCCURRENCE_RESOLVED_REASON_COPY[h.resolvedReason ?? 'cleared']}`
                  : `First seen ${exceptionTimeLabel(h.firstSeenAt, detail.timeZone)}, still open`}
              </Mono>
            </Pressable>
          ))}
          {detail.historyTruncated ? (
            <Body size={12.5} muted>
              Only the most recent occurrences are shown.
            </Body>
          ) : null}
        </Section>
      ) : null}

      <Body size={12.5} muted>
        {detail.syncState
          ? exceptionCheckedAtCopy(exceptionTimeLabel(detail.syncState.lastSyncedAt, detail.timeZone))
          : EXCEPTION_FIRST_CHECK_PENDING_COPY}
      </Body>
    </ScrollView>
  );
}

/** A photo event: "Photo added by X", its two times (each named by its
 *  clock), the event's own time, and the note or the removal's reason. */
function EvidenceEvent({
  lines,
  at,
}: {
  lines: { headline: string; detail: string | null; note: string | null };
  at: string;
}) {
  const { c } = useTheme();
  return (
    <View style={{ gap: 2 }}>
      <Body size={14} color={c.ink}>
        {lines.headline}
      </Body>
      {lines.detail ? (
        <Body size={13} muted>
          {lines.detail}
        </Body>
      ) : null}
      <Mono size={11} color={c.ink4}>
        {at}
      </Mono>
      {lines.note ? (
        <Body size={14} muted>
          {lines.note}
        </Body>
      ) : null}
    </View>
  );
}

function Fact({
  label,
  value,
  onPress,
  hint,
}: {
  label: string;
  value: string;
  /** Makes the fact a link (the location opens the location screen). */
  onPress?: () => void;
  hint?: string;
}) {
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="link"
        accessibilityHint={hint}
        style={({ pressed }) => ({ gap: 2, paddingVertical: 6, opacity: pressed ? 0.7 : 1 })}
      >
        <Eyebrow prefix="">{label}</Eyebrow>
        <Body size={14.5} style={{ textDecorationLine: 'underline' }}>
          {value}
        </Body>
      </Pressable>
    );
  }
  return (
    <View style={{ gap: 2, paddingVertical: 6 }}>
      <Eyebrow prefix="">{label}</Eyebrow>
      <Body size={14.5}>{value}</Body>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Eyebrow>{title}</Eyebrow>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // The back chip's 44pt frame (IconChip minTap) is 3pt wider than the 38pt
  // chip on every side, so the bar takes 3pt off its padding (12, 8) and what
  // sits under it 3pt off its top (the cards and the body 12 -> 9, the loading
  // spinner 32 -> 29): everything sits where it did.
  topbar: { paddingHorizontal: 9, paddingTop: 5, flexDirection: 'row', alignItems: 'center' },
  body: { paddingHorizontal: 20, paddingTop: 9, paddingBottom: 40, gap: 18 },
});
