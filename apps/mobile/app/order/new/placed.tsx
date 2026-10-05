import { type Href, useRouter } from 'expo-router';
import { X } from 'lucide-react-native';
import * as React from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  SUCCESS_DONE_COPY,
  SUCCESS_EMAIL_COPY_DETAILS_COPY,
  SUCCESS_EMAIL_HIDE_PREVIEW_COPY,
  SUCCESS_EMAIL_OPENED_COPY,
  SUCCESS_EMAIL_PREVIEW_COPY,
  SUCCESS_EMAIL_SUBJECT_LABEL_COPY,
  SUCCESS_PLACE_ANOTHER_COPY,
  SUCCESS_REVIEW_AND_APPROVE_COPY,
  SUCCESS_TITLE_COPY,
  SUCCESS_VIEW_ORDER_COPY,
  condensedNoticeText,
  prepareDeliveryRequest,
  successEmailButtonCopy,
} from '@stockpilot/core';

import { SmallAction } from '@/components/order-storefront/controls';
import { IconChip } from '@/components/ui/row';
import { Body, Display, Eyebrow, Mono } from '@/components/ui/text';
import {
  BLOCKED_HEADLINE,
  BLOCKED_RETRY_MESSAGE,
  COPY_HELPER_TEXT,
  DUPLICATE_WARNING,
  HONESTY_NOTICE,
  OVERSIZED_MESSAGE,
  deliveryComposeTransport,
  deliverySuccessMessageFor,
  openDeliveryRequestDraft,
  recipientsHelperText,
  shouldConfirmBeforeOpening,
  shouldShowBlockedNotice,
  shouldShowCondensedNotice,
  shouldWarnDuplicateDrafts,
  type DeliveryOpenResult,
} from '@/lib/delivery-request-actions';
import { SCREEN_ANNOUNCE_DELAY_MS, submittedAnnouncement } from '@/lib/order-storefront/a11y';
import { storefrontLayout } from '@/lib/order-storefront/layout';
import { storefrontSession, useStorefront, useStorefrontScope } from '@/lib/order-storefront/runtime';
import {
  orderStatusLabel,
  successContextFor,
  successContextFrom,
  successEmailInput,
  successOrderHref,
  successReference,
  successSentences,
} from '@/lib/order-storefront/success';
import { nativeOutlookAvailable, type OutlookPlatform } from '@/lib/outlook-transport';
import { useTheme } from '@/lib/use-theme';

/**
 * ORDER REQUEST SUBMITTED (phone ordering PO-4): reached with router.replace
 * from checkout, so Back never returns to a spent checkout; Close and Done
 * leave to the Orders list. It says the SO number, core's reference line, the
 * status and who hears about it (the replay and "already placed" sentences
 * when they apply); "Review and approve" for someone who holds the effective
 * orders:approve (the order screen at its actions), else "View order"; "Place
 * another order"; "Done".
 *
 * The pickup or delivery request email, when the organization's routing
 * resolves, is offered to every placer (the web success overlay's rule),
 * built from the submission (lib/order-storefront/success.ts), never gated by
 * the order screen's requester-only canRequestDelivery. Preview shows the
 * draft here; the button opens a DRAFT through the existing transport
 * (delivery-request-actions.ts, outlook-transport.ts): one tap, one open,
 * never on its own, and never "sent".
 */
export default function OrderPlaced() {
  useStorefrontScope();
  const snap = useStorefront();
  const session = storefrontSession();
  const router = useRouter();
  const { c } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const layout = storefrontLayout({ width, fontScale });

  const placed = snap?.placed ?? null;
  // Shown: a storefront that comes into focus later clears it instead of
  // opening this screen again for it (desk check F10).
  const placedId = placed?.order.id ?? null;
  React.useEffect(() => {
    if (placedId) session.placedShown();
  }, [placedId, session]);
  // The order number, said by this screen once it is shown (PO-4 review):
  // said in the same moment as the screen change it is cut off, and the
  // catalog's way here (a status read, Don't send it) said nothing at all.
  React.useEffect(() => {
    if (!placedId) return;
    const order = session.getSnapshot().placed?.order;
    if (!order) return;
    const timer = setTimeout(() => {
      AccessibilityInfo.announceForAccessibilityWithOptions(submittedAnnouncement(order), { queue: true });
    }, SCREEN_ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [placedId, session]);
  // What this screen shows beside the order was taken when it was placed
  // (PO-4 review): a read of the answer on return from the mail app that
  // comes back turned off or refused changes nothing here. Only an order
  // placed with no answer to take it from uses the answer shown now.
  const ready = snap?.setup.status === 'ready' ? snap.setup.answer : null;
  const sites = snap?.catalog.answer?.sites;
  const itemMap = snap?.itemMap;
  const live = React.useMemo(
    () =>
      placed && ready && itemMap
        ? successContextFrom({
            answer: ready,
            warehouseId: placed.order.warehouseId,
            sites: sites?.status === 'ok' ? sites.sites : [],
            itemMap,
            lines: placed.body?.lines ?? [],
          })
        : null,
    [placed, ready, itemMap, sites],
  );
  const context = React.useMemo(() => (placed ? successContextFor(placed, live) : null), [placed, live]);
  const warehouseName = context?.warehouseName ?? '';

  const emailInput = React.useMemo(
    () => (placed && context ? successEmailInput({ placed, context }) : null),
    [placed, context],
  );

  // Is the native Outlook app installed? Probed once, only when the email is
  // offered, and fed to the draft's preparation only (the opener reads the
  // transport the draft was measured for).
  const [nativeOutlook, setNativeOutlook] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    if (!emailInput) return;
    let alive = true;
    void nativeOutlookAvailable().then((available) => {
      if (alive) setNativeOutlook(available);
    });
    return () => {
      alive = false;
    };
  }, [emailInput]);
  const prepared = React.useMemo(
    () => (emailInput ? prepareDeliveryRequest(emailInput, { transport: deliveryComposeTransport(nativeOutlook) }) : null),
    [emailInput, nativeOutlook],
  );
  const [opening, setOpening] = React.useState(false);
  const [draftCount, setDraftCount] = React.useState(0);
  const [openResult, setOpenResult] = React.useState<DeliveryOpenResult | null>(null);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [copyOpen, setCopyOpen] = React.useState(false);

  async function runEmailOpen() {
    if (!prepared) return;
    setOpening(true);
    const platform: OutlookPlatform = Platform.OS === 'android' ? 'android' : 'ios';
    const result = await openDeliveryRequestDraft('outlook', prepared, platform, () => setDraftCount((n) => n + 1));
    setOpening(false);
    setOpenResult(result);
    if (result.outcome === 'blocked') setCopyOpen(true);
  }

  function handleEmailPress() {
    if (prepared && !prepared.linkFits) {
      setCopyOpen(true);
      return;
    }
    if (shouldConfirmBeforeOpening(draftCount)) {
      Alert.alert('Open another draft?', DUPLICATE_WARNING, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Another Draft', onPress: () => void runEmailOpen() },
      ]);
      return;
    }
    void runEmailOpen();
  }

  const leaveToOrders = () => {
    session.finishPlaced();
    if (router.canDismiss()) router.dismissAll();
    router.navigate('/orders' as Href);
  };

  if (!placed) {
    return (
      <View style={{ flex: 1, backgroundColor: c.paper }}>
        <SafeAreaView edges={['top']}>
          <View style={styles.topbar}>
            <IconChip icon={X} onPress={leaveToOrders} accessibilityLabel="Close" minTap />
          </View>
        </SafeAreaView>
        <ActivityIndicator color={c.ink} style={{ marginTop: 32 }} />
      </View>
    );
  }

  const order = placed.order;
  const canApprove = context?.canApproveOrders ?? false;

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={X} onPress={leaveToOrders} accessibilityLabel="Close" minTap />
        </View>
      </SafeAreaView>
      <ScrollView contentContainerStyle={{ paddingVertical: 8, paddingBottom: 48, alignItems: 'center' }}>
        <View style={{ width: layout.readingWidth, gap: 14 }}>
          <Display size={28} accessibilityRole="header">
            {SUCCESS_TITLE_COPY}
          </Display>
          <Mono size={13} color={c.ink}>
            {successReference(placed, warehouseName)}
          </Mono>
          <Mono size={11.5} color={c.ink4} upper tracking={0.12}>
            {orderStatusLabel(order.status)}
          </Mono>
          {successSentences(placed).map((line) => (
            <Body key={line} size={14.5} color={c.ink}>
              {line}
            </Body>
          ))}

          <View style={{ gap: 8 }}>
            <SmallAction
              label={canApprove ? SUCCESS_REVIEW_AND_APPROVE_COPY : SUCCESS_VIEW_ORDER_COPY}
              variant="primary"
              onPress={() => router.push(successOrderHref(order.id, canApprove) as Href)}
            />
            <SmallAction
              label={SUCCESS_PLACE_ANOTHER_COPY}
              onPress={() => {
                session.finishPlaced();
                // Back to the storefront already under this screen (or a new
                // one after a cold start), never a second copy of it.
                router.dismissTo('/order/new' as Href);
              }}
            />
            <SmallAction label={SUCCESS_DONE_COPY} variant="ghost" onPress={leaveToOrders} />
          </View>

          {prepared && emailInput ? (
            <View style={{ gap: 8, marginTop: 8 }}>
              <Eyebrow>{successEmailButtonCopy(order.fulfillmentType)}</Eyebrow>
              <SmallAction
                label={successEmailButtonCopy(order.fulfillmentType)}
                busy={opening}
                disabled={opening}
                onPress={handleEmailPress}
              />
              <SmallAction
                label={previewOpen ? SUCCESS_EMAIL_HIDE_PREVIEW_COPY : SUCCESS_EMAIL_PREVIEW_COPY}
                variant="ghost"
                onPress={() => setPreviewOpen((v) => !v)}
              />
              <Mono size={10.5} color={c.ink4}>
                {recipientsHelperText(prepared.draft)}
              </Mono>
              <Mono size={10.5} color={c.ink4}>
                {HONESTY_NOTICE}
              </Mono>
              {shouldShowCondensedNotice(prepared) ? (
                <Mono size={10.5} color={c.ink4}>
                  {condensedNoticeText(prepared.draft)}
                </Mono>
              ) : null}
              {!prepared.linkFits ? (
                <Mono size={10.5} color={c.ink4}>
                  {OVERSIZED_MESSAGE}
                </Mono>
              ) : null}
              {shouldWarnDuplicateDrafts(draftCount) ? (
                <Mono size={10.5} color={c.ink4}>
                  {DUPLICATE_WARNING}
                </Mono>
              ) : null}
              {openResult?.outcome === 'opened' ? (
                <Body size={13} color={c.ink} accessibilityRole="alert">
                  {`${SUCCESS_EMAIL_OPENED_COPY}. ${deliverySuccessMessageFor(openResult.used)}`}
                </Body>
              ) : null}
              {shouldShowBlockedNotice(prepared, openResult) ? (
                <Body size={13} color={c.ink} accessibilityRole="alert">
                  {`${BLOCKED_HEADLINE} ${BLOCKED_RETRY_MESSAGE}`}
                </Body>
              ) : null}
              {previewOpen ? (
                <View style={[styles.preview, { borderColor: c.hair, backgroundColor: c.card }]}>
                  <Mono size={11} color={c.ink4} upper tracking={0.12}>
                    {SUCCESS_EMAIL_SUBJECT_LABEL_COPY}
                  </Mono>
                  <Body size={14} color={c.ink}>
                    {prepared.draft.subject}
                  </Body>
                  <Body size={13} color={c.ink}>
                    {prepared.draft.body}
                  </Body>
                </View>
              ) : null}
              {copyOpen ? (
                <>
                  <TextInput
                    multiline
                    editable={false}
                    selectTextOnFocus
                    value={prepared.clipboardText}
                    style={[styles.copyBox, { color: c.ink, borderColor: c.hair }]}
                    accessibilityLabel="Request text to copy manually"
                  />
                  <Body size={11.5} muted>
                    {COPY_HELPER_TEXT}
                  </Body>
                </>
              ) : (
                <SmallAction label={SUCCESS_EMAIL_COPY_DETAILS_COPY} variant="ghost" onPress={() => setCopyOpen(true)} />
              )}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  topbar: { paddingHorizontal: 9, paddingTop: 5, flexDirection: 'row', alignItems: 'center' },
  preview: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 6 },
  copyBox: { minHeight: 140, borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 13 },
});
