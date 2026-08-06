import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Copy, Mail, MailOpen, Images, Wrench } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  MAINTENANCE_CC_NOTICE,
  MAINTENANCE_STATUS_LABELS,
  formatMaintenanceRequestNumber,
  prepareMaintenanceEmail,
  type MaintenanceEmailInput,
  type MaintenanceStatus,
} from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { Card, Hair } from '@/components/ui/card';
import { IconChip } from '@/components/ui/row';
import { Pill } from '@/components/ui/pill';
import { Body, Display, Eyebrow, Mono } from '@/components/ui/text';
import { useEnabledModules } from '@/lib/enabled-modules';
import {
  BLOCKED_HEADLINE,
  CONDENSED_NOTICE,
  COPY_HELPER_TEXT,
  DUPLICATE_WARNING,
  OVERSIZED_MESSAGE,
  SUCCESS_MESSAGE,
  openMaintenanceDraft,
  shouldConfirmBeforeOpening,
  shouldShowCondensedNotice,
  type EmailTransport,
} from '@/lib/maintenance-email-actions';
import {
  getMaintenanceRequest,
  recordDraftOpened,
  type MobileMaintenancePhoto,
  type MobileMaintenanceRequestDetail,
} from '@/lib/maintenance-api';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

/**
 * Maintenance request detail — mobile twin of the web
 * `/dashboard/maintenance/[id]` page, scoped to Task 20's brief (status,
 * subject/description, photos, To/CC + `MAINTENANCE_CC_NOTICE`, and the
 * email-action block). Local owner assignment, internal notes, and the full
 * StockPilot-activity timeline are web-only for now — out of this task's
 * file list, not silently dropped (see task-20-report.md).
 *
 * Every DECISION this screen makes — which transport opens, whether the
 * duplicate-draft confirm fires, whether the condensed notice shows,
 * whether a failed open gets recorded — is delegated to
 * `@/lib/maintenance-email-actions`, tested there behaviorally. This file
 * is orchestration + rendering only, same "source-pin honesty" posture
 * Task 18/19 established (this repo's vitest cannot render `app/`).
 */
const STATUS_PILL: Record<MaintenanceStatus, 'default' | 'warn' | 'ok' | 'crit'> = {
  saved: 'default',
  draft_opened: 'warn',
  archived: 'default',
  cancelled: 'default',
};

/** Detail-page analog of the list screen's brief-section-22 note (web's own
 *  detail page shows this exact sentence under "StockPilot activity" —
 *  page.tsx). Never implies a fake ticket-conversation timeline (brief
 *  section 23). */
const SECTION_23_NOTE =
  'Local StockPilot actions only. Ticket replies happen in the Outlook/Zendesk email conversation and are not shown here.';

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  const { c } = useTheme();
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return null;
  return (
    <View style={styles.detailRow}>
      <Mono size={11} tracking={0.04} upper color={c.ink4}>
        {label}
      </Mono>
      <Body size={13} color={c.ink} style={{ flexShrink: 1, textAlign: 'right' }}>
        {v}
      </Body>
    </View>
  );
}

export default function MaintenanceRequestDetailScreen() {
  const { c } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const enabledModules = useEnabledModules();
  const enabled = enabledModules.has('maintenance_requests');

  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<MobileMaintenanceRequestDetail | null>(null);
  const [photos, setPhotos] = React.useState<MobileMaintenancePhoto[]>([]);
  const [emailInput, setEmailInput] = React.useState<MaintenanceEmailInput | null>(null);
  const [openCount, setOpenCount] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [lastResult, setLastResult] = React.useState<{
    transport: EmailTransport;
    outcome: 'opened' | 'blocked';
  } | null>(null);
  const [copyOpen, setCopyOpen] = React.useState(false);

  React.useEffect(() => {
    if (!enabled || !id) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const res = await getMaintenanceRequest(id);
        if (cancelled) return;
        setDetail(res.request);
        setPhotos(res.photos);
        setEmailInput(res.emailInput);
        setOpenCount(res.request.outlookDraftOpenCount);
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "Couldn't load this request. Try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, id]);

  // Pure, deterministic (no clock, no DOM) — recomputed only when the
  // server payload changes, matching web's identical useMemo.
  const prepared = React.useMemo(
    () => (emailInput ? prepareMaintenanceEmail(emailInput) : null),
    [emailInput],
  );

  async function runOpen(transport: EmailTransport) {
    if (!prepared || !id) return;
    setBusy(true);
    const outcome = await openMaintenanceDraft(transport, prepared, () => {
      // Optimistic local bump so a rapid second tap is gated even before the
      // network round trip below settles; recordDraftOpened's own count
      // (server truth) then reconciles it. Best-effort only — mirrors web's
      // identical `.catch()` precedent (maintenance-email-action.tsx): a
      // lost bookkeeping call means the SERVER's count can undercount, never
      // that the employee's own draft silently vanished.
      setOpenCount((n) => n + 1);
      void recordDraftOpened(id)
        .then((r) => setOpenCount(r.openCount))
        .catch(() => {});
    });
    setBusy(false);
    setLastResult({ transport, outcome });
  }

  function handleOpenPress(transport: EmailTransport) {
    if (shouldConfirmBeforeOpening(openCount)) {
      Alert.alert('Open another draft?', DUPLICATE_WARNING, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Another Draft', onPress: () => void runOpen(transport) },
      ]);
      return;
    }
    void runOpen(transport);
  }

  function openPhotosPage() {
    const url = emailInput?.shareUrl;
    if (!url) return;
    Linking.openURL(url).catch(() => {
      // Nothing further to do — this opens a plain public page, not an
      // email compose; no recovery panel is owed for it (unlike the two
      // email transports above).
    });
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/maintenance' as Href);
  };

  if (!enabled) {
    return (
      <GateScreen c={c} onBack={goBack}>
        Maintenance requests aren’t enabled for this workspace. Ask an admin to enable it in
        Settings → Modules.
      </GateScreen>
    );
  }

  if (loading) {
    return (
      <View style={[styles.root, { backgroundColor: c.paper }]}>
        <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
          <View style={styles.topbar}>
            <IconChip icon={ArrowLeft} onPress={goBack} />
          </View>
        </SafeAreaView>
        <ActivityIndicator color={c.ink4} style={{ marginTop: 40 }} />
      </View>
    );
  }

  if (loadError || !detail || !prepared) {
    return (
      <GateScreen c={c} onBack={goBack}>
        {loadError ?? "Couldn't load this request."}
      </GateScreen>
    );
  }

  const handle = formatMaintenanceRequestNumber(detail.requestNumber, detail.createdAt) ?? `#${detail.requestNumber}`;
  const pillStatus = STATUS_PILL[detail.status] ?? 'default';
  const showCondensedNotice = shouldShowCondensedNotice(prepared);

  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ArrowLeft} onPress={goBack} />
        </View>
        <View style={styles.head}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Wrench size={16} color={c.ink3} strokeWidth={1.5} />
            <Eyebrow>{handle}</Eyebrow>
          </View>
          <Display size={26} style={{ marginTop: 8 }}>
            {detail.subject}
          </Display>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <Pill status={pillStatus} dot={false}>
              {MAINTENANCE_STATUS_LABELS[detail.status]}
            </Pill>
            <Pill status="default" dot={false}>
              {detail.priority}
            </Pill>
          </View>
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Card padding={16}>
          <Eyebrow>DESCRIPTION</Eyebrow>
          <Body size={14} color={c.ink} style={{ marginTop: 8 }}>
            {detail.description}
          </Body>
        </Card>

        <Card padding={0} style={{ marginTop: 14 }}>
          <DetailRow label="REQUESTER" value={detail.requesterName} />
          <Hair inset={16} />
          <DetailRow label="SITE" value={detail.siteName} />
          <Hair inset={16} />
          <DetailRow label="BUILDING" value={detail.building} />
          <Hair inset={16} />
          <DetailRow label="ROOM OR AREA" value={detail.roomOrArea} />
          <Hair inset={16} />
          <DetailRow label="DEPARTMENT" value={detail.department} />
          <Hair inset={16} />
          <DetailRow label="CATEGORY" value={detail.category} />
          <Hair inset={16} />
          <DetailRow label="ACCESS INSTRUCTIONS" value={detail.accessInstructions} />
        </Card>

        {photos.length > 0 ? (
          <Card padding={16} style={{ marginTop: 14 }}>
            <Eyebrow>{`PHOTOS · ${photos.length}`}</Eyebrow>
            <View style={styles.photoGrid}>
              {photos.map((p) => (
                // Plain expo-image, no cacheKey/signing helper: these URLs
                // arrive already-signed from the server every load (Task 8's
                // MaintenanceAttachmentsService.signedViewUrls), and
                // image-cache.ts's signItemImage/CachedImage are hardcoded to
                // the UNRELATED item-images bucket — routing through them
                // would sign against the wrong bucket entirely.
                <Image
                  key={p.id}
                  source={{ uri: p.thumbUrl ?? p.url }}
                  style={styles.photoThumb}
                  contentFit="cover"
                />
              ))}
            </View>
          </Card>
        ) : null}

        <Card padding={16} style={{ marginTop: 14 }}>
          <Eyebrow>EMAIL</Eyebrow>
          <View style={{ marginTop: 10, gap: 4 }}>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Mono size={11} tracking={0.04} upper color={c.ink4}>
                To
              </Mono>
              <Body size={13} color={c.ink}>
                {prepared.draft.to}
              </Body>
            </View>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Mono size={11} tracking={0.04} upper color={c.ink4}>
                CC
              </Mono>
              <Body size={13} color={c.ink}>
                {prepared.draft.cc}
              </Body>
            </View>
          </View>
          <Body size={12.5} muted style={{ marginTop: 8 }}>
            {MAINTENANCE_CC_NOTICE}
          </Body>

          {showCondensedNotice ? (
            <Card padding={10} style={{ marginTop: 12 }}>
              <Body size={12.5} muted>
                {CONDENSED_NOTICE}
              </Body>
            </Card>
          ) : null}

          {!prepared.linkFits ? (
            <Card padding={10} style={{ marginTop: 12 }}>
              <Body size={12.5} muted>
                {OVERSIZED_MESSAGE}
              </Body>
            </Card>
          ) : null}

          <View style={{ marginTop: 14, gap: 10 }}>
            {prepared.linkFits ? (
              <Button
                block
                onPress={() => handleOpenPress('outlook')}
                disabled={busy}
                leading={<Mail size={16} color={c.paper} strokeWidth={1.5} />}
              >
                Open in Outlook
              </Button>
            ) : null}
            {prepared.linkFits ? (
              <Button
                block
                variant="outline"
                onPress={() => handleOpenPress('mailto')}
                disabled={busy}
                leading={<MailOpen size={16} color={c.ink} strokeWidth={1.5} />}
              >
                Open in Default Email App
              </Button>
            ) : null}
            <Button
              block
              variant="outline"
              onPress={() => setCopyOpen((v) => !v)}
              leading={<Copy size={16} color={c.ink} strokeWidth={1.5} />}
            >
              Copy Email Details
            </Button>
            {emailInput?.shareUrl ? (
              <Button
                block
                variant="outline"
                onPress={openPhotosPage}
                leading={<Images size={16} color={c.ink} strokeWidth={1.5} />}
              >
                View photos page
              </Button>
            ) : null}
          </View>

          {lastResult?.outcome === 'opened' ? (
            <Card padding={10} style={{ marginTop: 12 }}>
              <Body size={12.5} color={c.ink}>
                {SUCCESS_MESSAGE}
              </Body>
            </Card>
          ) : null}
          {lastResult?.outcome === 'blocked' ? (
            <Card padding={10} style={{ marginTop: 12 }}>
              <Body size={12.5} color={c.ink}>
                {BLOCKED_HEADLINE}
              </Body>
              <Body size={12.5} muted style={{ marginTop: 4 }}>
                Your request is saved — try again, or use Copy Email Details below.
              </Body>
            </Card>
          ) : null}

          {copyOpen ? (
            <View style={{ marginTop: 12 }}>
              {/* No clipboard module exists in the 1.1.0 binary (audit Q9) —
                  this selectable, read-only textarea IS the copy affordance,
                  not a fallback for a failed programmatic copy attempt. */}
              <TextInput
                multiline
                editable={false}
                selectTextOnFocus
                value={prepared.clipboardText}
                style={[styles.copyBox, { color: c.ink, borderColor: c.hair }]}
                accessibilityLabel="Maintenance request text to copy manually"
              />
              <Body size={11.5} muted style={{ marginTop: 6 }}>
                {COPY_HELPER_TEXT}
              </Body>
            </View>
          ) : null}
        </Card>

        <Body muted size={11.5} style={{ marginTop: 16, textAlign: 'center' }}>
          {SECTION_23_NOTE}
        </Body>
      </ScrollView>
    </View>
  );
}

function GateScreen({
  c,
  onBack,
  children,
}: {
  c: ReturnType<typeof useTheme>['c'];
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.root, { backgroundColor: c.paper }]}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.paper }}>
        <View style={styles.topbar}>
          <IconChip icon={ArrowLeft} onPress={onBack} />
        </View>
      </SafeAreaView>
      <View style={{ paddingHorizontal: 20, marginTop: 24 }}>
        <Card padding={16}>
          <Body size={14.5}>{children}</Body>
        </Card>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topbar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  head: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 4,
  },
  body: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 32,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  photoThumb: {
    width: 72,
    height: 72,
    borderRadius: 10,
    backgroundColor: '#e5e5e5',
  },
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
