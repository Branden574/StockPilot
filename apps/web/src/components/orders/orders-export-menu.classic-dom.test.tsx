import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { classicDom, glassOnlyCount } from '@/test/classic-dom';

import { OrdersExportMenu } from './orders-export-menu';

/**
 * CLASSIC IS SACRED: the Export menu, open, normalised as the classic proof
 * normalises it (src/test/classic-dom.ts) and pinned in __classic__/ from the
 * code before Liquid Glass drew its icons and sub-lines. Under `off` nothing
 * glass-only renders; under `default` the glass-only parts drop out and the
 * rest is the pinned DOM.
 */
afterEach(() => vi.unstubAllEnvs());

async function openMenu(rollout: 'off' | 'default') {
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  const user = userEvent.setup();
  const view = render(<OrdersExportMenu tab="needs_approval" />);
  await user.click(screen.getByRole('button', { name: 'Export' }));
  const menu = await screen.findByRole('menu');
  const out = {
    trigger: classicDom(view.container),
    menu: classicDom(menu.parentElement!),
    glassOnly: glassOnlyCount(menu) + glassOnlyCount(view.container),
  };
  view.unmount();
  return out;
}

describe('Export menu: the Classic DOM is the pinned one', () => {
  it('off renders no glass-only part; off and default normalise to the pinned trigger and menu', async () => {
    const off = await openMenu('off');
    const glassBuild = await openMenu('default');
    expect(off.glassOnly).toBe(0);
    expect(glassBuild.trigger).toBe(off.trigger);
    expect(glassBuild.menu).toBe(off.menu);
    await expect(off.trigger).toMatchFileSnapshot('./__classic__/orders-export-menu.trigger.txt');
    await expect(off.menu).toMatchFileSnapshot('./__classic__/orders-export-menu.open.txt');
  });
});
