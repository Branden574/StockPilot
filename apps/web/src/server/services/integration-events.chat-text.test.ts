import { describe, expect, it } from 'vitest';

import { buildRequest, describeEvent, INTEGRATION_EVENT_TYPES } from './integration-events';

/**
 * Slack and Teams alert cards show an event's text as text (docket S56).
 * Every text field of every event type goes through one rule
 * (lib/chat-text.ts): escaped for its channel, on one line, at most 300
 * characters. The generic webhook's body is the event's data as it was sent.
 */

const endpoint = (type: 'slack' | 'teams' | 'webhook') => ({
  id: 'ep-1',
  organization_id: 'org-1',
  type,
  url: 'https://example.com/hook',
  secret: null,
});

const envelope = (event: string, data: Record<string, unknown>) => ({
  id: 'd-1',
  event,
  organization_id: 'org-1',
  created_at: '2026-06-08T00:00:00.000Z',
  data,
});

/** The chat text a card of `event` with `data` posts to `type`. */
function cardText(type: 'slack' | 'teams', event: string, data: Record<string, unknown>): string {
  const { body } = buildRequest(endpoint(type), event, envelope(event, data));
  const parsed = JSON.parse(body) as { text: string };
  expect(Object.keys(parsed)).toEqual(['text']);
  return parsed.text;
}

/** The card's second line: what describeEvent wrote. */
const summaryOf = (text: string) => text.slice(text.indexOf('\n') + 1);

/** Data whose every key answers `value`: every text field a card reads. */
const everyField = (value: string) =>
  new Proxy({} as Record<string, unknown>, { get: () => value });

const EVERY_TYPE = [...INTEGRATION_EVENT_TYPES, 'test.ping', 'something.unknown'];
/** Card types whose summary is fixed words only. */
const NO_FIELD = new Set(['test.ping']);

const SLACK_TEXT = 'Size <10> & <https://example.com|Open>';
const TEAMS_TEXT = '[Open](https://example.com) <a href="https://example.com">x</a>';

describe('every card type shows its fields as text', () => {
  it.each(EVERY_TYPE)('Slack, %s', (event) => {
    const text = cardText('slack', event, everyField(SLACK_TEXT));
    expect(text).not.toMatch(/[<>]/);
    if (event === 'something.unknown') {
      expect(summaryOf(text)).toBe(event);
    } else if (!NO_FIELD.has(event)) {
      expect(text).toContain('Size &lt;10&gt; &amp; &lt;https://example.com|Open&gt;');
    }
    // The title is fixed: bold asterisks around it, then one line break.
    expect(text).toMatch(/^\*[^*\n]+\*\n[^\n]+$/);
  });

  it.each(EVERY_TYPE)('Teams, %s', (event) => {
    const text = cardText('teams', event, everyField(TEAMS_TEXT));
    expect(text).not.toMatch(/[<>]/);
    // No square bracket without a backslash before it.
    expect(text).not.toMatch(/(^|[^\\])[[\]]/);
    if (!NO_FIELD.has(event) && event !== 'something.unknown') {
      expect(text).toContain('\\[Open\\](https://example.com) &lt;a href=');
    }
  });

  it('an unknown event type is shown escaped as well', () => {
    expect(summaryOf(cardText('slack', 'x.<y>&z', {}))).toBe('x.&lt;y&gt;&amp;z');
  });
});

describe('field by field', () => {
  const FIELDS: Array<[string, string]> = [
    ['order.denied', 'reason'],
    ['return.denied', 'reason'],
    ['security.api_key_created', 'name'],
    ['security.api_key_revoked', 'name'],
    ['order.completed', 'signerName'],
    ['stock.low', 'name'],
    ['stock.low', 'sku'],
    ['order.created', 'requester'],
    ['po.created', 'poNumber'],
    ['po.updated', 'poNumber'],
    ['po.cancelled', 'poNumber'],
    ['security.new_device_login', 'device'],
  ];

  it.each(FIELDS)('%s %s is escaped for Slack and for Teams', (event, field) => {
    const slack = cardText('slack', event, { [field]: SLACK_TEXT });
    expect(slack).toContain('Size &lt;10&gt; &amp; &lt;https://example.com|Open&gt;');
    expect(slack).not.toMatch(/[<>]/);

    const teams = cardText('teams', event, { [field]: TEAMS_TEXT });
    expect(teams).toContain(
      '\\[Open\\](https://example.com) &lt;a href="https://example.com"&gt;x&lt;/a&gt;',
    );
    expect(teams).not.toMatch(/[<>]/);
  });
});

describe('the rule, seen in a card', () => {
  it('a field of several lines is shown on one line: the only line break follows the title', () => {
    const text = cardText('slack', 'order.denied', {
      orderNumber: 'ORD-9',
      reason: 'Late\nsecond line\r\nthird',
    });
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('was denied: Late second line third.');
  });

  it('characters that cannot be seen are removed', () => {
    expect(cardText('slack', 'order.denied', { reason: 'abc\u202Edef' })).toContain(': abcdef.');
  });

  it('a long field is cut at 300 characters with an ellipsis, never inside an entity', () => {
    const text = cardText('slack', 'return.denied', {
      returnNumber: 'RMA-1',
      reason: '<'.repeat(1000),
    });
    expect(summaryOf(text)).toBe(`Return RMA-1 was denied: ${'&lt;'.repeat(300)}….`);
  });

  it('a typed entity is not read as one', () => {
    expect(cardText('slack', 'order.created', { requester: 'A &amp; B' })).toContain(
      'by A &amp;amp; B.',
    );
  });

  it('ordinary text stays readable', () => {
    expect(cardText('slack', 'stock.low', { name: 'Bolts & Nuts <10mm>', quantity: 2 })).toContain(
      'Bolts &amp; Nuts &lt;10mm&gt; is at 2',
    );
    expect(
      cardText('teams', 'security.api_key_created', {
        name: 'Widget (blue) [B-1] sk_live_abc1 #10 *bold*',
      }),
    ).toContain('"Widget (blue) \\[B-1\\] sk_live_abc1 #10 *bold*"');
  });

  it('Teams: a typed backslash is escaped too', () => {
    expect(
      cardText('teams', 'order.completed', { signerName: '\\[Open](https://example.com)' }),
    ).toContain('by \\\\\\[Open\\](https://example.com).');
  });

  it('a field with nothing left to show falls back to the card’s own words', () => {
    expect(cardText('slack', 'stock.low', { name: '\u202E\u200B ', quantity: 1 })).toContain(
      'An item is at 1',
    );
    expect(cardText('slack', 'security.new_device_login', { device: ' \n ' })).not.toContain('(');
  });
});

describe('what does not change', () => {
  it('the generic webhook body carries the data as it was sent', () => {
    const data = {
      orderNumber: 'ORD-9',
      reason: `${SLACK_TEXT}\n${TEAMS_TEXT} ${'x'.repeat(500)}`,
    };
    const { body } = buildRequest(
      endpoint('webhook'),
      'order.denied',
      envelope('order.denied', data),
    );
    expect(JSON.parse(body)).toEqual(envelope('order.denied', data));
  });

  it('describeEvent without a channel escapes nothing', () => {
    expect(
      describeEvent('order.created', { orderNumber: 'ORD-9', requester: 'R & D <team>' }).summary,
    ).toBe('Order ORD-9 was created by R & D <team>.');
  });
});
