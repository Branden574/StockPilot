import * as React from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import {
  AVAILABILITY_LABELS,
  CART_NEEDED_BY_LABEL_COPY,
  CHECKOUT_EMAIL_LABEL_COPY,
  CHECKOUT_NAME_LABEL_COPY,
  CHECKOUT_NEEDED_BY_CLEAR_COPY,
  CHECKOUT_RECENT_COPY,
  CHECKOUT_REQUESTERS_FAILED_COPY,
  CHECKOUT_REQUESTERS_NONE_COPY,
  CHECKOUT_REQUESTER_SEARCH_COPY,
  CHECKOUT_USE_PERSON_COPY,
  KIT_EACH_KIT_HOLDS_COPY,
  KIT_LINES_NOTE_COPY,
  STOREFRONT_AVAILABILITY_LABEL_COPY,
  STOREFRONT_AVAILABLE_LABEL_COPY,
  STOREFRONT_BIN_LABEL_COPY,
  STOREFRONT_CHOOSE_SITE_COPY,
  STOREFRONT_CHOOSE_WAREHOUSE_COPY,
  STOREFRONT_DONE_COPY,
  STOREFRONT_EARMARK_LABEL_COPY,
  STOREFRONT_FOR_COPY,
  STOREFRONT_MYSELF_COPY,
  STOREFRONT_NO_DELIVERY_SITES_COPY,
  STOREFRONT_ON_BEHALF_EMAIL_PLACEHOLDER_COPY,
  STOREFRONT_ON_BEHALF_NAME_PLACEHOLDER_COPY,
  STOREFRONT_QUANTITY_SAVE_COPY,
  STOREFRONT_QUANTITY_TITLE_COPY,
  STOREFRONT_SHOW_RESULTS_COPY,
  STOREFRONT_SITES_LOAD_FAILED_COPY,
  STOREFRONT_SKU_LABEL_COPY,
  STOREFRONT_SOMEONE_NEW_COPY,
  STOREFRONT_SORT_AND_FILTER_COPY,
  STOREFRONT_SORT_LABEL_COPY,
  STOREFRONT_STATUS_LABEL_COPY,
  availabilityLabel,
  availableOf,
  componentItem,
  kitComponentLineCopy,
  statusOf,
  storefrontInCartCopy,
  storefrontItemCountCopy,
  storefrontQuantityHintCopy,
  type KitOffer,
  type OrderCatalogSite,
  type OrderRecentRequester,
  type OrderStorefrontWarehouse,
  type SortKey,
  type StorefrontItem,
  type StorefrontItemStatus,
} from '@stockpilot/core';

import { NeededByPicker } from '@/components/needed-by-picker';
import { CachedImage } from '@/components/ui/cached-image';
import { Body, FieldLabel, Mono } from '@/components/ui/text';
import {
  initialNeededByDraft,
  neededByDraftView,
  selectNeededByDay,
  type NeededByDraft,
} from '@/lib/order-needed-by';
import { someoneNewCheck, wallClockIso } from '@/lib/order-storefront/checkout';
import { MIN_TAP } from '@/lib/order-storefront/layout';
import { earmarkLabel, matchRequesters, quantityFromField, siteAddressLines, siteLabel } from '@/lib/order-storefront/setup';
import { pickQtyFieldWidthFor, PICK_QTY_MAX_FONT_SIZE_MULTIPLIER } from '@/lib/pick-qty-field';
import { ACCENT, FONT, TYPE_CEILING, capTo } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

import { RadioRow, SmallAction } from './controls';
import { StorefrontSheet } from './storefront-sheet';

/**
 * The storefront's sheets (phone ordering PO-4), each in the shared frame
 * (storefront-sheet.tsx: the sibling backdrop, the keyboard, 640 pt wide at
 * most). Every word is core's; every rule they apply is a tested module's
 * (quantityFromField, matchRequesters, the needed-by draft view).
 */

/** A typed quantity, clamped to what is available (0 removes the line; a
 *  blank field keeps the quantity, as the web's does). The field is as wide
 *  as the digits of what is available at the capped size
 *  (pickQtyFieldWidthFor). */
export function QuantitySheet({
  item,
  quantity,
  onSave,
  onClose,
}: {
  item: StorefrontItem;
  quantity: number;
  onSave: (value: number) => void;
  onClose: () => void;
}) {
  const { c } = useTheme();
  const [text, setText] = React.useState(String(quantity));
  const available = availableOf(item);
  const digits = String(Math.max(1, available)).length;
  const value = quantityFromField(text, available);
  const save = () => (value === null ? onClose() : onSave(value));
  return (
    <StorefrontSheet
      visible
      title={STOREFRONT_QUANTITY_TITLE_COPY}
      onClose={onClose}
      footer={<SmallAction label={STOREFRONT_QUANTITY_SAVE_COPY} variant="primary" onPress={save} />}
    >
      <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
        {item.name}
      </Body>
      <FieldLabel>{STOREFRONT_QUANTITY_TITLE_COPY}</FieldLabel>
      <TextInput
        value={text}
        onChangeText={(t) => setText(t.replace(/[^0-9]/g, ''))}
        keyboardType="number-pad"
        returnKeyType="done"
        autoFocus
        selectTextOnFocus
        onSubmitEditing={save}
        accessibilityLabel={`${STOREFRONT_QUANTITY_TITLE_COPY}: ${item.name}`}
        accessibilityHint={storefrontQuantityHintCopy(available)}
        maxFontSizeMultiplier={PICK_QTY_MAX_FONT_SIZE_MULTIPLIER}
        style={[
          styles.input,
          { width: pickQtyFieldWidthFor(digits), borderColor: c.hair, backgroundColor: c.paper2, color: c.ink },
        ]}
      />
      <Body size={12.5} color={c.ink3}>
        {storefrontQuantityHintCopy(available)}
      </Body>
    </StorefrontSheet>
  );
}

/** Quick view: the photo, SKU, bin, available, status, earmark and the same
 *  control as the row (`control`). */
export function QuickViewSheet({
  item,
  photoUrl,
  inCart,
  control,
  onClose,
  onPhotoError,
}: {
  item: StorefrontItem;
  photoUrl: string | null;
  inCart: number;
  control: React.ReactNode;
  onClose: () => void;
  onPhotoError: () => void;
}) {
  const { c } = useTheme();
  const status = statusOf(item);
  const available = availableOf(item);
  const earmark = earmarkLabel(item);
  const facts: [string, string][] = [
    [STOREFRONT_SKU_LABEL_COPY, item.sku || '—'],
    [STOREFRONT_BIN_LABEL_COPY, item.rackLabel || '—'],
    [STOREFRONT_AVAILABLE_LABEL_COPY, String(available)],
    [STOREFRONT_STATUS_LABEL_COPY, availabilityLabel(status, available, 'long')],
  ];
  if (earmark) facts.push([STOREFRONT_EARMARK_LABEL_COPY, earmark]);
  return (
    <StorefrontSheet visible title={item.name} onClose={onClose}>
      {photoUrl ? (
        <CachedImage
          uri={photoUrl}
          recyclingKey={item.id}
          onError={onPhotoError}
          contentFit="contain"
          style={{ alignSelf: 'stretch', height: 200, borderRadius: 10, backgroundColor: c.paper2 }}
        />
      ) : null}
      {facts.map(([label, value]) => (
        <View key={label} accessible accessibilityLabel={`${label}: ${value}`} style={{ gap: 2 }}>
          <Mono size={11} color={c.ink4} upper tracking={0.12}>
            {label}
          </Mono>
          <Body size={15} color={c.ink}>
            {value}
          </Body>
        </View>
      ))}
      {inCart > 0 ? (
        <Body size={13.5} color={c.ink3}>
          {storefrontInCartCopy(inCart)}
        </Body>
      ) : null}
      <View>{control}</View>
    </StorefrontSheet>
  );
}

/** A kit's Details: what each kit holds, by the names the catalog gives. */
export function KitDetailsSheet({
  kit,
  itemMap,
  control,
  onClose,
}: {
  kit: KitOffer;
  itemMap: ReadonlyMap<string, StorefrontItem>;
  control: React.ReactNode;
  onClose: () => void;
}) {
  const { c } = useTheme();
  return (
    <StorefrontSheet visible title={kit.name} onClose={onClose}>
      <Mono size={11} color={c.ink4} upper tracking={0.12}>
        {KIT_EACH_KIT_HOLDS_COPY}
      </Mono>
      {kit.components.map((comp) => {
        const row = componentItem(comp, itemMap);
        return (
          <Body key={comp.anchorItemId} size={14.5} color={c.ink}>
            {kitComponentLineCopy(comp.perKit, row?.name ?? '—')}
          </Body>
        );
      })}
      <Body size={12.5} color={c.ink3}>
        {KIT_LINES_NOTE_COPY}
      </Body>
      <View>{control}</View>
    </StorefrontSheet>
  );
}

/** Sort & filter: the sorts (a radio group) and the availability filters with
 *  their counts. */
export function SortFilterSheet({
  sort,
  sortOptions,
  availability,
  counts,
  onSort,
  onToggle,
  onClose,
}: {
  sort: SortKey;
  sortOptions: readonly { id: SortKey; label: string }[];
  availability: ReadonlySet<StorefrontItemStatus>;
  counts: Record<StorefrontItemStatus, number>;
  onSort: (sort: SortKey) => void;
  onToggle: (status: StorefrontItemStatus) => void;
  onClose: () => void;
}) {
  const { c } = useTheme();
  const statuses: StorefrontItemStatus[] = ['ok', 'low', 'out'];
  return (
    <StorefrontSheet
      visible
      title={STOREFRONT_SORT_AND_FILTER_COPY}
      onClose={onClose}
      footer={<SmallAction label={STOREFRONT_SHOW_RESULTS_COPY} variant="primary" onPress={onClose} />}
    >
      <Mono size={11} color={c.ink4} upper tracking={0.12}>
        {STOREFRONT_SORT_LABEL_COPY}
      </Mono>
      <View accessibilityRole="radiogroup" accessibilityLabel={STOREFRONT_SORT_LABEL_COPY} style={{ gap: 8 }}>
        {sortOptions.map((o) => (
          <RadioRow key={o.id} label={o.label} checked={sort === o.id} onPress={() => onSort(o.id)} />
        ))}
      </View>
      <Mono size={11} color={c.ink4} upper tracking={0.12}>
        {STOREFRONT_AVAILABILITY_LABEL_COPY}
      </Mono>
      <View style={{ gap: 8 }}>
        {statuses.map((s) => (
          <SmallAction
            key={s}
            label={`${AVAILABILITY_LABELS[s]} · ${storefrontItemCountCopy(counts[s])}`}
            variant={availability.has(s) ? 'primary' : 'outline'}
            accessibilityLabel={`${AVAILABILITY_LABELS[s]}, ${storefrontItemCountCopy(counts[s])}${availability.has(s) ? ', on' : ''}`}
            onPress={() => onToggle(s)}
          />
        ))}
      </View>
    </StorefrontSheet>
  );
}

/** Ship from: the warehouses this account may order from. */
export function WarehouseSheet({
  warehouses,
  current,
  onPick,
  onClose,
}: {
  warehouses: readonly OrderStorefrontWarehouse[];
  current: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <StorefrontSheet visible title={STOREFRONT_CHOOSE_WAREHOUSE_COPY} onClose={onClose}>
      <View accessibilityRole="radiogroup" accessibilityLabel={STOREFRONT_CHOOSE_WAREHOUSE_COPY} style={{ gap: 8 }}>
        {warehouses.map((w) => (
          <RadioRow key={w.id} label={w.name} checked={w.id === current} onPress={() => onPick(w.id)} />
        ))}
      </View>
    </StorefrontSheet>
  );
}

/** The delivery site, with its address lines; the no-site and failed states
 *  in core's words. */
export function SiteSheet({
  sites,
  current,
  onPick,
  onClose,
}: {
  sites: { status: 'ok'; sites: OrderCatalogSite[] } | { status: 'error' } | null;
  current: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { c } = useTheme();
  return (
    <StorefrontSheet visible title={STOREFRONT_CHOOSE_SITE_COPY} onClose={onClose}>
      {sites === null || sites.status === 'error' ? (
        <Body size={14} color={c.ink3} accessibilityRole="alert">
          {STOREFRONT_SITES_LOAD_FAILED_COPY}
        </Body>
      ) : sites.sites.length === 0 ? (
        <Body size={14} color={c.ink3}>
          {STOREFRONT_NO_DELIVERY_SITES_COPY}
        </Body>
      ) : (
        <View accessibilityRole="radiogroup" accessibilityLabel={STOREFRONT_CHOOSE_SITE_COPY} style={{ gap: 8 }}>
          {sites.sites.map((s) => (
            <RadioRow
              key={s.id}
              label={siteLabel(s)}
              detail={siteAddressLines(s.address).join(', ') || null}
              checked={s.id === current}
              onPress={() => onPick(s.id)}
            />
          ))}
        </View>
      )}
    </StorefrontSheet>
  );
}

/** For: Myself, a recent requester (searchable), or Someone new (name and
 *  email). Offered only to someone who may order on behalf (the effective
 *  orders:approve, the server's answer `canOrderOnBehalf`). */
export function RequesterSheet({
  current,
  requesters,
  onPick,
  onClose,
}: {
  current: { name: string; email: string } | null;
  requesters: { status: 'ok'; people: OrderRecentRequester[] } | { status: 'error' } | null;
  onPick: (who: { name: string; email: string } | null) => void;
  onClose: () => void;
}) {
  const { c } = useTheme();
  const [query, setQuery] = React.useState('');
  const [name, setName] = React.useState(current?.name ?? '');
  const [email, setEmail] = React.useState(current?.email ?? '');
  const people = requesters?.status === 'ok' ? matchRequesters(requesters.people, query) : [];
  // What the route would refuse is refused here first (desk check F11).
  const check = someoneNewCheck(name, email);
  const inputStyle = [styles.input, { borderColor: c.hair, backgroundColor: c.paper2, color: c.ink }];
  return (
    <StorefrontSheet
      visible
      title={STOREFRONT_FOR_COPY}
      onClose={onClose}
      footer={
        // The someone-new action and its reason stay above the keyboard: at
        // the bottom of the body they were cut off by its edge while the
        // email was typed, and the part showing took no tap (simulator walk D6).
        <>
          {check.message ? (
            <Body size={13} color={ACCENT.crit}>
              {check.message}
            </Body>
          ) : null}
          <SmallAction
            label={CHECKOUT_USE_PERSON_COPY}
            variant="primary"
            disabled={!check.canUse}
            hint={check.message ?? undefined}
            onPress={() => onPick({ name: name.trim(), email: email.trim() })}
          />
        </>
      }
    >
      <RadioRow label={STOREFRONT_MYSELF_COPY} checked={current === null} onPress={() => onPick(null)} />
      <Mono size={11} color={c.ink4} upper tracking={0.12}>
        {CHECKOUT_RECENT_COPY}
      </Mono>
      {requesters?.status === 'error' ? (
        <Body size={13} color={c.ink3}>
          {CHECKOUT_REQUESTERS_FAILED_COPY}
        </Body>
      ) : (
        <>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={CHECKOUT_REQUESTER_SEARCH_COPY}
            placeholderTextColor={c.ink4}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={CHECKOUT_REQUESTER_SEARCH_COPY}
            maxFontSizeMultiplier={INPUT_CAP}
            style={inputStyle}
          />
          {people.length === 0 ? (
            <Body size={13} color={c.ink3}>
              {CHECKOUT_REQUESTERS_NONE_COPY}
            </Body>
          ) : (
            people.map((p) => (
              <RadioRow
                key={p.email.toLowerCase()}
                label={p.name ?? p.email}
                detail={p.name ? p.email : null}
                checked={current?.email.toLowerCase() === p.email.toLowerCase()}
                onPress={() => onPick({ name: p.name ?? p.email, email: p.email })}
              />
            ))
          )}
        </>
      )}
      <Mono size={11} color={c.ink4} upper tracking={0.12}>
        {STOREFRONT_SOMEONE_NEW_COPY}
      </Mono>
      <FieldLabel>{CHECKOUT_NAME_LABEL_COPY}</FieldLabel>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder={STOREFRONT_ON_BEHALF_NAME_PLACEHOLDER_COPY}
        placeholderTextColor={c.ink4}
        autoCapitalize="words"
        accessibilityLabel={CHECKOUT_NAME_LABEL_COPY}
        maxFontSizeMultiplier={INPUT_CAP}
        style={inputStyle}
      />
      <FieldLabel>{CHECKOUT_EMAIL_LABEL_COPY}</FieldLabel>
      <TextInput
        value={email}
        onChangeText={setEmail}
        placeholder={STOREFRONT_ON_BEHALF_EMAIL_PLACEHOLDER_COPY}
        placeholderTextColor={c.ink4}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        accessibilityLabel={CHECKOUT_EMAIL_LABEL_COPY}
        maxFontSizeMultiplier={INPUT_CAP}
        style={inputStyle}
      />
    </StorefrontSheet>
  );
}

/** Needed by: the shared picker (needed-by-picker.tsx, F2-4's), in the
 *  organization's zone, its "now" the server's; Clear (it is optional) and
 *  Done. Done sets only a time the view accepts. */
export function NeededBySheet({
  zone,
  currentWall,
  serverSkewMs,
  zoneNote,
  onSet,
  onClose,
}: {
  zone: string;
  /** The cart's wall clock ("YYYY-MM-DDTHH:mm"), or ''. */
  currentWall: string;
  serverSkewMs: number;
  zoneNote: string;
  onSet: (wall: string) => void;
  onClose: () => void;
}) {
  const { c } = useTheme();
  const clock = React.useCallback(() => Date.now() + serverSkewMs, [serverSkewMs]);
  const [now, setNow] = React.useState(() => clock());
  const [draft, setDraft] = React.useState<NeededByDraft>(() => {
    return initialNeededByDraft(wallClockIso(currentWall, zone), now, zone);
  });
  const [focusOther, setFocusOther] = React.useState(false);
  React.useEffect(() => {
    const timer = setInterval(() => setNow(clock()), 30_000);
    return () => clearInterval(timer);
  }, [clock]);
  const view = neededByDraftView(draft, {
    now,
    zone,
    current: null,
    status: null,
    offline: false,
    busy: false,
    closed: false,
  });
  const update = (patch: Partial<NeededByDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setNow(clock());
  };
  return (
    <StorefrontSheet
      visible
      title={CART_NEEDED_BY_LABEL_COPY}
      onClose={onClose}
      footer={
        <SmallAction
          label={STOREFRONT_DONE_COPY}
          variant="primary"
          disabled={view.wall === null}
          hint={view.wall === null ? (view.timeProblem ?? undefined) : undefined}
          onPress={() => {
            if (view.wall) onSet(view.wall);
          }}
        />
      }
    >
      <Body size={12.5} color={c.ink3}>
        {zoneNote}
      </Body>
      <NeededByPicker
        view={view}
        draft={draft}
        busy={false}
        focusOther={focusOther}
        onPickDay={(dayKey) => {
          const at = clock();
          setDraft((d) => selectNeededByDay(d, dayKey, at, zone));
          setNow(at);
        }}
        onPickSlot={(time) => update({ slot: time, other: false })}
        onPickOther={() => {
          update({ other: true });
          setFocusOther(true);
        }}
        onOtherText={(t) => update({ otherText: t })}
        clear={{ label: CHECKOUT_NEEDED_BY_CLEAR_COPY, onPress: () => onSet('') }}
      />
    </StorefrontSheet>
  );
}

const INPUT_CAP = capTo(15, TYPE_CEILING.input);

const styles = StyleSheet.create({
  input: {
    minHeight: MIN_TAP,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: FONT.mono,
    fontSize: 15,
  },
});
