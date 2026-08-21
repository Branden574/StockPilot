/**
 * AI SIZE-STICKER SCAN — prompt, response schema and defensive parser.
 *
 * Pure module, exactly like `shelf-scan.ts`: no network, no env, no Supabase.
 * The route composes it with the provider seam; everything decidable without a
 * model call is decided here, where it can be unit-tested.
 *
 * ═══ WHY THE PROMPT LOOKS LIKE THIS ═══
 *
 * Every rule below was derived by running the real training corpus through the
 * model and reading the failures — 267 distinct stickers, scored one per
 * capture burst. The harness is committed at `scripts/size-scan-eval/`, so any
 * edit to this prompt can be re-measured rather than argued about. The
 * headline numbers on that set, at confidence >= 0.7:
 *
 *      first draft                          73.0%
 *      + rotation alphabet                  89.1%
 *      + carrier classification (Haiku)     89.9%
 *      + carrier classification (Sonnet)    95.5%
 *
 * Two findings did nearly all of that work, and both are worth understanding
 * before touching anything here.
 *
 * ─── 1. THE STICKERS SIT AT ARBITRARY ROTATION ───
 *
 * Nobody lines these dots up, and nobody holds the phone square to them. This
 * was the single largest error source and it was INVISIBLE until the schema was
 * made to emit `rawText` before `size`: once the model had to write down what
 * it actually saw, the failures spelled out an alphabet.
 *
 * An upside-down `L` is a `7`, and rotation also REVERSES the reading order —
 * so `XXL` upside down transcribes as `7XX`. An upside-down `M` is a `W`; on
 * its side it reads as a lightning bolt. An `L` at 135 degrees is a checkmark.
 *
 * Before this was understood, those readings looked like hallucinations. They
 * were not. The model was transcribing correctly and had no idea the sticker
 * was upside down. Anything that looks like an invented size here is worth
 * checking against a rotation before it is called a hallucination.
 *
 * ─── 2. CLASSIFY THE CARRIER BEFORE READING IT ───
 *
 * A garment's BELLA+CANVAS neck tag prints its size too, and the operator
 * counting stickers must not count it. Prose telling the model to ignore neck
 * tags DID NOT WORK — with the rotation rules in play the model read a neck
 * tag's upside-down "M" and reported it at confidence 1.0.
 *
 * What worked was making `carrier` a REQUIRED field emitted BEFORE the reading.
 * That took no-sticker recall from 55% to 100%, with zero false sizes, on both
 * models. The general lesson, and the reason this is written down: an
 * instruction the model can skip is an instruction it will skip. Force the
 * discriminating observation into the OUTPUT, ahead of the decision that
 * depends on it.
 *
 * ═══ WHAT THIS IS NOT ═══
 *
 * XXXXL and XXXXXL have ZERO examples in the corpus. They are accepted here
 * because the database accepts them, but nothing has ever verified the model
 * reads them, and the measured accuracy above says nothing about them.
 *
 * The one structural error left is XXXL read as XXL — the model transcribes
 * `"XXL", xCount 2` at high confidence on a genuine three-X dot, on the smaller
 * oval stickers one vendor uses. Sending a bigger image does NOT fix it: full
 * capture resolution scored identically, because the vision API downsamples to
 * roughly 1568px on the long edge anyway, so the sticker never gains pixels.
 * The fix is a crop stage — locate the dot, crop, re-read — which is not built.
 */

/** The nine sizes, matching the `size_label` CHECK in migration 0284 exactly
 *  (minus its `NONE` member, which is the absence of a sticker rather than a
 *  size a sticker can bear). */
export const SIZE_SCAN_SIZES = [
  'XS',
  'S',
  'M',
  'L',
  'XL',
  'XXL',
  'XXXL',
  'XXXXL',
  'XXXXXL',
] as const;

export type SizeScanSize = (typeof SIZE_SCAN_SIZES)[number];

/** What the model is asked to say about where a marking is printed. Only
 *  `round_dot` can become a count. */
export const SIZE_SCAN_CARRIERS = ['round_dot', 'printed_tag_or_label', 'other'] as const;
export type SizeScanCarrier = (typeof SIZE_SCAN_CARRIERS)[number];

/**
 * The confidence floor a reading must clear to be proposed.
 *
 * 0.7 rather than something stricter: on the corpus, raising it to 0.95 removed
 * four wrong readings and suppressed seventy correct ones. Suppression is not
 * free — every suppressed sticker is one the operator has to tap by hand, and a
 * scan that gives back most of the tapping is a scan nobody uses.
 */
export const SIZE_SCAN_MIN_CONFIDENCE = 0.7;

/** Bounds on what ONE photo may produce. The images are operator-supplied, and
 *  a response is only ever as bounded as the code that reads it. */
export const MAX_SIZE_SCAN_STICKERS = 60;
const MAX_RAW_TEXT_LEN = 40;

export type SizeScanSticker = {
  carrier: SizeScanCarrier;
  /** The glyphs as they sat in the photo, before any rotation was undone.
   *  Surfaced to the operator so a disputed reading can be understood rather
   *  than merely distrusted. */
  rawText: string;
  size: SizeScanSize;
  confidence: number;
};

export type SizeScanResult = {
  /** Only round-dot readings above the confidence floor — what may be counted. */
  stickers: SizeScanSticker[];
  /** Per size, how many dots were read. This is the proposal the operator
   *  reviews; nothing here is written until they confirm it. */
  counts: Array<{ size: SizeScanSize; count: number }>;
  /** Readings dropped because they were on a tag, below the floor, or not a
   *  size at all. Reported so "the scan missed one" can be diagnosed instead of
   *  guessed at — a silent drop is indistinguishable from a blind spot. */
  discarded: Array<{ rawText: string; reason: 'on_a_label' | 'low_confidence' | 'unreadable' }>;
};

/**
 * The JSON schema handed to whichever provider is resolved.
 *
 * ONE schema for both providers. `SchemaType.OBJECT` in the Gemini SDK is the
 * string `"object"`, so the two providers want byte-identical JSON and differ
 * only in their TypeScript types — which is why this is a plain literal cast at
 * the Gemini call site rather than two schemas kept in step by hand. The SDK's
 * `ResponseSchema` type also has no `propertyOrdering`, though the API honours
 * it, so typing it as one would force out the field the ordering depends on.
 *
 * FIELD ORDER IS LOAD-BEARING, not cosmetic. Models fill a structured response
 * in declaration order, so `carrier` and `rawText` are committed to before
 * `size` — which is the whole mechanism by which the two findings above work.
 * Reordering these fields silently undoes the accuracy they bought.
 */
export const SIZE_SCAN_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    stickers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          carrier: { type: 'string', enum: [...SIZE_SCAN_CARRIERS] },
          rawText: { type: 'string' },
          xCount: { type: 'integer' },
          size: { type: 'string', enum: [...SIZE_SCAN_SIZES] },
          confidence: { type: 'number' },
        },
        required: ['carrier', 'rawText', 'xCount', 'size', 'confidence'],
        // GEMINI DOES NOT PRESERVE DECLARATION ORDER. It is documented as
        // emitting properties in an arbitrary order unless `propertyOrdering`
        // says otherwise — a non-standard extension Claude ignores harmlessly.
        // Without this the fallback provider is free to decide `size` before
        // `carrier` and `rawText`, which quietly dismantles the two mechanisms
        // this whole module is built on, while still returning a valid object.
        propertyOrdering: ['carrier', 'rawText', 'xCount', 'size', 'confidence'],
      },
    },
    noStickerVisible: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['stickers', 'noStickerVisible', 'notes'],
  propertyOrdering: ['stickers', 'noStickerVisible', 'notes'],
} as const;

export const SIZE_SCAN_PROMPT = `You are counting GARMENT SIZE STICKERS in a warehouse receiving photo.

WHAT A SIZE STICKER IS
A separate ADHESIVE DOT — round or oval, roughly coin-sized, nearly always
white or pale with heavy black lettering — stuck onto the folded garment or
onto the clear bag around it. It is the only thing that may be counted.

WHAT IS NOT A SIZE STICKER. This is the other half of the job, and getting it
wrong is the most common way to be wrong here.

THE TEST THAT SETTLES IT — how much of the thing is the size?
  A SIZE STICKER is a round or oval dot whose ENTIRE content is the size: one
  or two big black characters printed large, filling most of the dot, with
  nothing else on it. No brand, no care symbols, no small print.

  A TAG OR LABEL is a rectangular strip of fabric or paper covered in SMALL
  print — a brand name, washing symbols, fibre percentages, an RN number, a
  country of origin — among which a size character appears in the same small
  type as everything around it.

So: if the size character sits among other small printed text, it is on a label
and must not be counted, however sharp and legible it is. Legibility is not the
test. Being alone on a dot is the test.

Named offenders, all of which appear constantly in these photos:
- the brand neck tag: BELLA+CANVAS, CANVAS, Gildan, Port & Company, Next Level.
  These print the size under the brand name or under a line such as "ASSEMBLED
  IN NICARAGUA" or "USA STRONG".
- the sewn-in care/content strip along the inside seam, which prints the size
  at its top or bottom in small type.
- price tags, barcodes, SKU labels, and lettering printed on the shirt as part
  of its design.

A garment with a perfectly readable "M" on its neck tag and no dot stuck to it
is a NO-STICKER photo.

THE STICKERS SIT AT EVERY ANGLE. THIS IS THE BIGGEST SOURCE OF ERROR.

Nobody lines these dots up, and nobody holds the camera square to them. A dot
is as likely to be upside down or on its side as upright. So before reading a
dot, WORK OUT WHICH WAY UP IT IS and read it in the orientation that produces a
real size. What you are looking at is almost never a strange symbol — it is one
of nine ordinary sizes, turned.

These are the shapes real stickers in this warehouse turn into:

  W, a zigzag, a lightning bolt, a sideways M          -->  M
  <, >, a checkmark or tick, a chevron, an arrowhead,
  a bare 7                                             -->  L
  SX                                                   -->  XS
  7X, TX, X7                                           -->  XL
  7XX, XX7                                             -->  XXL
  7XXX, XXX7                                           -->  XXXL

The pattern behind that table: an L turned upside down becomes a 7, and the
letters also come out in REVERSE ORDER. So a dot transcribing as "7XX" is "XXL"
upside down. An M turned over is a W; on its side it reads as a zigzag.
S and X look the same either way up and need no correction.

A dot bearing what looks like a checkmark, chevron, arrow or lightning bolt is
not a decoration and not a non-size mark. It is a rotated letter — turn it and
read it.

COUNT THE X CHARACTERS ONE AT A TIME.
XL has one X, XXL two, XXXL three, XXXXL four. Do not judge by how wide the
text looks; count the actual letters. Getting this wrong files stock against
the wrong size, which somebody has to find and unpick later.

SIZES YOU MAY REPORT — exactly these spellings and nothing else:
XS, S, M, L, XL, XXL, XXXL, XXXXL, XXXXXL

Numeric spellings map on: 2XL and 2X are XXL, 3XL and 3X are XXXL, 4XL and 4X
are XXXXL, 5XL and 5X are XXXXXL.

WHY OMITTING BEATS GUESSING
This feeds a physical stock count. A wrong size costs far more than a missed
one: a miss is noticed and re-scanned in seconds, a wrong size becomes a count
somebody has to track down and undo. Never infer a size from the garment's
bulk, from the other dots in the photo, or from which size would be likely.

Report EVERY distinct dot you can read, including several of the same size when
a stack of one size is photographed together.

HOW TO FILL IN EACH ENTRY — IN THIS ORDER, WITHOUT SKIPPING AHEAD.

List one entry for EVERY size-looking marking in the photo, INCLUDING the ones
on tags, and then classify each one honestly. Entries that are not on a round
dot are discarded afterwards, so including a neck tag costs nothing and hiding
one costs a miscount.

  0. carrier — what the marking is printed ON, decided before reading it:
       "round_dot"             a round or oval adhesive dot whose whole content
                               is one or two big characters and nothing else.
       "printed_tag_or_label"  a rectangular fabric or paper strip: a brand neck
                               tag, a care strip, a price or SKU label, where
                               the size sits in small type among small print.
       "other"                 anything else — artwork printed on the shirt, a
                               smudge, a mark on the floor.

     Decide this from SHAPE AND SURROUNDINGS ALONE, before reading any letters.
     A character being large, sharp and easy to read says nothing about which of
     these it is on.

     THE ROTATION RULES APPLY ONLY TO round_dot ENTRIES. Tag text is printed
     upside down just as often, and turning it upright does not promote it into
     a sticker. A neck tag reading "W" is a tag bearing an upside-down "M" — and
     it is still a tag.

  1. rawText — transcribe the glyphs EXACTLY as they sit in the photo, in the
     order your eye meets them, WITHOUT rotating the image first and without
     tidying them into a size. If the dot shows "SX", write "SX". If the shape
     is not a letter as it sits, name it in one word: "checkmark", "chevron",
     "arrow", "lightning", "zigzag", "7", "W". Do not skip it and do not clean
     it up — this raw shape is what the rotation table is read against.

  2. xCount — count the X characters in rawText and give the number. Point at
     them one at a time. This is a count, not an impression of width.

  3. size — only now decide, from rawText and xCount together, AFTER putting the
     shape upright using the rotation table. Almost every dot on a garment here
     is one of the nine sizes at some angle, so work at the rotation before
     concluding a dot cannot be read.

     Leave an entry out entirely only when rotating it still does not produce
     one of the nine sizes — a genuine smudge, a torn dot, something too blurred
     to resolve. Do not leave a dot out merely because it looked odd before you
     turned it.

  4. confidence — 1.0 when the lettering is plainly legible, 0.5 when you can
     see a dot but its text is uncertain, below 0.3 when you would be guessing.

Set noStickerVisible to true when the photo holds no readable size dot at all,
including when the only size you can see is on a neck tag or care label.`;

/** Numeric spellings the model is told to normalise. Applied again on the way
 *  in, because a rule the model was given is not a rule the model kept. */
const NUMERIC_ALIASES: Record<string, SizeScanSize> = {
  '2X': 'XXL',
  '2XL': 'XXL',
  '3X': 'XXXL',
  '3XL': 'XXXL',
  '4X': 'XXXXL',
  '4XL': 'XXXXL',
  '5X': 'XXXXXL',
  '5XL': 'XXXXXL',
};

function normalizeSize(raw: unknown): SizeScanSize | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toUpperCase().replace(/[\s.-]/g, '');
  if ((SIZE_SCAN_SIZES as readonly string[]).includes(v)) return v as SizeScanSize;
  return NUMERIC_ALIASES[v] ?? null;
}

function boundedRaw(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, MAX_RAW_TEXT_LEN) : '';
}

/**
 * Turn a raw model response into the proposal the operator reviews.
 *
 * REBUILT FROM A WHITELIST, never trusted field-by-field — the same posture as
 * `parseShelfScanResponse` and the po-scan mapper. A forced schema constrains a
 * WELL-BEHAVED response; it is not a guarantee about a malformed or adversarial
 * one, and this parser is the only thing between the model and a count.
 *
 * Never throws. A response that cannot be read at all is an empty proposal,
 * which the UI renders as "nothing found" — the same thing the operator sees
 * for a photo of an empty table, and a truthful description of what we have.
 */
export function parseSizeScanResponse(raw: string): SizeScanResult {
  const parsed = safeParse(raw);
  const stickers: SizeScanSticker[] = [];
  const discarded: SizeScanResult['discarded'] = [];

  const rows = Array.isArray(parsed?.stickers) ? parsed.stickers : [];
  for (const row of rows.slice(0, MAX_SIZE_SCAN_STICKERS)) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const rawText = boundedRaw(r.rawText);
    const size = normalizeSize(r.size);
    const carrier = (SIZE_SCAN_CARRIERS as readonly string[]).includes(r.carrier as string)
      ? (r.carrier as SizeScanCarrier)
      : 'other';
    const confidence =
      typeof r.confidence === 'number' && Number.isFinite(r.confidence)
        ? Math.min(1, Math.max(0, r.confidence))
        : 0;

    if (!size) {
      discarded.push({ rawText, reason: 'unreadable' });
      continue;
    }
    // A missing or unrecognised carrier lands on 'other' above and is dropped
    // here. That is deliberate: the carrier is what separates a sticker from a
    // neck tag, so an absent one means the question was never answered, and
    // counting it would restore exactly the error this field exists to remove.
    if (carrier !== 'round_dot') {
      discarded.push({ rawText, reason: 'on_a_label' });
      continue;
    }
    if (confidence < SIZE_SCAN_MIN_CONFIDENCE) {
      discarded.push({ rawText, reason: 'low_confidence' });
      continue;
    }
    stickers.push({ carrier, rawText, size, confidence });
  }

  const tally = new Map<SizeScanSize, number>();
  for (const s of stickers) tally.set(s.size, (tally.get(s.size) ?? 0) + 1);
  const counts = SIZE_SCAN_SIZES.filter((s) => tally.has(s)).map((size) => ({
    size,
    count: tally.get(size)!,
  }));

  return { stickers, counts, discarded };
}

/**
 * `JSON.parse`, with one retry after stripping a markdown fence.
 *
 * Dead weight on Claude, which returns the object through a forced tool call,
 * and load-bearing on Gemini, which wraps JSON in ```json often enough that
 * `parseShelfScanResponse` carries the same two lines.
 */
function safeParse(raw: string): { stickers?: unknown } | null {
  const attempt = (s: string): { stickers?: unknown } | null => {
    try {
      const v: unknown = JSON.parse(s);
      return typeof v === 'object' && v !== null ? (v as { stickers?: unknown }) : null;
    } catch {
      return null;
    }
  };
  return attempt(raw) ?? attempt(raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, ''));
}
