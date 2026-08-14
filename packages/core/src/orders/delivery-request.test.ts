/**
 * Tests for what the CORE MOVE actually changed.
 *
 * The builder's message content is pinned exhaustively by the four web suites
 * (150 + 51 + 23 + 10), which run against the web re-export shim and passed
 * unedited through this move — plus a byte-for-byte golden diff over an
 * 11-line order, every rung of the ladder, both transports and the clipboard
 * text. Repeating that here would add tautologies, not coverage.
 *
 * What is genuinely NEW is the recipient boundary: the builder no longer reads
 * a constant, it takes `recipients` as input, and it validates them. That is
 * the seam a per-org configuration will eventually feed, and it is the seam
 * through which the mandatory CC could be lost. These tests exist for that.
 */
import { describe, expect, it } from 'vitest';

import {
  DELIVERY_REQUEST_EMAIL,
  DELIVERY_REQUEST_EMAIL_NAMES,
  DELIVERY_REQUEST_RECIPIENTS,
} from './delivery-request-recipients';
import { DRAFT_URL_LIMIT } from '../email/outlook-compose';

import {
  buildDeliveryRequestClipboardText,
  buildDeliveryRequestDraft,
  buildDeliveryRequestMailtoUrl,
  buildDeliveryRequestOutlookMobileUrl,
  buildDeliveryRequestOutlookUrl,
  deliveryRequestRecipients,
  prepareDeliveryRequest,
  type DeliveryRequestInput,
  type DeliveryRequestRecipients,
} from './delivery-request';

const L4L: DeliveryRequestRecipients = DELIVERY_REQUEST_RECIPIENTS;

/**
 * A recipients value that DID NOT come from `deliveryRequestRecipients`.
 *
 * `DeliveryRequestRecipients` is branded, so this cast is the only way to get a
 * raw shape past the type checker — which is exactly why the tests below still
 * matter. The brand stops a NEW CALL SITE from typing a wrong address by hand;
 * it cannot stop a cast, and it says nothing about an address that arrives as
 * data. `buildDeliveryRequestDraft` therefore keeps its own runtime guard, and
 * these cases prove it by coming in through the one door the brand does not
 * cover.
 */
function unbranded(value: { to: string; cc: string }): DeliveryRequestRecipients {
  return value as unknown as DeliveryRequestRecipients;
}

function makeInput(overrides: Partial<DeliveryRequestInput> = {}): DeliveryRequestInput {
  return {
    recipients: L4L,
    orderId: 'b3f1c2d4-1111-2222-3333-444455556666',
    orderNumber: 49,
    fulfillmentType: 'delivery',
    warehouseName: 'DC4',
    destination: { id: 'ch-1', name: 'CVW Clovis', code: 'CVW-CLO', address: null },
    requestedFor: 'Marissa Delgado',
    requesterEmail: 'mdelgado@learn4life.org',
    neededByLocal: '2026-08-18T09:00',
    orgTimezone: 'America/Los_Angeles',
    notes: 'Please stage these by Friday.',
    lines: [{ itemId: 'i-1', quantity: 5 }],
    itemMap: new Map([['i-1', { name: 'L4L Water Bottle', sku: 'GEN-BOTL' }]]),
    ...overrides,
  };
}

describe('recipients are INPUT, not a constant the builder reaches for', () => {
  it('a second org gets ITS OWN addresses — the L4L mailbox appears nowhere', () => {
    /*
     * THE TENANCY TEST. Before the move the builder read
     * DELIVERY_REQUEST_EMAIL directly, so every org's delivery request would
     * have gone to Learn4Life's intake. A builder that still did that would
     * fail here on all four assertions, not just one.
     */
    const draft = buildDeliveryRequestDraft(
      makeInput({
        recipients: deliveryRequestRecipients({
          to: 'intake@othercorp.test',
          cc: 'ops@othercorp.test',
        }),
        // Neutral requester too: the L4L address must be absent because
        // nothing ROUTES there, not merely because no field mentions it. A
        // requester email is legitimate body content and would mask the point.
        requesterEmail: 'someone@othercorp.test',
      }),
    );

    expect(draft.to).toBe('intake@othercorp.test');
    expect(draft.cc).toBe('ops@othercorp.test');

    const url = buildDeliveryRequestOutlookUrl(draft);
    expect(url).toContain(encodeURIComponent(encodeURIComponent('ops@othercorp.test')));
    expect(url).not.toContain('learn4life');
    expect(url).not.toContain('cvwest');
    // The clipboard instructions are what an employee follows by hand when
    // both links fail — they must name the same two mailboxes.
    expect(buildDeliveryRequestClipboardText(draft)).toContain('TO: intake@othercorp.test');
    expect(buildDeliveryRequestClipboardText(draft)).toContain('CC: ops@othercorp.test');
  });

  it('carries the CC into every transport, not just the Outlook one', () => {
    // The CC is the acceptance gate. A transport that quietly drops it is the
    // failure this whole feature exists to prevent, so each is asserted
    // separately rather than trusting one to stand for the others.
    const draft = buildDeliveryRequestDraft(makeInput());

    expect(buildDeliveryRequestOutlookUrl(draft)).toContain(
      encodeURIComponent(encodeURIComponent(DELIVERY_REQUEST_EMAIL.cc)),
    );
    expect(buildDeliveryRequestMailtoUrl(draft)).toContain(
      `cc=${encodeURIComponent(DELIVERY_REQUEST_EMAIL.cc)}`,
    );
    expect(buildDeliveryRequestClipboardText(draft)).toContain(`CC: ${DELIVERY_REQUEST_EMAIL.cc}`);
  });

  it('puts the display-name chips on the OWA url ONLY', () => {
    // The name-addr in path position is a tenant-verified OWA parser
    // extension. mailto: and the clipboard are different, unverified parsers
    // and stay bare-address; guessing wrong there costs a silent CC drop.
    const draft = buildDeliveryRequestDraft(makeInput());

    expect(buildDeliveryRequestOutlookUrl(draft)).toContain(
      encodeURIComponent(encodeURIComponent('Fresno Warehouse DC4')),
    );
    expect(buildDeliveryRequestMailtoUrl(draft)).not.toContain('Fresno');
    expect(buildDeliveryRequestMailtoUrl(draft)).not.toContain('Andrew');
    expect(buildDeliveryRequestClipboardText(draft)).not.toContain('Fresno');
    expect(buildDeliveryRequestClipboardText(draft)).not.toContain('Andrew');
  });

  it('a draft built with no display names still routes to both addresses', () => {
    // Chips are cosmetic; routing is not. Omitting them must cost the chip and
    // nothing else.
    const draft = buildDeliveryRequestDraft(
      makeInput({
        recipients: deliveryRequestRecipients({
          to: DELIVERY_REQUEST_EMAIL.to,
          cc: DELIVERY_REQUEST_EMAIL.cc,
        }),
      }),
    );
    const url = buildDeliveryRequestOutlookUrl(draft);

    expect(url).not.toContain(encodeURIComponent(encodeURIComponent('Fresno Warehouse DC4')));
    expect(url).toContain(encodeURIComponent(encodeURIComponent(DELIVERY_REQUEST_EMAIL.to)));
    expect(url).toContain(encodeURIComponent(encodeURIComponent(DELIVERY_REQUEST_EMAIL.cc)));
  });
});

describe('the builder REFUSES a recipient it cannot route', () => {
  /*
   * Every value below is one that would fail SILENTLY if it were allowed
   * through: a comma or semicolon splits one recipient into two and the second
   * half — the mandatory CC — vanishes; a name-addr in the address position
   * confuses a parser into dropping the rest; an empty string composes mail to
   * nowhere. A throw at draft time is the last moment the failure is visible,
   * because nothing downstream can tell a delivered message from a misrouted
   * one.
   *
   * With today's compile-time literals none of these can occur. They are the
   * guard for the per-org configuration that `delivery-request-recipients.ts`
   * records as deferred.
   */
  const BAD = [
    ['empty', ''],
    ['whitespace only', '   '],
    ['a comma-joined second address', 'arosas@cvwest.org,evil@attacker.test'],
    ['a semicolon-joined second address', 'arosas@cvwest.org;evil@attacker.test'],
    ['a space-joined second address', 'arosas@cvwest.org evil@attacker.test'],
    ['a name-addr', 'Andrew Rosas <arosas@cvwest.org>'],
    ['no domain dot', 'arosas@localhost'],
    ['no at sign', 'arosas.cvwest.org'],
    ['two at signs', 'a@b@cvwest.org'],
    ['a newline', 'arosas@cvwest.org\nBcc: evil@attacker.test'],
  ] as const;

  for (const [label, value] of BAD) {
    it(`throws when the CC is ${label}`, () => {
      expect(() =>
        buildDeliveryRequestDraft(
          makeInput({ recipients: unbranded({ to: DELIVERY_REQUEST_EMAIL.to, cc: value }) }),
        ),
      ).toThrow(/recipient "cc" must be exactly one plain email address/);
    });

    it(`throws when the TO is ${label}`, () => {
      expect(() =>
        buildDeliveryRequestDraft(
          makeInput({ recipients: unbranded({ to: value, cc: DELIVERY_REQUEST_EMAIL.cc }) }),
        ),
      ).toThrow(/recipient "to" must be exactly one plain email address/);
    });
  }

  it('refuses through prepareDeliveryRequest too — not just the raw builder', () => {
    // prepareDeliveryRequest is what both surfaces actually call. A guard that
    // only covered the lower-level entry point would be a guard nobody passes
    // through.
    expect(() =>
      prepareDeliveryRequest(
        makeInput({
          recipients: unbranded({
            to: DELIVERY_REQUEST_EMAIL.to,
            cc: 'arosas@cvwest.org,evil@attacker.test',
          }),
        }),
      ),
    ).toThrow(/recipient "cc" must be exactly one plain email address/);
  });

  it('accepts the real production pair', () => {
    // The negative cases above are worthless without this: a guard that
    // rejected everything would satisfy all of them.
    expect(() => buildDeliveryRequestDraft(makeInput())).not.toThrow();
    const draft = buildDeliveryRequestDraft(makeInput());
    expect(draft.to).toBe('dc4@learn4life.org');
    expect(draft.cc).toBe('arosas@cvwest.org');
  });
});

/**
 * THE NATIVE TRANSPORT, added for the phone.
 *
 * `outlookMobileUrl` is a THIRD composition of the same prepared draft. The web
 * suites cannot cover it — they never read the field — and the two things that
 * can go wrong with it are both silent: composing it from a different rung of
 * the ladder than the one that was measured, and dropping the CC that the whole
 * workflow depends on.
 */
describe('outlookMobileUrl: the native transport composes the CHOSEN draft', () => {
  /** Decodes an opaque-scheme deep link down to one query parameter. */
  function paramOf(url: string, key: string): string | undefined {
    const q = url.indexOf('?');
    if (q === -1) return undefined;
    for (const pair of url.slice(q + 1).split('&')) {
      const eq = pair.indexOf('=');
      if (pair.slice(0, eq) === key) return decodeURIComponent(pair.slice(eq + 1));
    }
    return undefined;
  }

  /** Enough item rows that the full body cannot fit a compose link, so
   *  prepareDeliveryRequest walks its ladder and returns a condensed draft. */
  function laddered(): DeliveryRequestInput {
    const lines = Array.from({ length: 11 }, (_, i) => ({ itemId: `i-${i}`, quantity: (i + 1) * 3 }));
    return makeInput({
      lines,
      itemMap: new Map(
        lines.map((l, i) => [
          l.itemId,
          { name: `Classroom Supply Kit ${i + 1} — Grade ${i + 1} Standard Issue`, sku: `KIT-${i}` },
        ]),
      ),
    });
  }

  it('uses the ms-outlook: scheme, not the https URL a phone would hand to a browser', () => {
    const prepared = prepareDeliveryRequest(makeInput());
    expect(prepared.outlookMobileUrl.startsWith('ms-outlook://compose?')).toBe(true);
    expect(prepared.outlookMobileUrl.startsWith('http')).toBe(false);
    // And it is genuinely a THIRD url, not an alias of the web one.
    expect(prepared.outlookMobileUrl).not.toBe(prepared.outlookUrl);
  });

  it('carries the mandatory CC as a bare address on both the full and condensed rungs', () => {
    for (const input of [makeInput(), laddered()]) {
      const prepared = prepareDeliveryRequest(input);
      expect(paramOf(prepared.outlookMobileUrl, 'cc')).toBe(DELIVERY_REQUEST_EMAIL.cc);
      expect(paramOf(prepared.outlookMobileUrl, 'to')).toBe(DELIVERY_REQUEST_EMAIL.to);
    }
    // Bare, not the name-addr chip the verified OWA parser gets — the native
    // parser is unverified, and a mis-split name-addr costs the CC.
    expect(paramOf(prepareDeliveryRequest(makeInput()).outlookMobileUrl, 'cc')).not.toContain('<');
  });

  it('THE LADDER: the native url carries the SHORTENED body, never the full one', () => {
    // The failure this exists for: composing the native url from `full` while
    // the measured web url carried `best.draft` would send two different
    // messages depending on which app the phone happens to have installed —
    // and the native one would be the one silently truncated in transit.
    const prepared = prepareDeliveryRequest(laddered());
    expect(prepared.draft.condensed).toBe(true);
    expect(prepared.draft.listedLineCount).toBeLessThan(prepared.draft.lineCount);

    const body = paramOf(prepared.outlookMobileUrl, 'body');
    expect(body).toBe(prepared.draft.body);

    // The hard version of the same claim, independent of `draft`: the full
    // body is strictly longer, and it is NOT what went on the wire.
    const full = buildDeliveryRequestDraft(laddered());
    expect(full.body.length).toBeGreaterThan(prepared.draft.body.length);
    expect(body).not.toBe(full.body);
    expect(paramOf(prepared.outlookMobileUrl, 'subject')).toBe(prepared.draft.subject);
  });

  it('is shorter than the measured web url for identical input, which is why it is exempt from linkFits', () => {
    // Under the DEFAULT (web) transport, prepareDeliveryRequest measures only
    // outlookUrl and mailtoUrl. That is sound ONLY while this inequality holds;
    // if it ever inverts, a draft could pass linkFits and still truncate on the
    // native transport.
    for (const input of [makeInput(), laddered()]) {
      const prepared = prepareDeliveryRequest(input);
      expect(prepared.outlookMobileUrl.length).toBeLessThan(prepared.outlookUrl.length);
    }
  });
});

/**
 * THE LADDER MUST MEASURE THE TRANSPORT THAT WILL ACTUALLY BE OPENED.
 *
 * The defect (2026-08-13): every rung was fitted against the https OWA url,
 * because that is what WEB opens. A phone with Outlook installed opens
 * `ms-outlook://compose`, which for the same body is roughly 25-30% shorter, so
 * the phone dropped item rows it had room for — the same complaint that started
 * this feature, one layer down.
 *
 * Everything below is a RELATIONSHIP, never an absolute row count: the
 * needed-by line renders wider under Hermes than under node, so a device can
 * legitimately land one row lower than this file would predict.
 */
describe('the transport option: fit against the url the caller will open', () => {
  /** A 25-line order with ordinary school-supply names — big enough that the
   *  ladder runs, realistic enough that the numbers mean something. */
  function order25(): DeliveryRequestInput {
    const names = [
      'Composition Notebook Wide Rule 100 Sheet',
      'Ticonderoga No 2 Pencil 12 Pack',
      'Elmers Washable School Glue 4oz',
      'Crayola Crayons 24 Count',
      'Fiskars Blunt Tip Kids Scissors',
      'Expo Low Odor Dry Erase Marker Black',
      'Post-it Notes 3x3 Yellow 12 Pad',
      'Clorox Disinfecting Wipes 75 Count',
      'Kleenex Facial Tissue 160 Count',
      'Purell Hand Sanitizer 8oz Pump',
      'Sharpie Permanent Marker Fine Black',
      'Two Pocket Folder Assorted Colors',
      'Wide Ruled Filler Paper 200 Sheet',
      'Highlighter Chisel Tip Assorted 6 Pack',
      'Index Cards 3x5 Ruled White 100',
      'Manila File Folder Letter Size 100',
      'Copy Paper 8.5x11 20lb Ream',
      'Binder Clips Medium 12 Count',
      'Stapler Full Strip Black',
      'Staples Standard 5000 Count Box',
      'Scotch Magic Tape 3/4 Inch',
      'Rubber Bands Size 33 1lb Bag',
      'Dry Erase Board Eraser Felt',
      'Whiteboard Cleaner Spray 8oz',
      'Trash Can Liner 33 Gallon 100 Count',
    ];
    const lines = names.map((_, i) => ({ itemId: `i-${i}`, quantity: (i % 9) + 2 }));
    return makeInput({
      warehouseName: 'DC4 Fresno',
      notes: 'Please stage these by Friday morning.',
      lines,
      itemMap: new Map(names.map((n, i) => [`i-${i}`, { name: n, sku: `SP-KIT-${1000 + i}` }])),
    });
  }

  it('THE DEFAULT IS THE WEB URL, and it is fitted against the WEB url', () => {
    // Web opens `outlookUrl`, so web must keep measuring `outlookUrl`. The
    // discriminating assertion is not "it fits" — a native-fitted draft could
    // also happen to fit — but that the chosen count is MAXIMAL for the web
    // url: one more row overflows it.
    const input = order25();
    const prepared = prepareDeliveryRequest(input);
    expect(prepared.transport).toBe('outlook-web');
    expect(prepared.draft.condensed).toBe(true);

    const k = prepared.draft.listedLineCount;
    expect(k).toBeGreaterThan(0);
    expect(prepared.outlookUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    const webUrlAt = (rows: number) =>
      buildDeliveryRequestOutlookUrl(
        buildDeliveryRequestDraft(input, { condensed: true, maxRows: rows }),
      ).length;
    expect(webUrlAt(k)).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(webUrlAt(k + 1)).toBeGreaterThan(DRAFT_URL_LIMIT);
    // An explicit 'outlook-web' is the same thing, byte for byte.
    expect(prepareDeliveryRequest(input, { transport: 'outlook-web' })).toEqual(prepared);
  });

  it('THE FIX: the native transport is fitted against the NATIVE url, and carries strictly more rows', () => {
    const input = order25();
    const web = prepareDeliveryRequest(input, { transport: 'outlook-web' });
    const native = prepareDeliveryRequest(input, { transport: 'outlook-native' });

    expect(native.transport).toBe('outlook-native');
    expect(native.draft.listedLineCount).toBeGreaterThan(web.draft.listedLineCount);

    // Maximal for the NATIVE url, the same way the web case is maximal for the
    // web url. A native draft that merely copied the web rung would fail here.
    const k = native.draft.listedLineCount;
    const nativeUrlAt = (rows: number) =>
      buildDeliveryRequestOutlookMobileUrl(
        buildDeliveryRequestDraft(input, { condensed: true, maxRows: rows }),
      ).length;
    expect(nativeUrlAt(k)).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(nativeUrlAt(k + 1)).toBeGreaterThan(DRAFT_URL_LIMIT);
  });

  it('THE HEADROOM the old behaviour threw away, in characters', () => {
    // What "measured the wrong transport" actually cost on a realistic order:
    // the url the phone opens sat hundreds of characters under the ceiling
    // while item rows were dropped to satisfy a url it never opens.
    const web = prepareDeliveryRequest(order25(), { transport: 'outlook-web' });
    const wasted = DRAFT_URL_LIMIT - web.outlookMobileUrl.length;
    expect(wasted).toBeGreaterThan(300);

    const native = prepareDeliveryRequest(order25(), { transport: 'outlook-native' });
    expect(native.draft.listedLineCount - web.draft.listedLineCount).toBeGreaterThanOrEqual(4);
    expect(DRAFT_URL_LIMIT - native.outlookMobileUrl.length).toBeLessThan(wasted);
  });

  it('the url a transport declares it will open is the one under the limit — for BOTH transports', () => {
    // The invariant that makes `linkFits` mean anything per surface.
    for (const transport of ['outlook-web', 'outlook-native'] as const) {
      const p = prepareDeliveryRequest(order25(), { transport });
      expect(p.linkFits).toBe(true);
      const opened = transport === 'outlook-native' ? p.outlookMobileUrl : p.outlookUrl;
      expect(opened.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
      // The mailto is measured under both, because every surface can open it —
      // web when the popup is blocked, mobile as its own button and as the
      // cc-untrusted reroute.
      expect(p.mailtoUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    }
  });

  it('under the native budget the WEB url is genuinely unmeasured, which is why the default is web', () => {
    // The teeth: a caller that asked for the shorter budget and then opened the
    // https url would hand a mail client a body that truncates silently. The
    // native budget is only safe for a surface that has PROVED the native app
    // takes the link — which is why the default is the expensive one.
    const native = prepareDeliveryRequest(order25(), { transport: 'outlook-native' });
    expect(native.linkFits).toBe(true);
    expect(native.outlookUrl.length).toBeGreaterThan(DRAFT_URL_LIMIT);
  });

  it('a draft that fits WHOLE is unaffected by the transport — no ladder, same bytes', () => {
    // Rung 1 does not depend on which url is measured, and must not start to.
    const web = prepareDeliveryRequest(makeInput(), { transport: 'outlook-web' });
    const native = prepareDeliveryRequest(makeInput(), { transport: 'outlook-native' });
    expect(web.draft.condensed).toBe(false);
    expect(native.draft.condensed).toBe(false);
    expect(native.draft.body).toBe(web.draft.body);
    expect(native.outlookUrl).toBe(web.outlookUrl);
    expect(native.clipboardText).toBe(web.clipboardText);
  });

  it('rung 4 is still reachable on the native budget: nothing is prefilled when even the floor overflows', () => {
    // The shorter budget must not quietly turn a refuse-to-prefill draft into a
    // truncating one. A pathological warehouse name is not shortened by
    // anything the ladder does, on either transport.
    const oversized = makeInput({ warehouseName: 'W'.repeat(3000), destination: null });
    for (const transport of ['outlook-web', 'outlook-native'] as const) {
      const p = prepareDeliveryRequest(oversized, { transport });
      expect(p.linkFits).toBe(false);
      expect(p.draft.listedLineCount).toBe(0);
    }
  });

  it('the native url always carries the CHOSEN rung, whichever transport was measured', () => {
    // The pre-existing guarantee, re-asserted now that three urls are built on
    // every rung rather than only the chosen one: no transport may carry a body
    // the limit check never saw.
    for (const transport of ['outlook-web', 'outlook-native'] as const) {
      const p = prepareDeliveryRequest(order25(), { transport });
      const last = `${p.draft.listedLineCount}. `;
      const beyond = `${p.draft.listedLineCount + 1}. `;
      // The native url and the mailto encode the body ONCE; the web url wraps
      // an inner mailto and encodes it TWICE. That difference is the whole
      // reason the two budgets differ, so it is spelled out rather than
      // decoded away.
      expect(p.outlookMobileUrl).toContain(encodeURIComponent(last));
      expect(p.outlookMobileUrl).not.toContain(encodeURIComponent(beyond));
      expect(p.mailtoUrl).toContain(encodeURIComponent(last));
      expect(p.mailtoUrl).not.toContain(encodeURIComponent(beyond));
      expect(p.outlookUrl).toContain(encodeURIComponent(encodeURIComponent(last)));
      expect(p.outlookUrl).not.toContain(encodeURIComponent(encodeURIComponent(beyond)));
    }
  });
});

/**
 * THE RECIPIENTS TYPE IS BRANDED — a wrong address is no longer TYPEABLE at a
 * call site that does not exist yet.
 *
 * WHAT WAS STILL OPEN before this block (2026-08-13). Both shipped call sites
 * are pinned hard: a wrong cc fails 11 mobile and 29 web tests, an omitted cc is
 * a type error, an empty cc throws. But a THIRD call site writing
 * `{ to: DELIVERY_REQUEST_EMAIL.to, cc: 'ops@somewhere.test' }` compiled clean
 * and passed the entire repo's suites while composing a genuinely misrouted
 * compose URL — because a routable-but-wrong address is exactly what every
 * runtime guard in this file is built to ACCEPT. No value-level test can see a
 * call site nobody has written yet; only the type system can.
 *
 * The brand is what the original no-parameter design gave structurally, by
 * having nothing to pass. It is restored here without giving up the parameter
 * the per-org work needs.
 */
describe('DeliveryRequestRecipients is branded — an object literal is not one', () => {
  it('TYPE-LEVEL PIN: a raw object literal does not typecheck as recipients', () => {
    // If the brand is ever removed, this @ts-expect-error becomes an UNUSED
    // directive and `pnpm typecheck` fails with TS2578 — which is the point.
    // The runtime assertion below is deliberately trivial; the assertion this
    // test really makes is made by the compiler.
    // @ts-expect-error a raw literal is missing the module-private brand
    const forged: DeliveryRequestRecipients = {
      to: DELIVERY_REQUEST_EMAIL.to,
      cc: 'ops@somewhere.test',
    };
    expect(forged.cc).toBe('ops@somewhere.test');
  });

  /**
   * THE SPREAD IS THE ONE THAT MATTERED. Nobody hand-types four fields to get a
   * wrong cc; they start from the value that already works and change the field
   * they mean to change. Under the previous `unique symbol` brand this line
   * compiled with ZERO errors and no cast, because an object spread reproduces
   * symbol-keyed properties in the spread type — so the brand stopped the form
   * of the mistake nobody makes and allowed the form everybody makes.
   *
   * The brand is a private class member now, which is the one property kind
   * TypeScript's spread does not carry over. Removing it makes this directive
   * unused and `pnpm typecheck` fails with TS2578.
   */
  it('TYPE-LEVEL PIN: the working value cannot be SPREAD into a wrong one', () => {
    // @ts-expect-error the spread drops the private brand: TS2741
    const forged: DeliveryRequestRecipients = {
      ...DELIVERY_REQUEST_RECIPIENTS,
      cc: 'ops@somewhere.test',
    };
    expect(forged.cc).toBe('ops@somewhere.test');
  });

  /**
   * THE RESIDUAL, STATED RATHER THAN IMPLIED.
   *
   * `Object.assign` is NOT closed, at the type level or at runtime, and no
   * brand can close it: its lib signature returns `T & U & V`, an intersection
   * that already contains `DeliveryRequestRecipients`, so whatever the brand is
   * — symbol key, private member, branded `cc` string — the return type
   * re-supplies it by construction. The runtime does not catch it either,
   * because `ops@somewhere.test` is a perfectly routable address and refusing
   * routable addresses is not something this validator can do.
   *
   * This test asserts the hole, on purpose. It exists so that a reader of the
   * brand's doc comment cannot come away believing more than is true, and so
   * that if someone later closes this path the test fails and forces the
   * comment to be corrected with it. No `@ts-expect-error` appears below, and
   * its absence IS the assertion: the line typechecks.
   */
  it('THE RESIDUAL: Object.assign still typechecks, and is still accepted at runtime', () => {
    const forged: DeliveryRequestRecipients = Object.assign({}, DELIVERY_REQUEST_RECIPIENTS, {
      cc: 'ops@somewhere.test',
    });

    const draft = buildDeliveryRequestDraft(makeInput({ recipients: forged }));
    // Not refused, and not silently corrected either — the forged address is
    // what would reach a real compose window. Review is the only thing standing
    // between this line and a misrouted delivery request.
    expect(draft.cc).toBe('ops@somewhere.test');
    expect(buildDeliveryRequestOutlookUrl(draft)).toContain(
      encodeURIComponent(encodeURIComponent('ops@somewhere.test')),
    );
    // What the brand DOES buy, in the same breath: the accidental spelling of
    // the same mistake is a compile error (the test above), so this one has to
    // be written deliberately.
  });

  it('the factory is the only constructor, and it VALIDATES before it brands', () => {
    const made = deliveryRequestRecipients({
      to: 'intake@othercorp.test',
      cc: 'ops@othercorp.test',
      toName: 'Other Intake',
      ccName: 'Other Ops',
    });
    expect({ ...made }).toEqual({
      to: 'intake@othercorp.test',
      cc: 'ops@othercorp.test',
      toName: 'Other Intake',
      ccName: 'Other Ops',
    });

    // The same refusals the builder makes, one step earlier — at the moment the
    // value is created rather than the moment it is used, which is where a
    // per-org row will fail.
    for (const bad of ['', '   ', 'a?cc=attacker@evil.test', 'a@b,c@d.test', 'no-at-sign']) {
      expect(() => deliveryRequestRecipients({ to: bad, cc: 'ops@othercorp.test' })).toThrow(
        /recipient "to" must be exactly one plain email address/,
      );
      expect(() => deliveryRequestRecipients({ to: 'intake@othercorp.test', cc: bad })).toThrow(
        /recipient "cc" must be exactly one plain email address/,
      );
    }

    // And the display names go through the SAME guard the transports use: a
    // comma in an unquoted name-addr splits it into two recipients and the
    // mandatory CC is the half that disappears.
    expect(() =>
      deliveryRequestRecipients({
        to: 'intake@othercorp.test',
        cc: 'ops@othercorp.test',
        ccName: 'Rosas, Andrew',
      }),
    ).toThrow(/Display name contains RFC 5322 specials/);
  });

  it('the value it returns is frozen, so a stray assignment cannot redirect warehouse mail', () => {
    const made = deliveryRequestRecipients({ to: 'intake@othercorp.test', cc: 'ops@othercorp.test' });
    expect(Object.isFrozen(made)).toBe(true);
    try {
      (made as unknown as Record<string, string>).cc = 'attacker@evil.test';
    } catch {
      /* strict mode throws; either way the value must not move */
    }
    expect(made.cc).toBe('ops@othercorp.test');
  });

  it('DELIVERY_REQUEST_RECIPIENTS is that factory output, carrying both addresses and both chips', () => {
    // The one value both surfaces import. If it ever stopped being built from
    // the frozen constants, the two surfaces could mail different mailboxes —
    // which is the drift the whole extraction exists to prevent.
    expect({ ...DELIVERY_REQUEST_RECIPIENTS }).toEqual({
      to: DELIVERY_REQUEST_EMAIL.to,
      cc: DELIVERY_REQUEST_EMAIL.cc,
      toName: DELIVERY_REQUEST_EMAIL_NAMES.to,
      ccName: DELIVERY_REQUEST_EMAIL_NAMES.cc,
    });
    expect(Object.isFrozen(DELIVERY_REQUEST_RECIPIENTS)).toBe(true);
  });

  it('the RUNTIME guard survives a cast — the brand and the validator catch different things', () => {
    // The brand cannot stop `as unknown as`, and it says nothing at all about
    // an address that arrives as data at runtime. That is why
    // buildDeliveryRequestDraft keeps validating rather than trusting the type.
    expect(() =>
      buildDeliveryRequestDraft(
        makeInput({ recipients: unbranded({ to: DELIVERY_REQUEST_EMAIL.to, cc: 'a?cc=evil@attacker.test' }) }),
      ),
    ).toThrow(/recipient "cc" must be exactly one plain email address/);
  });
});
