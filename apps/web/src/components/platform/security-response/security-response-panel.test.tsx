import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  SECURITY_RESPONSE_CARDS,
  SECURITY_RESPONSE_LEVEL_WORDS,
  SECURITY_RESPONSE_STEPS,
  SECURITY_RESPONSE_WORDS,
  securityResponseCard,
  type SecurityResponseCardId,
} from '@stockpilot/core';

vi.mock('next/link', async () => {
  const R = await import('react');
  return {
    default: ({
      href,
      prefetch,
      children,
      className,
    }: {
      href: string;
      prefetch?: boolean | null;
      children: React.ReactNode;
      className?: string;
    }) => R.createElement('a', { href, className, 'data-prefetch': String(prefetch) }, children),
  };
});

const samples = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => ({
    ok: true,
    view: {
      country: null,
      windowFrom: null,
      targets: [
        {
          reason: 'env_file',
          target: '/backup/.env',
          events: 2,
          pairs: [{ method: 'GET', sample: null, events: 2 }],
          pairsTruncated: false,
        },
      ],
      targetsTruncated: false,
      listedTargets: 1,
      moreThanListed: [],
    },
  })),
);
vi.mock('@/server/actions/platform/security-event-samples', () => ({
  readSecurityEventSamplesAction: (...a: unknown[]) => samples(...a),
}));

import { SecurityResponseButton } from './security-response-button';
import { SecurityResponseHost, type SecurityResponseRequest } from './security-response-host';
import { SecurityResponsePanel, filledRoute } from './security-response-panel';

/**
 * THE HOW-TO-RESPOND PANEL. Pinned: the five parts in their order, and an Act
 * now card leads with "If one got through"; the entry's own context on top
 * and nothing else; a console place is a link with the entry's organization
 * filled in and never prefetched, a place that needs Act as this org is text
 * and never a link; a step that points to another card opens it, and Back
 * returns; Escape and Close close it, focus stays inside while open and goes
 * back to the control; the control shows nothing outside a host, carries the
 * card's level as words and a shape, and loads the panel on the first press.
 */

const ORG = '5eed0000-0001-4000-8000-0000000000d4';

function request(over: Partial<SecurityResponseRequest> = {}): SecurityResponseRequest {
  return {
    cardId: 'repeated-wrong-guesses',
    what: 'Repeated wrong passwords from one source',
    context: {
      kind: 'Password guessing',
      place: 'Example Falls, United States',
      time: '21:58 UTC',
      organization: 'Example Academy',
    },
    organizationId: ORG,
    ...over,
  };
}

function Panel({
  req = request(),
  onOpenChange = () => {},
}: {
  req?: SecurityResponseRequest;
  onOpenChange?: (open: boolean) => void;
}) {
  const returnTo = React.useRef<HTMLElement | null>(null);
  return (
    <SecurityResponsePanel
      request={req}
      open
      onOpenChange={onOpenChange}
      returnFocusTo={returnTo}
    />
  );
}

const dialog = () => screen.getByRole('dialog');
/** The link on the organization's name under "Opened from", or null. */
const organizationLink = (): HTMLAnchorElement | null => {
  const dt = [...dialog().querySelectorAll('dt')].find((d) => d.textContent === 'Organization');
  return dt?.nextElementSibling?.querySelector('a') ?? null;
};
const partOrder = () =>
  [...dialog().querySelectorAll('section[data-part]')].map((s) => s.getAttribute('data-part'));

describe('the card in the panel', () => {
  it('the title, the level as words and a shape, and the five parts in order', () => {
    render(<Panel />);
    const card = securityResponseCard('repeated-wrong-guesses');
    expect(
      within(dialog()).getByRole('heading', { level: 2, name: card.title }),
    ).toBeInTheDocument();
    const level = within(dialog()).getByTestId('security-response-level');
    expect(level).toHaveAttribute('data-level', 'look_today');
    expect(level.textContent).toBe(SECURITY_RESPONSE_LEVEL_WORDS.look_today);
    expect(level.querySelector('[data-part="level-mark"]')).not.toBeNull();
    expect(partOrder()).toEqual([
      'what-this-is',
      'already-did',
      'do-now',
      'if-got-through',
      'cannot-tell',
    ]);
    expect(dialog().textContent).toContain(card.whatThisIs);
    for (const line of card.alreadyDid) expect(dialog().textContent).toContain(line);
    expect(dialog().textContent).toContain(card.cannotTell);
  });

  it('an Act now card shows "If one got through" first, above "What this is"', () => {
    for (const card of SECURITY_RESPONSE_CARDS) {
      const { unmount } = render(<Panel req={request({ cardId: card.id })} />);
      const order = partOrder();
      if (
        ['sign-in-not-me', 'passkey-unexplained-sign-in', 'passkey-counter-went-back'].includes(
          card.id,
        )
      ) {
        expect(order[0], card.id).toBe('if-got-through');
        expect(order.indexOf('if-got-through'), card.id).toBeLessThan(
          order.indexOf('what-this-is'),
        );
      } else {
        expect(order[0], card.id).toBe('what-this-is');
      }
      unmount();
    }
  });

  it("the entry's own context on top: kind, place, time and organization, and only those it has", () => {
    render(<Panel />);
    const context = screen.getByTestId('security-response-context');
    const rows = [...context.querySelectorAll('dt')].map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]);
    expect(rows).toEqual([
      ['Kind', 'Password guessing'],
      ['Where', 'Example Falls, United States'],
      ['When', '21:58 UTC'],
      ['Organization', 'Example Academy'],
    ]);
    // The organization's id fills a link; it is never shown as words.
    expect(dialog().textContent).not.toContain(ORG);
  });

  it('a context with fewer facts shows fewer rows; with none, no context block', () => {
    const { unmount } = render(
      <Panel
        req={request({
          context: {
            kind: null,
            place: 'Example Harbour, Portugal',
            time: '21:40 UTC',
            organization: null,
          },
          organizationId: null,
        })}
      />,
    );
    const rows = [...screen.getByTestId('security-response-context').querySelectorAll('dt')].map(
      (dt) => dt.textContent,
    );
    expect(rows).toEqual(['Where', 'When']);
    unmount();
    render(
      <Panel
        req={request({
          context: { kind: null, place: null, time: null, organization: null },
          organizationId: null,
        })}
      />,
    );
    expect(screen.queryByTestId('security-response-context')).toBeNull();
  });

  it("a console place is a link with the entry's organization filled in, never prefetched", () => {
    render(<Panel />);
    const links = within(dialog()).getAllByRole('link');
    const hrefs = links.map((a) => a.getAttribute('href'));
    expect(hrefs).toContain(`/platform/orgs/${ORG}?tab=users`);
    expect(hrefs).toContain(`/platform/orgs/${ORG}`);
    expect(hrefs).toContain('/platform/security');
    for (const a of links) expect(a).toHaveAttribute('data-prefetch', 'false');
    // Every link is a console page: the organization's own app is never linked.
    for (const href of hrefs) expect(href).toMatch(/^\/platform(\/|$|\?)/);
  });

  it('a place that opens only after Act as this org is text, never a link, and the note says how', () => {
    render(<Panel />);
    const afterActAs = [...dialog().querySelectorAll('[data-after-act-as]')];
    expect(afterActAs.length).toBeGreaterThan(0);
    for (const p of afterActAs) {
      expect(p.querySelector('a')).toBeNull();
      expect(p.textContent).toMatch(/^After Act as this org: /);
      expect(p.textContent).toMatch(/\/dashboard\//);
    }
    expect(screen.getByTestId('security-response-act-as-note').textContent).toBe(
      SECURITY_RESPONSE_WORDS.actAsNote,
    );
  });

  it('with no organization, a place that needs one is its way and route as text, not a link', () => {
    render(<Panel req={request({ organizationId: null })} />);
    const hrefs = within(dialog())
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs.some((h) => h?.includes('/platform/orgs/'))).toBe(false);
    expect(dialog().textContent).toContain('/platform/orgs/<organization id>?tab=users');
    expect(filledRoute('/platform/orgs/<organization id>', 'not-a-uuid')).toBeNull();
    expect(filledRoute('/platform/security', null)).toBe('/platform/security');
  });

  it('the organization under "Opened from" is a link to its console page when the entry names one, never prefetched', () => {
    render(<Panel />);
    const link = organizationLink()!;
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', `/platform/orgs/${ORG}`);
    expect(link).toHaveAttribute('data-prefetch', 'false');
    expect(link.textContent).toBe('Example Academy');
    expect(link.closest('dd')?.previousElementSibling?.textContent).toBe('Organization');
    expect(screen.queryByTestId('security-response-several-organizations')).toBeNull();
  });

  it('an entry recorded in several organizations: no link, the routes as text, and the panel says how many, not which', () => {
    render(
      <Panel
        req={request({
          context: { ...request().context, organization: '3 organizations' },
          organizationId: null,
          organizations: 3,
        })}
      />,
    );
    expect(organizationLink()).toBeNull();
    expect(screen.getByTestId('security-response-several-organizations').textContent).toBe(
      SECURITY_RESPONSE_WORDS.severalOrganizations(3),
    );
    const hrefs = within(dialog())
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs.some((h) => h?.includes('/platform/orgs/'))).toBe(false);
    expect(dialog().textContent).toContain('/platform/orgs/<organization id>?tab=users');
  });

  it('an entry with no organization renders no broken link: no link to an organization, and no note', () => {
    for (const organizationId of [null, 'not-a-uuid', '']) {
      const { unmount } = render(
        <Panel
          req={request({
            context: { ...request().context, organization: 'No organization' },
            organizationId,
            organizations: 0,
          })}
        />,
      );
      expect(organizationLink(), String(organizationId)).toBeNull();
      expect(screen.queryByTestId('security-response-several-organizations')).toBeNull();
      for (const a of within(dialog()).getAllByRole('link')) {
        const href = a.getAttribute('href') ?? '';
        expect(href, href).not.toMatch(/\/platform\/orgs\/|null|undefined|organization id|%3C/);
      }
      unmount();
    }
  });

  it("a shared step is shown in its own words, once, with the card's lead-in", () => {
    render(<Panel req={request({ cardId: 'second-step-paused' })} />);
    const stop = dialog().querySelector(
      '[data-part="if-got-through"] li[data-step="stop-access"]',
    )!;
    expect(stop.textContent).toContain(SECURITY_RESPONSE_STEPS['stop-access'].text);
    expect(stop.textContent).toMatch(/^Reaching the second step usually takes the right password/);
  });

  it('a step that points to another card opens it in the panel, and Back returns', () => {
    render(<Panel req={request({ cardId: 'wrong-password' })} />);
    const go = within(dialog()).getByRole('button', {
      name: `${SECURITY_RESPONSE_WORDS.seeCard}: ${securityResponseCard('sign-in-not-me').title}`,
    });
    fireEvent.click(go);
    expect(dialog()).toHaveAttribute('data-card', 'sign-in-not-me');
    expect(within(dialog()).getByRole('heading', { level: 2 })).toHaveTextContent(
      securityResponseCard('sign-in-not-me').title,
    );
    // Focus goes to the new card's title.
    expect(document.activeElement).toBe(within(dialog()).getByRole('heading', { level: 2 }));
    fireEvent.click(within(dialog()).getByRole('button', { name: SECURITY_RESPONSE_WORDS.back }));
    expect(dialog()).toHaveAttribute('data-card', 'wrong-password');
    expect(
      within(dialog()).queryByRole('button', { name: SECURITY_RESPONSE_WORDS.back }),
    ).toBeNull();
  });

  it('"What was asked for": only for an entry that hands one, at the top of the body, read once; kept while another card is shown', async () => {
    samples.mockClear();
    const { unmount } = render(<Panel />);
    expect(within(dialog()).queryByRole('region', { name: 'What was asked for' })).toBeNull();
    unmount();
    expect(samples).not.toHaveBeenCalled();

    render(
      <Panel
        req={request({
          cardId: 'wrong-password',
          asked: { reason: 'env_file', at: Date.now(), country: null, timeZone: 'UTC' },
        })}
      />,
    );
    const region = within(dialog()).getByRole('region', { name: 'What was asked for' });
    const body = within(dialog()).getByTestId('security-response-body');
    expect(body.firstElementChild?.contains(region)).toBe(true);
    // Not one of the card's five parts.
    expect(region).not.toHaveAttribute('data-part');
    await waitFor(() => expect(region.textContent).toContain('/backup/.env'));
    // The entry's context above says nothing of what was asked for.
    expect(within(dialog()).getByTestId('security-response-context').textContent).not.toContain(
      '/backup/.env',
    );
    fireEvent.click(
      within(dialog()).getByRole('button', {
        name: `${SECURITY_RESPONSE_WORDS.seeCard}: ${securityResponseCard('sign-in-not-me').title}`,
      }),
    );
    expect(within(dialog()).queryByRole('region', { name: 'What was asked for' })).toBeNull();
    fireEvent.click(within(dialog()).getByRole('button', { name: SECURITY_RESPONSE_WORDS.back }));
    expect(
      within(dialog()).getByRole('region', { name: 'What was asked for' }).textContent,
    ).toContain('/backup/.env');
    expect(samples).toHaveBeenCalledTimes(1);
  });

  it("every card renders with no number and no hidden kind's name in its words", () => {
    for (const card of SECURITY_RESPONSE_CARDS) {
      const { unmount } = render(
        <Panel
          req={request({
            cardId: card.id as SecurityResponseCardId,
            context: { kind: null, place: null, time: null, organization: null },
          })}
        />,
      );
      const words = dialog().textContent ?? '';
      expect(words.replace(/\/[a-z/<>?=.-]+/gi, ''), card.id).not.toMatch(/\d/);
      expect(words, card.id).not.toMatch(/phishing/i);
      // Part 6: only the malware kind's own card says the word, to say what it means here.
      if (card.id !== 'upload-checks') expect(words, card.id).not.toMatch(/malware/i);
      unmount();
    }
  });

  it('Escape and the Close button ask to close it', () => {
    const onOpenChange = vi.fn();
    render(<Panel onOpenChange={onOpenChange} />);
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    onOpenChange.mockClear();
    fireEvent.click(within(dialog()).getByRole('button', { name: SECURITY_RESPONSE_WORDS.close }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});

describe('the control and the host', () => {
  it('outside a host the control shows nothing', () => {
    const { container } = render(<SecurityResponseButton request={request()} />);
    expect(container.innerHTML).toBe('');
  });

  it('beside the control, the level in words and a shape; the control is named for its entry', () => {
    render(
      <SecurityResponseHost>
        <SecurityResponseButton
          request={request({
            cardId: 'sign-in-not-me',
            what: 'A member said a sign-in was not them',
          })}
        />
      </SecurityResponseHost>,
    );
    const button = screen.getByRole('button', {
      name: 'How to respond: A member said a sign-in was not them',
    });
    const control = button.closest('[data-slot="security-response-control"]')!;
    const level = within(control as HTMLElement).getByTestId('security-response-level');
    expect(level).toHaveAttribute('data-level', 'act_now');
    expect(level.textContent).toBe('Act now');
    expect(level.querySelector('[data-part="level-mark"] path')).not.toBeNull();
    // Not colour alone: the weight differs from the other levels.
    expect(level.className).toContain('font-semibold');
  });

  it('a kind of the legend: the control without a badge', () => {
    render(
      <SecurityResponseHost>
        <SecurityResponseButton showLevel={false} request={request()} />
      </SecurityResponseHost>,
    );
    expect(screen.queryByTestId('security-response-level')).toBeNull();
  });

  it('the first press loads the panel and opens the card; Escape closes it and focus goes back to the control', async () => {
    const user = userEvent.setup();
    render(
      <SecurityResponseHost>
        <p>Before</p>
        <SecurityResponseButton request={request()} />
      </SecurityResponseHost>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    const button = screen.getByRole('button', { name: /^How to respond: / });
    await user.click(button);
    const panel = await screen.findByRole('dialog');
    expect(panel).toHaveAttribute('data-card', 'repeated-wrong-guesses');
    // Focus is inside the panel, and Tab keeps it there.
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    for (let i = 0; i < 30; i += 1) {
      await user.tab();
      expect(panel.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it("the control's entry left the list while the panel was open: focus goes to the list's heading (review S1)", async () => {
    const user = userEvent.setup();
    const List = ({ entry }: { entry: boolean }) => (
      <SecurityResponseHost>
        <section aria-label="Attack map">
          <section aria-labelledby="flagged-heading">
            <h3 id="flagged-heading">Flagged</h3>
            {entry ? <SecurityResponseButton request={request()} /> : null}
          </section>
        </section>
      </SecurityResponseHost>
    );
    const view = render(<List entry />);
    await user.click(screen.getByRole('button', { name: /^How to respond: / }));
    await screen.findByRole('dialog');
    // A poll moves the entry out of the list while the card is read.
    view.rerender(<List entry={false} />);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const heading = screen.getByRole('heading', { name: 'Flagged' });
    expect(document.activeElement).toBe(heading);
    // Focus from code only: the heading is not put in the Tab order.
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('the Close button closes it too, and a second press opens the card again from its start', async () => {
    const user = userEvent.setup();
    render(
      <SecurityResponseHost>
        <SecurityResponseButton
          request={request({ cardId: 'wrong-password', what: 'Wrong password at sign-in' })}
        />
      </SecurityResponseHost>,
    );
    const button = screen.getByRole('button', {
      name: 'How to respond: Wrong password at sign-in',
    });
    await user.click(button);
    const panel = await screen.findByRole('dialog');
    await user.click(
      within(panel).getByRole('button', {
        name: `${SECURITY_RESPONSE_WORDS.seeCard}: ${securityResponseCard('sign-in-not-me').title}`,
      }),
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('data-card', 'sign-in-not-me');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: SECURITY_RESPONSE_WORDS.close,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
    await user.click(button);
    expect(await screen.findByRole('dialog')).toHaveAttribute('data-card', 'wrong-password');
    await act(async () => {});
  });
});
