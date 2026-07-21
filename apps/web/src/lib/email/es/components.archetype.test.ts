import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MOBILE_GRID_RULES,
  MOBILE_KPI_RULES,
  actionList,
  bodyText,
  brandStrip,
  ctaRow,
  detailGrid,
  emailShell,
  eyebrow,
  footer,
  headline,
  heroSlot,
  infoCard,
  kpiGrid,
  linkFallback,
  ogscBlock,
  orderTimeline,
  section,
  statusPill,
} from './components';

import type { EmailShellStyles } from './components';

/**
 * Archetype fidelity — the three normative reference templates
 * (docs/design/email-system/templates/) rebuilt from the shared
 * component layer with the archetypes' own merge tags as values.
 *
 * A raw byte-diff can't pass (the reference files carry documentation
 * comments and the shell adds the prompt-mandated [data-ogsc] block the
 * archetypes lack), so fidelity is asserted as:
 *  1. FULL normalized-markup equality (comments stripped, whitespace
 *     collapsed, the additive ogsc block removed) — the strongest check:
 *     every tag, attribute, inline style, and copy byte must match;
 *  2. plus targeted byte-exact assertions for the invariants the plan
 *     names: inline style strings, preheader, MSO conditional, the
 *     mobile/dark media blocks, bulletproof button shape, footer copy.
 */

const TEMPLATES_DIR = path.resolve(
  __dirname,
  '../../../../../../docs/design/email-system/templates',
);

function reference(name: string): string {
  return readFileSync(path.join(TEMPLATES_DIR, name), 'utf8');
}

function normalize(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove the additive Outlook.com dark block before diffing against the archetype. */
function stripOgsc(html: string, styles: EmailShellStyles): string {
  return html.replace(`${ogscBlock(styles)}\n`, '');
}

function extractBlock(html: string, startMarker: string): string {
  const start = html.indexOf(startMarker);
  expect(start, `media block "${startMarker}" present`).toBeGreaterThan(-1);
  const end = html.indexOf('\n  }', start);
  return html.slice(start, end + 4);
}

function assertArchetypeInvariants(
  composed: string,
  ref: string,
  { skipStyles = [] as string[] } = {},
) {
  // Every inline style string of the reference appears verbatim.
  const styles = [...ref.matchAll(/style="([^"]*)"/g)].map((m) => m[1]!);
  expect(styles.length).toBeGreaterThan(20);
  for (const s of styles) {
    if (skipStyles.includes(s)) continue;
    expect(composed).toContain(`style="${s}"`);
  }
  // MSO conditional, byte-equal.
  expect(composed).toContain(
    '<!--[if mso]><style>*{font-family:Helvetica,Arial,sans-serif!important}</style><![endif]-->',
  );
  // Mobile + dark media blocks byte-equal to the archetype's.
  expect(composed).toContain(extractBlock(ref, '  @media (max-width:620px){'));
  expect(composed).toContain(
    extractBlock(ref, '  @media (prefers-color-scheme: dark){'),
  );
  // Hidden preheader div with &nbsp; padding.
  const preheader = ref.match(
    /<div style="display:none;max-height:0;overflow:hidden;opacity:0">[\s\S]*?<\/div>/,
  )?.[0];
  expect(preheader).toBeTruthy();
  expect(composed).toContain(preheader!);
  expect(preheader).toContain('&nbsp;');
  // Bulletproof button shape (normalized — it spans lines).
  const button = ref.match(
    /<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn">[\s\S]*?<\/table>/,
  )?.[0];
  expect(button).toBeTruthy();
  expect(normalize(composed)).toContain(normalize(button!));
}

describe('archetype-security.html (password reset)', () => {
  const ref = reference('archetype-security.html');
  const styles: EmailShellStyles = { darkPills: ['sec'], darkCards: '.card' };

  const composed = emailShell({
    title: 'Reset your StockPilot password',
    preheader:
      'This link works for 60 minutes. If you didn&rsquo;t ask for it, you can safely ignore this email.',
    preheaderPad: 6,
    styles,
    rows: [
      brandStrip({ tag: 'Security', logoSrc: '{{asset_base}}/logo-mark-light.png' }),
      section(
        '36px 36px 24px',
        [
          statusPill({ variant: 'sec', label: 'Security &middot; Password reset' }),
          headline({ lead: 'Reset your password.', turn: 'Takes about a minute.' }),
          bodyText(
            'Hi {{name}} — we received a request to reset the password for <strong class="ink" style="font-weight:600;color:#0c0c0e">{{email}}</strong>. If that was you, set a new one below.',
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 24px',
        heroSlot({
          src: '{{asset_base}}/lock@2x.gif',
          alt: 'A lock closes with a soft verification ring — password-reset link secured',
          note: 'motion asset: lock.gif · L1 restrained · plays once, no infinite loop on security',
        }),
      ),
      section(
        '0 36px 26px',
        [
          ctaRow({
            primary: { label: 'Reset password', href: '{{reset_url}}' },
            noteHtml:
              'This link works for <strong class="ink2" style="font-weight:600;color:#2a2a2c">60 minutes</strong> and can be used once. Requested {{requested_at}}, from {{device}}.',
          }),
          linkFallback('{{reset_url}}', { marginTop: 12 }),
        ].join('\n      '),
      ),
      section(
        '0 36px 30px',
        infoCard({
          titleHtml: 'Didn&rsquo;t request this?',
          bodyHtml:
            'Your password hasn&rsquo;t changed and no one has accessed your account. You can safely ignore this email — or <a class="ink2" href="{{support_url}}" style="color:#2a2a2c">tell support</a> if resets keep arriving that you didn&rsquo;t ask for.',
        }),
      ),
      footer({
        kind: 'ess',
        reasonHtml:
          'Sent to <span class="ink2" style="color:#2a2a2c;text-decoration:underline">{{email}}</span> because a password reset was requested for this StockPilot account.',
        urls: {
          support: '{{support_url}}',
          privacy: '{{privacy_url}}',
          terms: '{{terms_url}}',
        },
      }),
    ].join('\n    '),
  });

  it('matches the reference markup (normalized)', () => {
    expect(normalize(stripOgsc(composed, styles))).toBe(normalize(ref));
  });

  it('carries the structural invariants byte-for-byte', () => {
    assertArchetypeInvariants(composed, ref);
    // Essential footer: explains why, offers no unsubscribe.
    expect(composed).toContain(
      'they keep your account safe and can&rsquo;t be unsubscribed.',
    );
    expect(composed).not.toContain('>Unsubscribe</a>');
  });

  it('emits the Outlook.com [data-ogsc] duplicates on top of the archetype dark block', () => {
    expect(composed).toContain('[data-ogsc] .paper{background:#161617!important}');
    expect(composed).toContain(
      '[data-ogsc] .secpill{color:#f6f4ef!important;border-color:rgba(246,244,239,0.4)!important}',
    );
    // The bare body selector is dropped, never emitted as "[data-ogsc] body".
    expect(composed).not.toContain('[data-ogsc] body');
  });
});

describe('archetype-order-status.html (approved)', () => {
  const ref = reference('archetype-order-status.html');
  const styles: EmailShellStyles = {
    darkPills: ['ok'],
    mobileExtras: MOBILE_GRID_RULES,
  };

  const composed = emailShell({
    title: '{{order_id}} is approved',
    preheader:
      'Reserved {{units}} units across {{lines}} lines. Ships {{ship_date}} from {{ship_from}}.',
    preheaderPad: 8,
    styles,
    rows: [
      brandStrip({ tag: 'Order Update', logoSrc: '{{asset_base}}/logo-mark-light.png' }),
      section(
        '36px 36px 24px',
        [
          statusPill({ variant: 'ok', label: 'Approved' }),
          headline({ lead: '{{order_id}} is approved.', turn: 'Packing starts now.' }),
          bodyText(
            'Hi {{name}} — we&rsquo;ve reserved every unit on this request. You&rsquo;ll get another note the moment it leaves the dock.',
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 24px',
        heroSlot({
          src: '{{asset_base}}/settle@2x.gif',
          alt: 'Three cartons settle into a row — your order is reserved and moving to packing',
          note: 'motion asset: settle.gif · frame 1 = resting composition · alt text carries the message',
        }),
      ),
      section(
        '0 36px 26px',
        orderTimeline({
          tone: 'ok',
          steps: [
            { label: 'Received', state: 'done' },
            { label: 'Approved', state: 'current' },
            { label: 'Packing', state: 'upcoming' },
            { label: 'Ready', state: 'upcoming' },
            { label: 'In transit', state: 'upcoming' },
            { label: 'Delivered', state: 'upcoming' },
          ],
        }),
      ),
      section(
        '0 36px 28px',
        detailGrid({
          rows: [
            [
              {
                label: 'Order',
                valueHtml: '{{order_id}}',
                strong: true,
                subHtml: '{{order_number}}',
                subMono: true,
              },
              {
                label: 'Reserved',
                valueHtml:
                  '{{units}} units <span class="ink4" style="color:#8b887f;font-weight:400">&middot; {{lines}} lines</span>',
                strong: true,
                subHtml: 'Ships {{ship_date}}',
              },
            ],
            [
              { label: 'From', valueHtml: '{{ship_from}}' },
              { label: 'To', valueHtml: '{{ship_to}}' },
            ],
          ],
          span: {
            label: 'Approved',
            valueHtml: '{{approved_at}} &middot; by {{approver}}',
          },
        }),
      ),
      section(
        '0 36px 30px',
        [
          ctaRow({ primary: { label: 'Track this order', href: '{{track_url}}' } }),
          linkFallback('{{track_url}}'),
        ].join('\n      '),
      ),
      footer({
        kind: 'pref',
        reasonHtml:
          'Order-status updates for requests placed by <span class="ink2" style="color:#2a2a2c;text-decoration:underline">{{email}}</span>.',
        urls: {
          manage: '{{prefs_url}}',
          unsubscribe: '{{unsubscribe_url}}',
          support: '{{support_url}}',
        },
      }),
    ].join('\n    '),
  });

  it('matches the reference markup (normalized)', () => {
    expect(normalize(stripOgsc(composed, styles))).toBe(normalize(ref));
  });

  it('carries the structural invariants byte-for-byte', () => {
    assertArchetypeInvariants(composed, ref);
    // Preference footer: manage + unsubscribe links and the pref note.
    expect(composed).toContain('>Manage email preferences</a>');
    expect(composed).toContain('>Unsubscribe</a>');
    expect(composed).toContain(
      'Unsubscribing stops this notification type only — security and account emails still arrive.',
    );
  });

  it('renders only the stages the order path contains', () => {
    // The archetype path has no terminal stage; a denied composition
    // must end at "Not approved" and never show shipping stages.
    const denied = orderTimeline({
      tone: 'err',
      steps: [
        { label: 'Received', state: 'done' },
        { label: 'Review', state: 'done' },
        { label: 'Not approved', state: 'terminal' },
      ],
    });
    expect(denied).toContain('Not approved');
    expect(denied).not.toContain('In transit');
    expect(denied).not.toContain('Delivered');
    expect(denied.match(/<td/g)).toHaveLength(3);
  });
});

describe('archetype-digest.html (weekly digest)', () => {
  const ref = reference('archetype-digest.html');
  const styles: EmailShellStyles = {
    darkPills: ['info'],
    darkCards: '.card,.cell',
    mobileExtras: MOBILE_KPI_RULES,
  };

  const kpi = (label: string, tag: string, noteTag: string) => ({
    label,
    valueHtml: tag,
    noteHtml: noteTag,
  });

  const composed = emailShell({
    title: 'StockPilot weekly digest — {{digest_date}}',
    preheader:
      '{{action_count}} things need action &middot; {{orders_received}} orders received &middot; {{overdue_rentals}} overdue rental. Two-minute read.',
    preheaderPad: 3,
    styles,
    rows: [
      brandStrip({ tag: 'Weekly Digest', logoSrc: '{{asset_base}}/logo-mark-light.png' }),
      section(
        '36px 36px 24px',
        [
          statusPill({ variant: 'info', label: '{{digest_range}}', dot: false }),
          headline({
            lead: 'Your week, in order.',
            turn: 'Monday briefing &middot; two minutes.',
          }),
          bodyText(
            'Hi {{name}} — here&rsquo;s what moved across <strong class="ink" style="font-weight:600;color:#0c0c0e">{{workspace}}</strong> last week, and the {{action_count}} things that need a hand.',
          ),
        ].join('\n      '),
      ),
      section(
        '0 36px 24px',
        kpiGrid([
          kpi('Orders received', '{{orders_received}}', '{{orders_received_delta}}'),
          kpi('Approved', '{{orders_approved}}', '{{orders_approved_note}}'),
          kpi('In transit', '{{orders_transit}}', '{{orders_transit_note}}'),
          kpi('Completed', '{{orders_completed}}', '{{orders_completed_note}}'),
        ]),
      ),
      section('0 36px 8px', eyebrow('Needs action')),
      section(
        '8px 36px 24px',
        actionList([
          { tone: 'warn', titleHtml: '{{action_1_title}}', detailHtml: '{{action_1_detail}}' },
          { tone: 'warn', titleHtml: '{{action_2_title}}', detailHtml: '{{action_2_detail}}' },
          { tone: 'err', titleHtml: '{{action_3_title}}', detailHtml: '{{action_3_detail}}' },
        ]),
      ),
      section(
        '0 36px 30px',
        ctaRow({ primary: { label: 'Open dashboard', href: '{{dashboard_url}}' } }),
      ),
      footer({
        kind: 'pref',
        reasonHtml:
          'The weekly digest goes to workspace members who opted in — Mondays at 7:00 AM workspace time.',
        // FLAG: the digest archetype shortens the pref boilerplate —
        // passed explicitly so the bytes match archetype-digest.html:118.
        note: 'Unsubscribing stops this notification type only.',
        urls: {
          manage: '{{prefs_url}}',
          unsubscribe: '{{unsubscribe_url}}',
          support: '{{support_url}}',
        },
      }),
    ].join('\n    '),
  });

  it('matches the reference markup (normalized)', () => {
    expect(normalize(stripOgsc(composed, styles))).toBe(normalize(ref));
  });

  it('carries the structural invariants byte-for-byte', () => {
    // The commented-out preview-strip / all-clear variant blocks live
    // inside reference comments; comment styles are skipped (they are
    // exercised by previewBanner/banner unit tests instead).
    const commentStyles = [
      ...reference('archetype-digest.html')
        .match(/<!--[\s\S]*?-->/g)!
        .join('')
        .matchAll(/style="([^"]*)"/g),
    ].map((m) => m[1]!);
    assertArchetypeInvariants(composed, ref, { skipStyles: commentStyles });
    expect(composed).toContain('Unsubscribing stops this notification type only.');
  });
});
