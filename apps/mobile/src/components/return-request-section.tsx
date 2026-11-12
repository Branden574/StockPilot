import { Mail } from 'lucide-react-native';
import * as React from 'react';
import { Alert, Platform, StyleSheet, TextInput, View } from 'react-native';

import type { DeliveryRequestRecipients, ReturnRequestEmailContent } from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Body } from '@/components/ui/text';
import { nativeOutlookAvailable, type OutlookPlatform } from '@/lib/outlook-transport';
import {
  RETURN_REQUEST_COPY,
  openReturnRequestDraft,
  prepareMobileReturnRequest,
  recordReturnRequestDrafted,
  returnRequestBlockedHeadline,
  returnRequestRecipientsText,
  returnRequestSuccessMessage,
  shouldConfirmBeforeOpening,
  shouldShowReturnRequestBlocked,
  shouldShowReturnRequestCondensed,
  shouldWarnReturnRequestDuplicate,
  type ReturnRequestOpenResult,
} from '@/lib/return-request-actions';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * RETURN REQUEST (F14): a prefilled email draft about one return, to the
 * organization's saved delivery-request mailboxes. On the order screen under
 * each of the requester's own open requests, and on the return screen for a
 * member who can open it. The shape of the order screen's DELIVERY REQUEST
 * section (app/order/[id].tsx), with every decision and word in
 * src/lib/return-request-actions.ts, where the tests reach them.
 *
 * It opens a draft and nothing else: StockPilot does not send the mail and
 * does not create a ticket, and the section says so before any press. The
 * caller renders it only with resolved recipients and content (the lib's
 * gates), so it has no hidden state of its own to decide who may see it; the
 * server's record checks the member again.
 *
 * Classic and Liquid Glass: the shared Button, Card and text primitives draw
 * themselves for either design, so this file branches on neither. The
 * heading is the screen's own (`heading`): each screen passes the heading
 * its other sections use, so the section sits in the screen like a sibling.
 */
export function ReturnRequestSection({
  orderId,
  surface,
  content,
  recipients,
  heading,
}: {
  /** The order the return is on (the record is keyed to it; a hint only). */
  orderId: string;
  surface: 'order' | 'return';
  content: ReturnRequestEmailContent;
  recipients: DeliveryRequestRecipients;
  /** The screen's own section heading (an eyebrow, or its glass heading). */
  heading: React.ReactNode;
}) {
  const { c } = useTheme();

  // ONE probe, whose answer feeds the prepare call and nothing else: the
  // opener follows the transport stamped on the prepared draft, so what is
  // measured and what is opened cannot differ. Null until it answers: the
  // draft is then fitted to the web link, the longest.
  const [nativeOutlook, setNativeOutlook] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void nativeOutlookAvailable().then((available) => {
      if (!cancelled) setNativeOutlook(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const prepared = React.useMemo(
    () => prepareMobileReturnRequest(content, recipients, nativeOutlook),
    [content, recipients, nativeOutlook],
  );
  const [draftCount, setDraftCount] = React.useState(0);
  const [result, setResult] = React.useState<ReturnRequestOpenResult | null>(null);
  const [copyOpen, setCopyOpen] = React.useState(false);
  const [opening, setOpening] = React.useState(false);

  async function runOpen() {
    setOpening(true);
    // Platform.OS is read here and nowhere in src/lib (the transport takes
    // the platform as data).
    const platform: OutlookPlatform = Platform.OS === 'android' ? 'android' : 'ios';
    const res = await openReturnRequestDraft(prepared, platform, () => {
      // Only after the operating system opened an app: counted, and recorded
      // on the server (which checks the member and the return itself).
      setDraftCount((n) => n + 1);
      void recordReturnRequestDrafted({
        orderId,
        returnNumber: content.returnNumber,
        isCondensed: prepared.draft.condensed,
        surface,
      });
    });
    setOpening(false);
    setResult(res);
    // A blocked open shows the copy box: the one transport that always works.
    if (res.outcome === 'blocked') setCopyOpen(true);
  }

  function handlePress() {
    // Too long for any link: nothing is opened (a mail app would cut it
    // short without saying so); straight to the copy box.
    if (!prepared.linkFits) {
      setCopyOpen(true);
      return;
    }
    if (shouldConfirmBeforeOpening(draftCount)) {
      Alert.alert(RETURN_REQUEST_COPY.duplicateTitle, RETURN_REQUEST_COPY.duplicate, [
        { text: 'Cancel', style: 'cancel' },
        { text: RETURN_REQUEST_COPY.duplicateConfirm, onPress: () => void runOpen() },
      ]);
      return;
    }
    void runOpen();
  }

  return (
    <View style={{ gap: 8 }}>
      {heading}
      <Card padding={14}>
        <View style={{ gap: 8 }}>
          {/* The outline, as the order's Email delivery request: it opens a
              draft and commits nothing. */}
          <Button
            block
            wrap
            variant="outline"
            onPress={handlePress}
            disabled={opening}
            leading={<Mail size={16} color={c.ink} strokeWidth={1.5} />}
            accessibilityLabel={`${RETURN_REQUEST_COPY.primary}, ${content.returnNumber}`}
          >
            {RETURN_REQUEST_COPY.primary}
          </Button>
          {/* From the same recipients the draft was composed with, so this
              sentence cannot name a mailbox the mail does not go to. */}
          <Body size={12} color={c.ink3}>
            {returnRequestRecipientsText(recipients)}
          </Body>
          <Body size={12} color={c.ink3}>
            {RETURN_REQUEST_COPY.honesty}
          </Body>

          {shouldShowReturnRequestCondensed(prepared) ? (
            <Body size={12} color={c.ink3}>
              {RETURN_REQUEST_COPY.condensed}
            </Body>
          ) : null}
          {!prepared.linkFits ? (
            <Body size={12} color={c.ink3}>
              {RETURN_REQUEST_COPY.oversized}
            </Body>
          ) : null}
          {shouldWarnReturnRequestDuplicate(draftCount) ? (
            <Body size={12} color={c.ink3}>
              {RETURN_REQUEST_COPY.duplicate}
            </Body>
          ) : null}
          {result?.outcome === 'opened' ? (
            <Body size={12} color={c.ink3} accessibilityRole="alert">
              {returnRequestSuccessMessage(result.used)}
            </Body>
          ) : null}
          {shouldShowReturnRequestBlocked(prepared, result) && result?.outcome === 'blocked' ? (
            <>
              <Body size={12} color={c.ink3} accessibilityRole="alert">
                {returnRequestBlockedHeadline(result.attempted)}
              </Body>
              <Body size={12} color={c.ink3}>
                {RETURN_REQUEST_COPY.blockedRetry}
              </Body>
            </>
          ) : null}

          {copyOpen ? (
            <>
              {/* Always the whole message with both mailboxes. There is no
                  clipboard module in this app, so this read-only box is the
                  copy: one tap selects all of it (the delivery request's and
                  the maintenance request's box). */}
              <TextInput
                multiline
                editable={false}
                selectTextOnFocus
                value={prepared.clipboardText}
                style={[styles.copyBox, { color: c.ink, borderColor: c.hair }]}
                accessibilityLabel={RETURN_REQUEST_COPY.manualLabel}
              />
              <Body size={11.5} muted style={{ marginTop: 6 }}>
                {RETURN_REQUEST_COPY.copyHelper}
              </Body>
            </>
          ) : (
            <Button block wrap variant="outline" onPress={() => setCopyOpen(true)}>
              {RETURN_REQUEST_COPY.copy}
            </Button>
          )}
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  // The delivery request's and the maintenance request's copy box, value for
  // value (app/order/[id].tsx and app/maintenance/[id].tsx `copyBox`).
  copyBox: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 12.5,
    fontFamily: FONT.mono,
    minHeight: 140,
    textAlignVertical: 'top',
  },
});
