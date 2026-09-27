import { useNetworkState } from 'expo-network';
import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import {
  VERIFICATION_UNAVAILABLE_COPY,
  verificationIssueChipCopy,
  verificationSummaryCopy,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Body, Eyebrow } from '@/components/ui/text';
import { isOfflineState } from '@/lib/exceptions-api';
import { ACCENT, FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';
import {
  VERIFICATION_ISSUES_TRUNCATED_COPY,
  getItemVerification,
  verificationCheckedAtCopy,
  verificationFailure,
  verificationKey,
  verificationView,
  type MobileItemVerification,
  type StoredVerification,
  type VerificationView,
} from '@/lib/verification-api';

/**
 * "LAST PHYSICAL COUNT" (F1-3): the native twin of the web item card, on the
 * item screen and the exception detail. The facts come from
 * GET /api/v1/items/[id]/verification (the service the web card renders) and
 * the words from core verificationSummaryCopy, so an item reads the same on
 * both. The words never say "verified" and never show a percentage.
 *
 * OFF THE ITEM SCREEN'S CRITICAL PATH. The card has its own read and its own
 * loading line; the item screen never waits for it, and a failure here never
 * touches the rest of the screen.
 *
 * A FAILED READ says "Couldn't load verification" with why and, where it can
 * help, Try again. It is never shown as "No physical count on record." (an
 * error must not read as a fact). Offline nothing is asked: the answer already
 * on screen stays with its time, or the card says it needs a connection and
 * loads again when the phone reconnects.
 */

/**
 * The card's read. It starts as soon as the item id and workspace are known
 * (the item screen passes the active workspace until the item's own
 * organization is read, so the read runs alongside the item's instead of
 * after it), and again whenever `refreshKey` changes (pull to refresh, a
 * saved adjustment, a move, a started count) or the phone reconnects. Only the
 * newest read may land.
 */
export function useItemVerification(
  itemId: string | null | undefined,
  orgId: string | null | undefined,
  refreshKey: unknown = 0,
): { view: VerificationView<MobileItemVerification>; reload: () => Promise<void> } {
  const offline = isOfflineState(useNetworkState());
  const [stored, setStored] = React.useState<StoredVerification<MobileItemVerification> | null>(
    null,
  );
  const seqRef = React.useRef(0);
  const key = verificationKey(itemId, orgId);

  const load = React.useCallback(async () => {
    // Offline there is nothing to ask; the view below is derived instead.
    if (!itemId || !orgId || key === null || offline) return;
    const seq = ++seqRef.current;
    try {
      const data = await getItemVerification(itemId, { orgId });
      if (seq !== seqRef.current) return;
      setStored({ key, kind: 'ready', data, receivedAt: new Date().toISOString(), banner: null });
    } catch (e) {
      if (seq !== seqRef.current) return;
      setStored((prev) => verificationFailure(prev, key, e, 'item', (d) => d.timeZone));
    }
  }, [itemId, orgId, key, offline]);

  React.useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return { view: verificationView(stored, key, offline, (d) => d.timeZone), reload: load };
}

export function ItemVerificationCard({
  view,
  onRetry,
  canOpenCounts,
  onOpenCount,
  onOpenMovements,
  onOpenIssue,
  onCount,
  excludeIssueId,
}: {
  view: VerificationView<MobileItemVerification>;
  onRetry: () => Promise<void>;
  /** The reader can open a count (canOpenCountScreen, the web's rule); else
   *  the counts are named as plain text. */
  canOpenCounts: boolean;
  /** Opens a cycle count (the last count, or the open one holding the item). */
  onOpenCount: (cycleCountId: string) => void;
  /** Opens the item's Movements (the "N recorded stock movements since" line). */
  onOpenMovements?: () => void;
  onOpenIssue: (occurrenceId: string) => void;
  /** "Count this item", offered only with this handler, and only when the
   *  server says this reader may start a count of a countable item. The item
   *  screen leaves it out: its stock card already has the button. */
  onCount?: () => void;
  /** The exception this card sits on, left out of its own chips. */
  excludeIssueId?: string | null;
}) {
  const { c } = useTheme();
  const [retrying, setRetrying] = React.useState(false);

  async function retry() {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <Card padding={16}>
      <Eyebrow>LAST PHYSICAL COUNT</Eyebrow>
      <View style={{ marginTop: 10, gap: 6 }}>
        {view.kind === 'loading' ? (
          <View
            accessible
            accessibilityLabel="Loading the last physical count"
            style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
          >
            <ActivityIndicator color={c.ink4} />
            <Body size={14} muted>
              Loading...
            </Body>
          </View>
        ) : view.kind === 'error' ? (
          <View style={{ gap: 6 }}>
            <Body
              size={15}
              color={c.ink}
              accessibilityRole="alert"
              style={{ fontFamily: FONT.display }}
            >
              {VERIFICATION_UNAVAILABLE_COPY}
            </Body>
            <Body size={13.5} muted>
              {view.error.detail}
            </Body>
            {view.error.retry ? (
              <Button
                size="sm"
                variant="outline"
                disabled={retrying}
                onPress={() => void retry()}
                style={{ alignSelf: 'flex-start', marginTop: 6 }}
              >
                {retrying ? 'Trying again...' : 'Try again'}
              </Button>
            ) : null}
          </View>
        ) : (
          <Summary
            data={view.data}
            banner={view.banner}
            onOpenCount={canOpenCounts ? onOpenCount : null}
            onOpenMovements={onOpenMovements}
            onOpenIssue={onOpenIssue}
            onCount={onCount}
            excludeIssueId={excludeIssueId ?? null}
          />
        )}
      </View>
    </Card>
  );
}

function Summary({
  data,
  banner,
  onOpenCount,
  onOpenMovements,
  onOpenIssue,
  onCount,
  excludeIssueId,
}: {
  data: MobileItemVerification;
  banner: string | null;
  /** Null: counts are named, not linked. */
  onOpenCount: ((cycleCountId: string) => void) | null;
  onOpenMovements?: () => void;
  onOpenIssue: (occurrenceId: string) => void;
  onCount?: () => void;
  excludeIssueId: string | null;
}) {
  const { c } = useTheme();
  const copy = verificationSummaryCopy(data.summary, {
    timeZone: data.timeZone,
    canCount: data.canCount,
  });
  const issues = data.openIssues.filter((i) => i.id !== excludeIssueId);
  const countId = copy.countId;
  const beingCounted = copy.beingCounted;
  // The Movements link only for a real number (an unknown number is said as
  // unknown, and there is nothing to list).
  const movementsLink =
    onOpenMovements && data.summary.movementsSince !== null ? onOpenMovements : null;

  return (
    <>
      {banner ? (
        <Body size={13} color={ACCENT.warn} accessibilityRole="alert">
          {banner}
        </Body>
      ) : null}

      {countId && onOpenCount ? (
        <LinkLine
          text={copy.headline}
          hint="Opens the count"
          onPress={() => onOpenCount(countId)}
          strong
        />
      ) : (
        <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
          {copy.headline}
        </Body>
      )}

      {[copy.result, copy.scope, copy.who, copy.capture, copy.aiAssisted].map((line, i) =>
        line ? (
          <Body key={i} size={14}>
            {line}
          </Body>
        ) : null,
      )}

      {copy.movementsSince ? (
        movementsLink ? (
          <LinkLine
            text={copy.movementsSince}
            hint="Shows the item's movements"
            onPress={movementsLink}
          />
        ) : (
          <Body size={14}>{copy.movementsSince}</Body>
        )
      ) : null}
      {copy.outsideLedger ? <Body size={14}>{copy.outsideLedger}</Body> : null}
      {copy.bookNow ? <Body size={14}>{copy.bookNow}</Body> : null}

      {beingCounted && onOpenCount ? (
        <LinkLine
          text={beingCounted.text}
          hint="Opens the count"
          onPress={() => onOpenCount(beingCounted.cycleCountId)}
        />
      ) : beingCounted ? (
        <Body size={14}>{beingCounted.text}</Body>
      ) : null}
      {copy.notCountable ? (
        <Body size={13.5} muted>
          {copy.notCountable}
        </Body>
      ) : null}
      {copy.countAction && onCount ? (
        <Button
          size="sm"
          variant="outline"
          onPress={onCount}
          style={{ alignSelf: 'flex-start', marginTop: 6 }}
        >
          {copy.countAction}
        </Button>
      ) : null}

      {issues.length > 0 ? (
        <View style={{ marginTop: 8, gap: 8 }}>
          <Eyebrow>OPEN EXCEPTIONS</Eyebrow>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {issues.map((issue) => (
              <IssueChip
                key={issue.id}
                text={verificationIssueChipCopy(issue)}
                onPress={() => onOpenIssue(issue.id)}
              />
            ))}
          </View>
          {data.openIssuesTruncated ? (
            <Body size={12.5} muted>
              {VERIFICATION_ISSUES_TRUNCATED_COPY}
            </Body>
          ) : null}
          <Body size={12.5} muted>
            {verificationCheckedAtCopy(data.checkedAt, data.timeZone)}
          </Body>
        </View>
      ) : null}
    </>
  );
}

/** A line of the card that opens something. Content text: no Dynamic Type cap. */
function LinkLine({
  text,
  hint,
  onPress,
  strong = false,
}: {
  text: string;
  hint: string;
  onPress: () => void;
  strong?: boolean;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      accessibilityHint={hint}
      hitSlop={6}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, alignSelf: 'flex-start' })}
    >
      <Body
        size={strong ? 15 : 14}
        color={c.ink}
        style={{
          textDecorationLine: 'underline',
          ...(strong ? { fontFamily: FONT.display } : null),
        }}
      >
        {text}
      </Body>
    </Pressable>
  );
}

/** "EX-000042 · Count did not match the book": opens the exception. */
export function IssueChip({ text, onPress }: { text: string; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      accessibilityHint="Opens the exception"
      style={({ pressed }) => ({
        minHeight: 36,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: 'rgba(185,122,29,0.3)',
        backgroundColor: 'rgba(245,176,66,0.10)',
        justifyContent: 'center',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Body size={13} color={c.ink}>
        {text}
      </Body>
    </Pressable>
  );
}
