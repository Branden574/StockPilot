import * as React from 'react';
import { StyleSheet, View } from 'react-native';

import { RETURNS_COPY, type RequesterTrackingReturn } from '@stockpilot/core';

import { Card } from '@/components/ui/card';
import { Body, Eyebrow, Mono } from '@/components/ui/text';
import { requesterTrackingCard } from '@/lib/requester-returns';
import { useTheme } from '@/lib/use-theme';

/**
 * One of the requester's own requests on their order (returns RX-3, brief
 * 28; the token page's "Your requests on this order"): the RMA number and
 * date, the server's sentences, then per line what goes back and what comes
 * instead ("Changed by the warehouse" when another size was approved), and
 * the replacement order's number once it exists. The tracking carries no
 * rack, Staging, disposition, quantity on record, cost, note, reason or staff
 * name, so none can show.
 *
 * Read by VoiceOver as one element (requesterTrackingCard's label: the same
 * words in reading order). Nothing on it is a control: the requester cannot
 * open the RMA. At the AX text sizes the RETURNING and REPLACEMENT halves
 * wrap one under the other (side by side where there is room, the iPad).
 */
export function RequesterTrackingCard({ request }: { request: RequesterTrackingReturn }) {
  const { c } = useTheme();
  const v = requesterTrackingCard(request);
  return (
    <Card padding={14}>
      <View accessible accessibilityLabel={v.accessibilityLabel} style={{ gap: 8 }}>
        <View style={styles.head}>
          <Mono size={12} color={c.ink} style={{ flexShrink: 1 }}>
            {v.title}
          </Mono>
          <Mono size={10.5} color={c.ink3}>
            {v.date}
          </Mono>
        </View>
        {v.sentences.map((s, i) => (
          <Body key={`s-${i}`} size={14} color={c.ink}>
            {s}
          </Body>
        ))}
        {v.lines.map((l) => (
          <View key={l.key} style={styles.pair}>
            <View style={styles.side}>
              <Eyebrow>{RETURNS_COPY.returning}</Eyebrow>
              <Body size={13.5} color={c.ink}>
                {l.returning}
              </Body>
            </View>
            {l.replacement ? (
              // An arrow and a text label, and an ink edge: never colour alone.
              <View style={[styles.side, { borderLeftWidth: 3, borderLeftColor: c.ink, paddingLeft: 10 }]}>
                <Eyebrow>→ {RETURNS_COPY.replacement}</Eyebrow>
                <Body size={13.5} color={c.ink}>
                  {l.replacement}
                </Body>
                {l.state || l.changed ? (
                  <Body size={12.5} muted>
                    {[l.state, l.changed].filter(Boolean).join(' · ')}
                  </Body>
                ) : null}
              </View>
            ) : null}
          </View>
        ))}
        {v.replacementOrder ? (
          <Mono size={11} color={c.ink3}>
            {v.replacementOrder}
          </Mono>
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  pair: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  side: { flexGrow: 1, flexBasis: 220, gap: 2 },
});
