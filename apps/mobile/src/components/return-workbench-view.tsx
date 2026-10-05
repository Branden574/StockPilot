import { useNetworkState } from 'expo-network';
import { type Href, useRouter } from 'expo-router';
import * as React from 'react';
import { AccessibilityInfo, ActivityIndicator, Image, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import {
  formatOrderNumber,
  qtyReturningLabel,
  READINESS_NEEDS_CONNECTION_COPY,
  RETURNS_COPY,
  returnReasonLabel,
  returnStatusLabel,
  type ReturnAction,
} from '@stockpilot/core';

import { ReturnActionSheet, type ReturnSheetMode } from '@/components/return-action-sheet';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { Body, Display, Eyebrow, Mono } from '@/components/ui/text';
import { isOfflineState } from '@/lib/exceptions-api';
import {
  describeReturnError,
  getReturnWorkbench,
  runReturnSteps,
  type MobileReturnWorkbench,
} from '@/lib/returns-api';
import { actionLabel, returnStatusTone, stepOutcomeMessage, workbenchActions } from '@/lib/returns-view';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * The RMA workbench body on the phone and the iPad (returns RX-1, graft G3):
 * the header (RMA, original SO, requester, warehouse, reason, the return
 * status), the RETURNING cards (photo, name, size, SKU, quantity, inbound
 * state), one next-step bar from core's availableReturnActions (fed by the
 * server-computed viewer booleans, never a role), and the chain.
 *
 * Every action needs a connection: offline each is disabled with "Needs a
 * connection." (no outbox kind exists for a return). Receive is one tap (one
 * step, one transaction); Approve, Process, Change destination, Deny and
 * Cancel open the action sheet. After any answer the screen redraws from the
 * server (the steps route returns the whole workbench).
 */
export function ReturnWorkbenchView({
  returnId,
  compact = false,
  onChanged,
}: {
  returnId: string;
  compact?: boolean;
  /** Called after an action the server answered, so the iPad split view's
   *  list (beside this view, never re-focused) reloads the RMA's status. */
  onChanged?: () => void;
}) {
  const { c } = useTheme();
  const router = useRouter();
  const offline = isOfflineState(useNetworkState());
  const [wb, setWb] = React.useState<MobileReturnWorkbench | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [sheet, setSheet] = React.useState<ReturnSheetMode | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoadError(null);
    try {
      setWb(await getReturnWorkbench(returnId));
    } catch (e) {
      setLoadError(describeReturnError(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [returnId]);

  // A new returnId (the iPad split view picks another row) starts from a
  // clean slate: reset during render, not in the effect (no cascading render).
  const [seenId, setSeenId] = React.useState(returnId);
  if (seenId !== returnId) {
    setSeenId(returnId);
    setLoading(true);
    setWb(null);
    setSheet(null);
    setNotice(null);
  }

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: every set is post-await except the pre-await error reset; the effect synchronizes with the server
    void load();
  }, [load]);

  React.useEffect(() => {
    if (notice) AccessibilityInfo.announceForAccessibility(notice);
  }, [notice]);

  if (loading && !wb) return <ActivityIndicator color={c.ink4} style={{ marginTop: 32 }} />;
  if (!wb) {
    return (
      <View style={{ paddingHorizontal: 20, marginTop: 8 }}>
        <Card padding={16}>
          <Body size={14.5}>{offline ? READINESS_NEEDS_CONNECTION_COPY : (loadError ?? "This return isn't available.")}</Body>
          <View style={{ marginTop: 14, alignSelf: 'flex-start' }}>
            <Button variant="outline" size="sm" disabled={offline} onPress={() => void load()}>
              Try again
            </Button>
          </View>
        </Card>
      </View>
    );
  }

  const r = wb.return;
  const actions = workbenchActions(wb, { itemIsHere: wb.createdOnCounter, online: !offline, busy });
  const disabled = actions.disabledReason !== null;

  async function receive() {
    if (!wb || disabled) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await runReturnSteps(wb.return.id, { steps: ['receive'], expectedRevision: wb.revision, expectedPlanSeq: wb.planSeq });
      setWb(res.workbench);
      const step = res.ran[0];
      setNotice(step ? stepOutcomeMessage(step, res.workbench, false) : null);
      onChanged?.();
    } catch (e) {
      setNotice(describeReturnError(e));
    } finally {
      setBusy(false);
    }
  }

  function onAction(a: ReturnAction) {
    switch (a) {
      case 'approve':
      case 'approve_and_receive':
        setSheet('approve');
        return;
      case 'process':
        setSheet('process');
        return;
      case 'change_destination':
        setSheet('destination');
        return;
      case 'deny':
        setSheet('deny');
        return;
      case 'cancel':
        setSheet('cancel');
        return;
      case 'receive':
        void receive();
        return;
    }
  }

  const so = formatOrderNumber(r.orderNumber) ?? r.orderRequestId.slice(0, 8).toUpperCase();

  return (
    <>
      <ScrollView
        contentContainerStyle={[styles.content, compact ? { paddingTop: 12 } : null]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load();
            }}
            tintColor={c.ink}
          />
        }
      >
        <View style={{ gap: 6 }}>
          <Eyebrow>RMA · {RETURNS_COPY.typeReturn.toUpperCase()}</Eyebrow>
          <Display size={compact ? 24 : 30} accessibilityRole="header">
            {r.returnNumber ?? 'Return'}
          </Display>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <Pill status={returnStatusTone(r.status)} dot={false}>
              {returnStatusLabel(r.status)}
            </Pill>
            <Pill dot={false}>{r.source === 'requester' ? RETURNS_COPY.requestedByRequester : RETURNS_COPY.createdByStaff}</Pill>
          </View>
          <Pressable
            onPress={() => router.push(`/order/${r.orderRequestId}` as Href)}
            accessibilityRole="link"
            accessibilityLabel={`Against order ${so}`}
            hitSlop={6}
          >
            <Body size={14} color={c.ink}>
              Against order <Body size={14} color={c.ink} style={{ textDecorationLine: 'underline' }}>{so}</Body>
            </Body>
          </Pressable>
          <Body size={13} muted>
            {[r.requesterName ?? r.requesterEmail, r.warehouseName, r.reasonCode ? returnReasonLabel(r.reasonCode) : null]
              .filter(Boolean)
              .join(' · ')}
          </Body>
        </View>

        {offline ? (
          <Card padding={12}>
            <Body size={13.5}>{RETURNS_COPY.offlineActionsWait}</Body>
          </Card>
        ) : null}
        {wb.destinationsUnavailable && wb.viewer.canManageReturns && (actions.primary || actions.secondary.length > 0) ? (
          <Card padding={12}>
            <Body size={13.5} accessibilityRole="alert">
              {RETURNS_COPY.destinationsUnavailable}
            </Body>
          </Card>
        ) : null}

        <Card padding={14}>
          <View style={{ gap: 8 }}>
            {actions.primary ? (
              <Button
                block
                disabled={disabled}
                accessibilityHint={actions.disabledReason ?? undefined}
                onPress={() => onAction(actions.primary!)}
              >
                {busy && actions.primary === 'receive' ? 'Saving…' : actionLabel(actions.primary)}
              </Button>
            ) : null}
            {actions.secondary.length > 0 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {actions.secondary.map((a) => (
                  <Button
                    key={a}
                    size="sm"
                    variant={a === 'deny' ? 'destructive' : 'outline'}
                    disabled={disabled}
                    accessibilityHint={actions.disabledReason ?? undefined}
                    onPress={() => onAction(a)}
                  >
                    {actionLabel(a)}
                  </Button>
                ))}
              </View>
            ) : null}
            {actions.disabledReason ? (
              <Body size={12.5} muted>
                {actions.disabledReason}
              </Body>
            ) : null}
            {actions.readOnlyReason ? (
              <Body size={13} muted>
                {actions.readOnlyReason}
              </Body>
            ) : null}
            {!actions.primary && actions.secondary.length === 0 && !actions.readOnlyReason ? (
              <Body size={13} muted>
                No further steps for this return.
              </Body>
            ) : null}
            {notice ? (
              <Body size={13} color={c.ink} accessibilityRole="alert">
                {notice}
              </Body>
            ) : null}
          </View>
        </Card>

        <Eyebrow>{RETURNS_COPY.returning}</Eyebrow>
        <View style={compact ? { gap: 10 } : styles.cards}>
          {wb.lines.map((l) => {
            const name = l.item.name ?? 'Deleted item';
            const sub = [l.item.variant, l.item.sku].filter(Boolean).join(' · ');
            return (
              <Card key={l.id} padding={14} style={compact ? undefined : styles.card}>
                <View
                  style={{ flexDirection: 'row', gap: 12 }}
                  accessible
                  accessibilityLabel={`${name}${sub ? `, ${sub}` : ''}, ${qtyReturningLabel(l.quantity)}, ${l.inboundState}`}
                >
                  {l.item.thumbUrl || l.item.imageUrl ? (
                    <Image
                      source={{ uri: l.item.thumbUrl ?? l.item.imageUrl ?? '' }}
                      style={[styles.photo, { backgroundColor: c.paper2 }]}
                      accessibilityIgnoresInvertColors
                    />
                  ) : (
                    <View style={[styles.photo, { backgroundColor: c.paper2 }]} />
                  )}
                  <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                    <Body size={15} color={c.ink} numberOfLines={2} style={{ fontFamily: FONT.display }}>
                      {name}
                    </Body>
                    {sub ? (
                      <Body size={12.5} muted>
                        {sub}
                      </Body>
                    ) : null}
                    <Body size={13.5}>{qtyReturningLabel(l.quantity)}</Body>
                    <View style={{ alignSelf: 'flex-start' }}>
                      <Pill status={l.applied ? 'ok' : 'default'} dot={false}>
                        {l.inboundState}
                      </Pill>
                    </View>
                  </View>
                </View>
              </Card>
            );
          })}
        </View>

        {r.denialReason && r.status === 'denied' ? (
          <Card padding={14}>
            <Eyebrow>DENIED</Eyebrow>
            <Body size={14} style={{ marginTop: 6 }}>
              {r.denialReason}
            </Body>
          </Card>
        ) : null}

        <Eyebrow>HISTORY</Eyebrow>
        <Card padding={14}>
          <View style={{ gap: 10 }}>
            {wb.chain.length === 0 ? (
              <Body size={13} muted>
                No history yet.
              </Body>
            ) : (
              wb.chain.map((e, i) => (
                <View key={`${e.at}-${i}`} accessible accessibilityLabel={`${e.label}${e.actorName ? `, ${e.actorName}` : ''}`}>
                  <Body size={13.5} color={c.ink}>
                    {e.label}
                  </Body>
                  <Mono size={11} color={c.ink4}>
                    {new Date(e.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    {e.actorName ? ` · ${e.actorName}` : ''}
                  </Mono>
                </View>
              ))
            )}
          </View>
        </Card>
      </ScrollView>

      {sheet ? (
        <ReturnActionSheet
          visible
          mode={sheet}
          workbench={wb}
          online={!offline}
          onClose={() => setSheet(null)}
          onDone={(done) => {
            setSheet(null);
            setNotice(done.message);
            if (done.workbench) setWb(done.workbench);
            else void load();
            onChanged?.();
          }}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 32, gap: 14 },
  cards: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  card: { flexGrow: 1, flexBasis: 320 },
  photo: { width: 72, height: 72, borderRadius: 10 },
});
