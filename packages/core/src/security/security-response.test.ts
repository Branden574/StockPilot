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
  it('the record holds the 46 reasons the content draft was written for, and the five upload reasons of part 6', () => {
    expect(RECORD_REASONS).toHaveLength(51);
    for (const reason of [
      'upload_wrong_type',
      'upload_active_content',
      'upload_hidden_file',
      'upload_could_not_check',
      'upload_refused_in_use',
    ]) {
      expect(securityResponseCardIdFor(reason), reason).toBeTruthy();
    }
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
    const general = new Set(Object.values(SECURITY_RESPONSE_GENERAL_CARD));
    for (const id of SECURITY_RESPONSE_CARD_IDS) expect(used.has(id) || general.has(id), id).toBe(true);
    // A card that answers no reason is only ever a kind's general card.
    for (const card of SECURITY_RESPONSE_CARDS) {
      if (card.reasons.length === 0) expect(general.has(card.id), card.id).toBe(true);
    }
    expect(SECURITY_RESPONSE_CARDS.filter((c) => c.reasons.length === 0).map((c) => c.id)).toEqual([
      'upload-checks',
    ]);
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
        'upload-checks',
        'upload-not-checked',
        'upload-refused-in-use',
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
    expect(by('stopped')).toHaveLength(12);
    expect(SECURITY_RESPONSE_CARD_LEVELS['upload-refused']).toBe('stopped');
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

  it('the choice, kind by kind; malware has a card of its own that describes the kind (part 6)', () => {
    expect(Object.keys(SECURITY_RESPONSE_GENERAL_CARD)).toEqual([...SECURITY_EVENT_CATEGORIES]);
    expect(SECURITY_RESPONSE_GENERAL_CARD).toEqual({
      password_guessing: 'repeated-wrong-guesses',
      exploit: 'probe-scan',
      bots: 'public-forms-paused',
      phishing: 'sign-in-new-country',
      malware: 'upload-checks',
    });
  });

  it("the legend's flagged sign-in alert item opens their kind's general card", () => {
    expect(SECURITY_RESPONSE_SIGN_IN_ALERT_CARD).toBe(SECURITY_RESPONSE_GENERAL_CARD.phishing);
    expect(SECURITY_RESPONSE_CARD_OF_REASON.sign_in_new_country).toBe(
      SECURITY_RESPONSE_SIGN_IN_ALERT_CARD,
    );
  });
});

describe('the upload cards (part 6)', () => {
  const ownText = (card: SecurityResponseCard): string =>
    cardTexts(card).join(' ');

  it('the three reasons of a refused file go to the refused-file card, which is Stopped', () => {
    for (const reason of ['upload_wrong_type', 'upload_active_content', 'upload_hidden_file']) {
      expect(securityResponseCardIdFor(reason), reason).toBe('upload-refused');
      expect(securityResponseLevelFor(reason), reason).toBe('stopped');
    }
  });

  it('a file that could not be checked has its own card, Look today, never "Stopped: nothing to do"', () => {
    expect(securityResponseCardIdFor('upload_could_not_check')).toBe('upload-not-checked');
    expect(securityResponseLevelFor('upload_could_not_check')).toBe('look_today');
    const card = securityResponseCard('upload-not-checked');
    expect(card.reasons).toEqual(['upload_could_not_check']);
    const steps = card.doNow.map(securityResponseStepShown);
    // Its steps: refused because the checks could not finish; look for more
    // from the same organization in the list; a run is worth a look, because
    // a file built to wear out a checker is itself a sign.
    expect(steps[0]!.text).toMatch(/refused because the checks could not finish/);
    expect(steps[1]!.text).toMatch(/events list for more of these from the same organization/);
    expect(steps[1]!.place?.route).toBe('/platform/security');
    expect(steps[2]!.text).toMatch(/A run of them is worth a look: a file built to wear out a checker is itself a sign/);
    // Not one step is "Nothing: this was stopped."
    for (const s of steps) expect(s.text).not.toMatch(/^Nothing/);
  });

  it('the could-not-check card never promises the file was hostile', () => {
    const card = securityResponseCard('upload-not-checked');
    // Everything but "What this cannot tell you", which says it cannot tell.
    const text = ownText({ ...card, cannotTell: '' });
    expect(text).not.toMatch(/\b(was|is) (harmful|hostile|malicious|dangerous|an attack)\b/i);
    expect(text).not.toMatch(/someone (sent|is sending) .* on purpose/i);
    expect(card.whatThisIs).toMatch(/An honest file can do this/);
    expect(card.cannotTell).toMatch(/does not say whether the file was harmful/);
  });

  it("the kind's general card describes the kind and claims no outcome", () => {
    expect(SECURITY_RESPONSE_GENERAL_CARD.malware).toBe('upload-checks');
    const card = securityResponseCard('upload-checks');
    expect(card.title).toBe('A file the upload checks refused or could not check');
    expect(card.reasons).toEqual([]);
    // Its first part says what the console's word means here, and what it does not.
    expect(card.whatThisIs).toMatch(
      /^Malware here means a file the upload checks refused or could not finish checking, not a confirmed virus\./,
    );
    // No outcome an entry may not have: nothing deleted, blocked, stopped or "not used".
    for (const line of card.alreadyDid) {
      expect(line, line).not.toMatch(/delet|remov|blocked|stopped|not used|not attached|let through/i);
    }
    expect(card.doNow.map(securityResponseStepShown).map((s) => s.text).join(' ')).not.toMatch(
      /^Nothing/,
    );
    // The outcome sentences live on the cards of the reasons.
    for (const id of ['upload-refused', 'upload-not-checked'] as const) {
      const did = securityResponseCard(id).alreadyDid.join(' ');
      expect(did, id).toMatch(/^Blocked: the file was refused/);
      expect(did, id).toMatch(/A copy that had already reached storage was deleted, unless/);
    }
  });

  it('the outcome sentences claim only what holds on every path that records one (part 6 review)', () => {
    for (const id of ['upload-checks', 'upload-refused', 'upload-not-checked', 'upload-refused-in-use'] as const) {
      const did = securityResponseCard(id).alreadyDid.join(' ');
      // No card says a refused file was not shown or passed on: a path may keep it (an earlier record still uses it).
      expect(did, id).not.toMatch(/\bshown\b|passed on/);
      // The record also keeps where the request came from.
      expect(did, id).toMatch(/The record keeps the kind of refusal, the organization when there is one, the place it came from and the time/);
    }
    // A name or a stated type can pick the kind expected (the ISBN and PO import paths), never widen it.
    expect(securityResponseCard('upload-refused').alreadyDid.join(' ')).toMatch(
      /Where a name or a stated type picks the kind of file expected, it can only narrow what the bytes must be\./,
    );
  });

  it('a refused file an earlier record still uses has its own card, which never says it was not attached (review round 2, F1)', () => {
    expect(securityResponseCardIdFor('upload_refused_in_use')).toBe('upload-refused-in-use');
    expect(securityResponseLevelFor('upload_refused_in_use')).toBe('look_today');
    const card = securityResponseCard('upload-refused-in-use');
    const did = card.alreadyDid.join(' ');
    expect(did).not.toMatch(/not attached|deleted|Blocked/);
    expect(did).toMatch(/^Flagged, not stopped: this upload was refused/);
    expect(did).toMatch(/the file itself was kept, because the earlier record still uses it/);
    expect(card.whatThisIs).toMatch(/still points at that same file/);
    expect(card.doNow.map(securityResponseStepShown).map((s) => s.id)).toContain('tell-the-owner');
    expect(card.ifGotThrough.map(securityResponseStepShown).map((s) => s.id)).toContain('look-at-audit');
  });

  it('no upload card claims every file is checked', () => {
    for (const id of ['upload-checks', 'upload-refused', 'upload-not-checked', 'upload-refused-in-use'] as const) {
      expect(ownText(securityResponseCard(id)), id).not.toMatch(/\bevery file\b|\ball files\b/i);
    }
  });
});

describe('the card text keeps the rules', () => {
  it('no number at all, so no limit is given as one (review rule 1)', () => {
    for (const text of ALL_TEXT) expect(text, text).not.toMatch(/\d/);
    for (const { place } of securityResponseRoutes()) expect(place.route).not.toMatch(/\d/);
  });

  it("no hidden kind's name: never Phishing, in any case (Malware is shown since part 6)", () => {
    for (const text of ALL_TEXT) expect(text, text).not.toMatch(/phishing/i);
    // The console's word for the shown kind is said once, in the kind's own card, with its meaning.
    expect(ALL_TEXT.filter((t) => /malware/i.test(t))).toEqual([
      securityResponseCard('upload-checks').whatThisIs,
    ]);
    for (const card of SECURITY_RESPONSE_CARDS) expect(card.id).not.toMatch(/phishing/i);
  });

  it('the upload cards claim no virus scan: our own checks read how a file is built (part 6)', () => {
    // "Malware" only where the general card says what the word means here.
    const MEANING = securityResponseCard('upload-checks').whatThisIs;
    for (const id of ['upload-checks', 'upload-refused', 'upload-not-checked', 'upload-refused-in-use'] as const) {
      for (const text of cardTexts(securityResponseCard(id))) {
        expect(text, `${id}: ${text}`).not.toMatch(/antivirus|virus scan|infected|quarantin|\bheld\b/i);
        if (text !== MEANING) expect(text, `${id}: ${text}`).not.toMatch(/malware/i);
      }
      expect(securityResponseCard(id).cannotTell, id).toMatch(/hold no list of known viruses/);
    }
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
