import { describe, expect, it } from 'vitest';

import { fitTrail, trailRoom, TRAIL_MEASURE_SLOT, TRAIL_SLOT } from './topbar-trail-fit';

/**
 * P68-01: on a touch tablet (44 px icon buttons) the top bar's warehouse
 * picker gave up its width before the breadcrumb did and read "Al…" on New
 * order at 810 px, where the bar before the redesign showed it whole. The
 * trail now gives way first, in steps, and these pin the arithmetic that
 * picks the step. The numbers are the verifier's, measured in Chromium on
 * New order at 810 px beside the 228 px sidebar: a 534 px bar inside, 12 px
 * gaps, the 44 px sidebar toggle and search icon, the 136 px cluster (bell,
 * What's new, account), the 156.5 px picker with "All warehouses", and a
 * 180 px "Fulfillment / Orders / New" whose last crumb is 28.8 px.
 */

describe('fitTrail', () => {
  it('draws the whole trail when it fits, else the current page alone, else nothing', () => {
    expect(fitTrail(300, 180, 28.8)).toBe('full');
    expect(fitTrail(105.5, 180, 28.8)).toBe('current');
    expect(fitTrail(20, 180, 28.8)).toBe('none');
  });

  // Mutation caught: the slack dropped, so a trail that fits only to within
  // rounding is drawn whole and its last letter becomes an ellipsis.
  it('keeps half a pixel of slack, so a trail is never drawn a fraction too wide', () => {
    expect(fitTrail(180.4, 180, 28.8)).toBe('current');
    expect(fitTrail(180.5, 180, 28.8)).toBe('full');
    expect(fitTrail(29.2, 180, 28.8)).toBe('none');
    expect(fitTrail(29.3, 180, 28.8)).toBe('current');
  });
});

function child(
  width: number,
  style: Partial<CSSStyleDeclaration> = {},
  slot?: string,
): HTMLElement {
  const el = document.createElement('div');
  Object.assign(el.style, style);
  if (slot) el.dataset.slot = slot;
  el.getBoundingClientRect = () => ({ width }) as DOMRect;
  return el;
}

function bar(inside: number, children: HTMLElement[]): HTMLElement {
  const header = document.createElement('header');
  Object.assign(header.style, {
    display: 'flex',
    paddingLeft: '24px',
    paddingRight: '24px',
    columnGap: '12px',
  });
  Object.defineProperty(header, 'clientWidth', { value: inside + 48 });
  header.append(...children);
  document.body.append(header);
  return header;
}

describe('trailRoom', () => {
  // Mutation caught: the trail's own gap left out (the trail is drawn 12 px
  // too wide), a hidden control counted, or the measuring copy counted.
  it('is the bar inside, less every other control shown and every gap, counting the trail once', () => {
    const header = bar(534, [
      child(44), // the sidebar toggle
      child(180, {}, TRAIL_SLOT), // the trail: never counts its own width
      child(1000, { position: 'absolute' }, TRAIL_MEASURE_SLOT), // the copy
      child(156.5), // the picker
      child(44), // the search icon
      child(340, { display: 'none' }), // the full search bar, under 960 px
      child(136), // bell, What's new, account
    ]);
    // 534 - (44 + 156.5 + 44 + 136) - 4 gaps of 12 px.
    expect(trailRoom(header)).toBeCloseTo(105.5, 5);
    expect(fitTrail(trailRoom(header), 180, 28.8)).toBe('current');
  });

  it('counts the trail gap even while no trail is drawn, so the step it picks never changes the room', () => {
    const header = bar(534, [child(44), child(156.5), child(44), child(136)]);
    expect(trailRoom(header)).toBeCloseTo(105.5, 5);
  });

  // Mutation caught: the search bar counted at the width it grew to, so the
  // trail would give way to the search bar's growth.
  it('counts the full search bar at its 240 px floor, which it gives up before the trail does', () => {
    const header = bar(1004, [
      child(32),
      child(156.5),
      child(340, { flexGrow: '1', minWidth: '240px' }),
      child(236),
    ]);
    // 1004 - (32 + 156.5 + 240 + 236) - 4 gaps: "Workspace / Settings /
    // Roles & permissions" (294.5 px) does not fit at 1280; its last crumb does.
    expect(trailRoom(header)).toBeCloseTo(291.5, 5);
    expect(fitTrail(trailRoom(header), 294.5, 128.4)).toBe('current');
  });
});
