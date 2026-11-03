import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ORDER_TIMELINE_ICONS,
  orderTimelineMarker,
  orderTimelineMarkerHooks,
} from './order-timeline-marker';

/**
 * Liquid Glass's timeline markers (Order-Detail.dc.html .tl-dot): the events
 * the board draws keep its tone and icon; every icon named here is drawn by
 * order-detail.css; an unknown event keeps the neutral dot (no hooks).
 */
describe('orderTimelineMarker', () => {
  it('gives the board’s events the board’s tone and icon', () => {
    expect(orderTimelineMarker('order_request.created', null)).toEqual({
      tone: 'neutral',
      icon: 'send',
    });
    expect(orderTimelineMarker('order_request.approved', null)).toEqual({
      tone: 'acc',
      icon: 'circle-check',
    });
    expect(orderTimelineMarker('order_request.denied', null)).toEqual({
      tone: 'warn',
      icon: 'circle-x',
    });
    expect(orderTimelineMarker('order.pick_slip_generated', null)).toEqual({
      tone: 'acc',
      icon: 'clipboard-list',
    });
    expect(orderTimelineMarker('order.delivery_request_drafted', null)).toEqual({
      tone: 'info',
      icon: 'mail',
    });
  });

  it('marks a paper hand-over, and no other status change', () => {
    expect(
      orderTimelineMarker('order_request.status_changed', { signatureMethod: 'physical' }),
    ).toEqual({ tone: 'ok', icon: 'pen-line' });
    expect(orderTimelineMarker('order_request.status_changed', { after: { to: 'x' } })).toBeNull();
  });

  it('gives an unknown event no hooks, so glass keeps the neutral dot', () => {
    expect(orderTimelineMarker('order.something_new', null)).toBeNull();
    expect(orderTimelineMarkerHooks('order.something_new', null)).toEqual({});
    expect(orderTimelineMarkerHooks('order.completed', null)).toEqual({
      'data-glass-tone': 'ok',
      'data-glass-icon': 'circle-check',
    });
  });

  it('every icon it names is drawn by the order page’s glass CSS, and nothing else is', () => {
    const css = readFileSync(
      join(__dirname, '..', '..', 'styles', 'liquid-glass', 'pages', 'order-detail.css'),
      'utf8',
    );
    const drawn = [...css.matchAll(/\[data-glass-icon='([\w-]+)'\]/g)].map((m) => m[1]);
    expect([...new Set(drawn)].sort()).toEqual([...ORDER_TIMELINE_ICONS].sort());
    for (const tone of ['acc', 'ok', 'warn', 'info']) {
      expect(css, tone).toContain(`[data-glass-tone='${tone}']`);
    }
  });
});
