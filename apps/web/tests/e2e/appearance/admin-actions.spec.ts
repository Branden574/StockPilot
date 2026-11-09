import { expect, test, type Page } from '@playwright/test';

import {
  chooseLook,
  chooseLookElsewhere,
  glassBuild,
  openRemote,
  settle,
  settleIntroNotice,
} from './look';

/**
 * EVERY ACTION STAYS (brief: "every feature stays"; plan 8.5 action
 * inventory) on the admin lane: on each settings, admin and platform console
 * page, the controls a person can reach (links, buttons, fields, choices,
 * tabs, with their names and whether they are enabled) are the same in
 * Classic Dark and in Liquid Glass Day and Night, in the same order, and each
 * one still has a box on screen (nothing the glass draws hides it). The
 * glass-only appearance controls are left out (glass-only-allowlist.json);
 * the console has none.
 *
 * Needs a running server and a signed-in lab user who is an organization
 * admin; the console pages also need the platform allowlist at the two-step
 * level and are skipped when /platform answers 404. The integrator's lab run.
 */

const DASHBOARD_ROUTES = [
  '/dashboard/settings',
  '/dashboard/settings/profile',
  '/dashboard/settings/organization',
  '/dashboard/settings/security',
  '/dashboard/settings/notifications',
  '/dashboard/settings/modules',
  '/dashboard/settings/roles',
  '/dashboard/settings/email-routing',
  '/dashboard/settings/public-requests',
  '/dashboard/settings/restore-points',
  '/dashboard/admin',
  '/dashboard/admin/warehouses',
  '/dashboard/admin/charters',
  '/dashboard/admin/bins',
];

const CONSOLE_ROUTES = ['/platform', '/platform/provision', '/platform/support', '/platform/audit'];

interface Control {
  role: string;
  name: string;
  enabled: boolean;
}

/** The reachable controls of the page's content and its frame, in document order. */
async function inventory(page: Page): Promise<Control[]> {
  return page.evaluate(() => {
    const scope =
      document.querySelector('[data-glass-page="platform"]') ??
      document.querySelector('main') ??
      document.body;
    const roleOf = (el: Element): string => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const type = (el as HTMLInputElement).type;
        return type === 'checkbox' || type === 'radio' ? type : 'textbox';
      }
      return tag;
    };
    const nameOf = (el: Element): string => {
      const label = el.getAttribute('aria-label');
      if (label) return label.trim();
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        return by
          .split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
          .join(' ');
      }
      const id = el.getAttribute('id');
      const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      if (forLabel) return forLabel.textContent?.trim() ?? '';
      return (el.textContent ?? '').replace(/\s+/gu, ' ').trim();
    };
    const out: { role: string; name: string; enabled: boolean }[] = [];
    for (const el of scope.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, [role="tab"], [role="switch"]',
    )) {
      if (el.closest('[data-glass-only]')) continue;
      if (el.closest('[aria-hidden="true"], [inert]')) continue;
      out.push({
        role: roleOf(el),
        name: nameOf(el),
        enabled: !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true',
      });
    }
    return out;
  });
}

/** Controls a person should see that have no box (display none, zero size) in this look. */
async function hiddenControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const scope =
      document.querySelector('[data-glass-page="platform"]') ??
      document.querySelector('main') ??
      document.body;
    const out: string[] = [];
    for (const el of scope.querySelectorAll<HTMLElement>(
      'a[href], button, input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), select, textarea',
    )) {
      if (el.closest('[data-glass-only], [aria-hidden="true"], [inert], [hidden]')) continue;
      if (el.matches('.sr-only, .sr-only *')) continue;
      const classicHidden = el.closest('[data-classic-only]');
      if (classicHidden) continue;
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || r.width * r.height === 0) {
        out.push(
          `${el.tagName.toLowerCase()}: ${el.getAttribute('aria-label') ?? el.textContent?.trim()}`,
        );
      }
    }
    return out;
  });
}

test.describe('settings and admin pages: the same actions in every look', () => {
  for (const route of DASHBOARD_ROUTES) {
    test(route, async ({ page }) => {
      const response = await page.goto(route);
      if (!response || response.status() >= 400)
        test.skip(true, `${route} is not open to this user.`);
      if (!(await glassBuild(page))) test.skip(true, 'This build does not offer Liquid Glass.');
      await settleIntroNotice(page);
      await chooseLook(page, { design: 'classic', theme: 'dark' });
      await settle(page);
      const classic = await inventory(page);
      const classicHidden = await hiddenControls(page);
      for (const theme of ['dark', 'light'] as const) {
        await chooseLook(page, { design: 'liquid-glass', theme });
        await settle(page);
        expect(await inventory(page), `${route} in Liquid Glass ${theme}`).toEqual(classic);
        expect(await hiddenControls(page), `${route} hidden in Liquid Glass ${theme}`).toEqual(
          classicHidden,
        );
      }
      await chooseLook(page, { design: 'classic', theme: 'dark' });
    });
  }
});

test.describe('the platform console: the same actions in every look', () => {
  for (const route of CONSOLE_ROUTES) {
    test(route, async ({ page, context }) => {
      const remote = await openRemote(context);
      const response = await page.goto(route);
      if (!response || response.status() === 404) {
        test.skip(true, 'This lab user is not a platform admin at the two-step level.');
      }
      if (!(await glassBuild(remote))) test.skip(true, 'This build does not offer Liquid Glass.');
      await chooseLookElsewhere(remote, page, { design: 'classic', theme: 'dark' });
      await settle(page);
      const classic = await inventory(page);
      const classicHidden = await hiddenControls(page);
      for (const theme of ['dark', 'light'] as const) {
        await chooseLookElsewhere(remote, page, { design: 'liquid-glass', theme });
        await settle(page);
        expect(await inventory(page), `${route} in Liquid Glass ${theme}`).toEqual(classic);
        expect(await hiddenControls(page), `${route} hidden in Liquid Glass ${theme}`).toEqual(
          classicHidden,
        );
      }
      await chooseLookElsewhere(remote, page, { design: 'classic', theme: 'dark' });
      await remote.close();
    });
  }
});
