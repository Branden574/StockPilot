import { describe, expect, it } from 'vitest';

import { SECURITY_EVENT_CATEGORIES, SECURITY_EVENT_REASON_LABELS } from './security-events';
import { securityMapShownCategories } from './security-map';
import {
  SECURITY_RESPONSE_CARD_IDS,
  SECURITY_RESPONSE_CARD_LEVELS,
  SECURITY_RESPONSE_CARD_OF_REASON,
  SECURITY_RESPONSE_GENERAL_CARD,
  SECURITY_RESPONSE_LEVELS,
  SECURITY_RESPONSE_SIGN_IN_ALERT_CARD,
  SECURITY_RESPONSE_LEVEL_WORDS,
  SECURITY_RESPONSE_WORDS,
  securityResponseCardIdFor,
  securityResponseLevelFor,
  type SecurityResponseCardId,
} from './security-response';
import {
  SECURITY_RESPONSE_CARDS,
  SECURITY_RESPONSE_STEPS,
  SECURITY_RESPONSE_STEP_IDS,
  securityResponseCard,
  securityResponseRoutes,
  securityResponseStepShown,
  type SecurityResponseCard,
} from './security-response-cards';

/**
 * HOW TO RESPOND: the cards as data. Pinned: every reason code of the record
 * maps to exactly one card and no card is unused; every card has one level
 * from the closed list; the card text keeps the rules a test can check (no
 * limit as a number, no hidden kind's name, no emoji, never the ledger word
 * for a quantity); every step id and every card a step points to resolves;
 * the parts keep their sizes.
 */

/** Every string a card shows: its own words, its steps' words and lead-ins, and the ways to its places. */
function cardTexts(card: SecurityResponseCard): string[] {
  const steps = [...card.doNow, ...card.ifGotThrough].map(securityResponseStepShown);
  return [
    card.title,
    card.whatThisIs,
    ...card.alreadyDid,
    ...steps.flatMap((s) => [
      s.text,
      ...(s.lead ? [s.lead] : []),
      ...(s.place ? [s.place.way] : []),
    ]),
    card.cannotTell,
  ];
}

const ALL_TEXT = [
  ...SECURITY_RESPONSE_CARDS.flatMap(cardTexts),
  ...Object.values(SECURITY_RESPONSE_STEPS).flatMap((s) => [
    s.text,
    ...(s.place ? [s.place.way] : []),
  ]),
  ...Object.values(SECURITY_RESPONSE_LEVEL_WORDS),
  // A word made from a value is read with a placeholder in the value's place, so only its own words are checked.
  ...Object.values(SECURITY_RESPONSE_WORDS).map((w) =>
    typeof w === 'function' ? (w as unknown as (x: string) => string)('x') : w,
  ),
];

const RECORD_REASONS = Object.keys(SECURITY_EVENT_REASON_LABELS).sort();

describe('every reason code of the record has exactly one card', () => {
  it('the record holds the 46 reasons the content draft was written for', () => {
    expect(RECORD_REASONS).toHaveLength(46);
  });

  it('the map from reason to card holds every reason of the record, and nothing else', () => {
    expect(Object.keys(SECURITY_RESPONSE_CARD_OF_REASON).sort()).toEqual(RECORD_REASONS);
  });

  it("each card's own list of reasons is exactly the reasons the map sends to it", () => {
    for (const card of SECURITY_RESPONSE_CARDS) {
      const mapped = RECORD_REASONS.filter((r) => SECURITY_RESPONSE_CARD_OF_REASON[r] === card.id);
      expect([...card.reasons].sort(), card.id).toEqual(mapped);
    }
  });

  it('no reason is on two cards', () => {
    const seen = new Map<string, string>();
    for (const card of SECURITY_RESPONSE_CARDS) {
      for (const reason of card.reasons) {
        expect(seen.get(reason), `${reason} on ${card.id} and ${seen.get(reason)}`).toBeUndefined();
        seen.set(reason, card.id);
      }
    }
    expect([...seen.keys()].sort()).toEqual(RECORD_REASONS);
  });

  it('no card is unused, and the card list and the id list are the same, in order', () => {
    expect(SECURITY_RESPONSE_CARDS.map((c) => c.id)).toEqual([...SECURITY_RESPONSE_CARD_IDS]);
    const used = new Set(Object.values(SECURITY_RESPONSE_CARD_OF_REASON));
    for (const id of SECURITY_RESPONSE_CARD_IDS) expect(used.has(id), id).toBe(true);
  });

  it('a reason this build does not know has no card and no level', () => {
    for (const r of ['made_up_reason', '', 'toString', '__proto__', 42, null, undefined]) {
      expect(securityResponseCardIdFor(r)).toBeNull();
      expect(securityResponseLevelFor(r)).toBeNull();
    }
    expect(securityResponseCardIdFor('wrong_password')).toBe('wrong-password');
    expect(securityResponseCardIdFor('isbn_lookup_paused')).toBe('public-forms-paused');
  });

  it('a card is found by its id, and an id with no card throws', () => {
    expect(securityResponseCard('probe-scan').title).toBe(
      'Request for a path this site never serves',
    );
    expect(() => securityResponseCard('nope' as SecurityResponseCardId)).toThrow();
  });
});

describe('the urgency levels', () => {
  it('the closed list of three, in order, each with its words', () => {
    expect(SECURITY_RESPONSE_LEVELS).toEqual(['act_now', 'look_today', 'stopped']);
    expect(SECURITY_RESPONSE_LEVEL_WORDS).toEqual({
      act_now: 'Act now',
      look_today: 'Look today',
      stopped: 'Stopped: nothing to do',
    });
  });

  it('every card has exactly one level, and no level names a card that does not exist', () => {
    expect(Object.keys(SECURITY_RESPONSE_CARD_LEVELS).sort()).toEqual(
      [...SECURITY_RESPONSE_CARD_IDS].sort(),
    );
    for (const level of Object.values(SECURITY_RESPONSE_CARD_LEVELS)) {
      expect(SECURITY_RESPONSE_LEVELS).toContain(level);
    }
  });

  it("the coordinator's assignment, card by card", () => {
    const by = (level: string) =>
      Object.entries(SECURITY_RESPONSE_CARD_LEVELS)
        .filter(([, l]) => l === level)
        .map(([id]) => id)
        .sort();
    expect(by('act_now')).toEqual(
      ['passkey-counter-went-back', 'passkey-unexplained-sign-in', 'sign-in-not-me'].sort(),
    );
    expect(by('look_today')).toEqual(
      [
        'counts-past-limit',
        'passkey-wrong-site',
        'repeated-wrong-guesses',
        'second-step-paused',
        'sign-in-alerts-held',
        'sign-in-log-unmatched',
        'sign-in-log-unusual',
        'sign-in-new-country',
        'wrong-code',
        'wrong-recovery-code',
      ].sort(),
    );
    expect(by('stopped')).toHaveLength(11);
  });

  it("a reason's level is its card's", () => {
    expect(securityResponseLevelFor('sign_in_not_me')).toBe('act_now');
    expect(securityResponseLevelFor('sign_in_new_country')).toBe('look_today');
    expect(securityResponseLevelFor('env_file')).toBe('stopped');
  });
});

describe('the general card of each kind', () => {
  it('every kind the map shows has one, and it is a real card', () => {
    for (const category of securityMapShownCategories()) {
      const id = SECURITY_RESPONSE_GENERAL_CARD[category];
      expect(id, category).not.toBeNull();
      expect(SECURITY_RESPONSE_CARD_IDS).toContain(id);
    }
  });

  it('the choice, kind by kind; a kind nothing records has none', () => {
    expect(Object.keys(SECURITY_RESPONSE_GENERAL_CARD)).toEqual([...SECURITY_EVENT_CATEGORIES]);
    expect(SECURITY_RESPONSE_GENERAL_CARD).toEqual({
      password_guessing: 'repeated-wrong-guesses',
      exploit: 'probe-scan',
      bots: 'public-forms-paused',
      phishing: 'sign-in-new-country',
      malware: null,
    });
  });

  it("the legend's flagged sign-in alert item opens their kind's general card", () => {
    expect(SECURITY_RESPONSE_SIGN_IN_ALERT_CARD).toBe(SECURITY_RESPONSE_GENERAL_CARD.phishing);
    expect(SECURITY_RESPONSE_CARD_OF_REASON.sign_in_new_country).toBe(
      SECURITY_RESPONSE_SIGN_IN_ALERT_CARD,
    );
  });
});

describe('the card text keeps the rules', () => {
  it('no number at all, so no limit is given as one (review rule 1)', () => {
    for (const text of ALL_TEXT) expect(text, text).not.toMatch(/\d/);
    for (const { place } of securityResponseRoutes()) expect(place.route).not.toMatch(/\d/);
  });

  it("no hidden kind's name: never Phishing or Malware, in any case", () => {
    for (const text of ALL_TEXT) expect(text, text).not.toMatch(/phishing|malware/i);
    for (const card of SECURITY_RESPONSE_CARDS) expect(card.id).not.toMatch(/phishing|malware/i);
  });

  it('no emoji or other pictographs', () => {
    for (const text of ALL_TEXT) {
      expect(text, text).not.toMatch(/[\p{Extended_Pictographic}\u{1F000}-\u{1FAFF}☀-➿]/u);
    }
  });

  it('never "book" for a quantity: the word is not used at all', () => {
    for (const text of ALL_TEXT) expect(text, text).not.toMatch(/\bbook/i);
  });

  it('the review\'s counted words are gone: "six" kinds and "probably right"', () => {
    for (const text of ALL_TEXT) {
      expect(text, text).not.toMatch(/\bsix\b|probably right|five or more/i);
    }
  });

  it('the console\'s own labels: "Users" for the members tab, "Act as this org" for the tool', () => {
    for (const text of ALL_TEXT) {
      expect(text, text).not.toMatch(/\bMembers tab\b|\bTeam tab\b/);
      if (/Act as/.test(text)) expect(text, text).toMatch(/Act as this org/);
    }
  });
});

describe('the parts keep their sizes', () => {
  it('"What this is" is two sentences', () => {
    for (const card of SECURITY_RESPONSE_CARDS) {
      const ends = card.whatThisIs.match(/[.!?](?=\s|$)/g) ?? [];
      expect(ends.length, `${card.id}: ${card.whatThisIs}`).toBe(2);
    }
  });

  it('at least one "already did" line; at most four steps now; one to five if one got through', () => {
    for (const card of SECURITY_RESPONSE_CARDS) {
      expect(card.alreadyDid.length, card.id).toBeGreaterThan(0);
      expect(card.doNow.length, card.id).toBeLessThanOrEqual(4);
      expect(card.ifGotThrough.length, card.id).toBeGreaterThan(0);
      expect(card.ifGotThrough.length, card.id).toBeLessThanOrEqual(5);
    }
  });

  it('a five-step list keeps the order: stop access, then the password, then the looks, then tell', () => {
    for (const card of SECURITY_RESPONSE_CARDS) {
      const ids = card.ifGotThrough.map((i) => securityResponseStepShown(i).id);
      if (ids.length < 5) continue;
      const at = (id: string) => ids.indexOf(id as never);
      expect(ids[ids.length - 1], card.id).toBe('tell-the-owner');
      if (at('stop-access') >= 0 && at('send-reset') >= 0) {
        expect(at('stop-access'), card.id).toBeLessThan(at('send-reset'));
      }
      if (at('send-reset') >= 0 && at('look-at-audit') >= 0) {
        expect(at('send-reset'), card.id).toBeLessThan(at('look-at-audit'));
      }
    }
  });
});

describe('every step resolves', () => {
  it('every shared step id names a shared step, and every shared step is used', () => {
    expect(Object.keys(SECURITY_RESPONSE_STEPS).sort()).toEqual(
      [...SECURITY_RESPONSE_STEP_IDS].sort(),
    );
    const used = new Set<string>();
    for (const card of SECURITY_RESPONSE_CARDS) {
      for (const item of [...card.doNow, ...card.ifGotThrough]) {
        if (item.step !== undefined) {
          expect(SECURITY_RESPONSE_STEPS[item.step], `${card.id}: ${item.step}`).toBeDefined();
          used.add(item.step);
        }
      }
    }
    expect([...used].sort()).toEqual([...SECURITY_RESPONSE_STEP_IDS].sort());
  });

  it('every card a step points to exists, and no card points to itself', () => {
    for (const card of SECURITY_RESPONSE_CARDS) {
      for (const item of [...card.doNow, ...card.ifGotThrough]) {
        const shown = securityResponseStepShown(item);
        if (shown.seeCard === null) continue;
        expect(SECURITY_RESPONSE_CARD_IDS, `${card.id} -> ${shown.seeCard}`).toContain(
          shown.seeCard,
        );
        expect(shown.seeCard, card.id).not.toBe(card.id);
      }
    }
  });

  it('a shared step is shown with its own words and the lead-in of the card', () => {
    const card = securityResponseCard('second-step-paused');
    const first = securityResponseStepShown(card.ifGotThrough[0]!);
    expect(first.id).toBe('stop-access');
    expect(first.text).toBe(SECURITY_RESPONSE_STEPS['stop-access'].text);
    expect(first.lead).toMatch(/^Reaching the second step/);
    expect(first.place?.route).toBe('/platform/orgs/<organization id>?tab=users');
    const own = securityResponseStepShown(securityResponseCard('probe-scan').ifGotThrough[0]!);
    expect(own).toEqual({
      id: null,
      lead: null,
      text: 'Nothing was served, so nothing got through from this kind of request.',
      place: null,
      seeCard: null,
    });
  });

  it("a place in the organization's own app is marked as after Act as, and only those", () => {
    for (const { card, place } of securityResponseRoutes()) {
      expect(place.afterActAs, `${card}: ${place.route}`).toBe(
        place.route.startsWith('/dashboard'),
      );
      expect(place.route, card).toMatch(/^\/(platform|dashboard)(\/|$|\?)/);
    }
  });
});
