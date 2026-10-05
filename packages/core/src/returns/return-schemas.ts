/**
 * The request bodies of the returns routes and actions (returns plan 3.9):
 * one set of zod schemas for the web actions, the API routes and the phone.
 * RX-2 adds the exchange fields (a line's exchange; the approval's exchange
 * decisions and replacement options) and the bodies of the replacement
 * actions (change or re-issue, cancel, release early, the candidate search,
 * the prepare chain).
 * They are ADVISORY mirrors of the SQL: every rule here is re-checked by the
 * database function (whole units only, closing G10; at most 100 lines and
 * 10,000 units a line; reasons 1 to 1,000 characters; scrap carries no
 * destination; a source names its location). A body that passes here can
 * still be refused there; one refused here never reaches it.
 *
 * `RETURN_SCHEMA_CASES` is shared with the pgTAP suite: each case name has a
 * `-- case: <name>` marker beside the database assertion that refuses the
 * same body (return-schemas.test.ts fails when a marker is missing).
 *
 * Built on first use, never when the module loads (see place-order.ts):
 * importing this module runs nothing.
 */

import { z } from 'zod';

export const RETURN_MAX_LINES = 100;
export const RETURN_MAX_UNITS_PER_LINE = 10_000;
/** Requester submissions: total units across the request. */
export const RETURN_MAX_UNITS_REQUESTER = 10_000;
export const RETURN_NOTES_MAX = 2000;
export const RETURN_REASON_MAX = 1000;
/** RX-2: "Tell the warehouse what you need" (a warehouse-review request). */
export const RETURN_EXCHANGE_NOTE_MAX = 500;
/** RX-2: an early release's reason. */
export const RETURN_RELEASE_REASON_MAX = 500;
/** RX-2: the staff replacement search's term. */
export const RETURN_CANDIDATE_QUERY_MAX = 80;

export const RETURN_REASON_CODES = ['damaged', 'wrong_item', 'end_of_year', 'overage', 'other'] as const;
export type ReturnReasonCodeValue = (typeof RETURN_REASON_CODES)[number];

function trimmedOptional(max: number) {
  return z
    .string()
    .max(max * 2)
    .optional()
    .nullable()
    .transform((v) => {
      const t = (v ?? '').trim();
      return t.length > 0 ? t : undefined;
    })
    .refine((v) => v === undefined || v.length <= max, { message: `At most ${max} characters.` });
}

function requiredReason(max: number) {
  return z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().min(1, { message: 'Add a reason.' }).max(max, { message: `At most ${max} characters.` }));
}

function buildSchemas() {
  const uuid = z.string().uuid();
  const quantity = z.number().int().min(1).max(RETURN_MAX_UNITS_PER_LINE);

  // RX-2: one returned line's exchange (plan 3.3.6): an item (a size or, for
  // staff, any orderable item), or "the warehouse will review" with a note;
  // the quantity defaults to, and is capped by, the line's return quantity
  // (checked on the line below). Nothing else may ride along.
  const exchange = z
    .object({
      itemId: uuid.optional().nullable(),
      quantity: quantity.optional().nullable(),
      note: trimmedOptional(RETURN_EXCHANGE_NOTE_MAX),
    })
    .strict()
    .superRefine((x, ctx) => {
      if (!x.itemId && !x.note) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose a replacement or tell the warehouse what you need.' });
      }
    });

  const capExchange = (ls: Array<{ quantity: number; exchange?: { quantity?: number | null } | null }>, ctx: z.RefinementCtx) => {
    for (const l of ls) {
      if (l.exchange && typeof l.exchange.quantity === 'number' && l.exchange.quantity > l.quantity) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A replacement can't be more than the quantity returned." });
        return;
      }
    }
  };

  const createLine = z.object({
    orderRequestLineId: uuid,
    quantity,
    disposition: z.enum(['restock', 'scrap']).optional(),
    // Optional identity assertion (the server always stamps the item from the
    // source line; a mismatch is refused, never coerced).
    itemId: uuid.optional(),
    exchange: exchange.optional().nullable(),
  });

  const lines = z
    .array(createLine)
    .min(1)
    .max(RETURN_MAX_LINES)
    .superRefine((ls, ctx) => {
      const seen = new Set<string>();
      for (const l of ls) {
        const key = l.orderRequestLineId.toLowerCase();
        if (seen.has(key)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Each order line may appear at most once in a return.' });
          return;
        }
        seen.add(key);
      }
      capExchange(ls, ctx);
    });

  const create = z.object({
    reasonCode: z.enum(RETURN_REASON_CODES).optional().nullable(),
    notes: trimmedOptional(RETURN_NOTES_MAX),
    lines,
    itemIsHere: z.boolean().optional(),
    idempotencyKey: uuid.optional(),
  });

  const requesterLine = z.object({
    orderRequestLineId: uuid,
    quantity,
    exchange: exchange.optional().nullable(),
  });

  const requester = z
    .object({
      reasonCode: z.enum(RETURN_REASON_CODES).optional().nullable(),
      notes: trimmedOptional(RETURN_NOTES_MAX),
      lines: z
        .array(requesterLine)
        .min(1)
        .max(RETURN_MAX_LINES)
        .superRefine((ls, ctx) => {
          const seen = new Set<string>();
          for (const l of ls) {
            const key = l.orderRequestLineId.toLowerCase();
            if (seen.has(key)) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Each order line may appear at most once in a return.' });
              return;
            }
            seen.add(key);
          }
          capExchange(ls, ctx);
        }),
      idempotencyKey: uuid.optional(),
    })
    .superRefine((b, ctx) => {
      const total = b.lines.reduce((s, l) => s + l.quantity, 0);
      if (total > RETURN_MAX_UNITS_REQUESTER) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A return can have at most 10,000 units.' });
      }
    });

  const lineDecision = z
    .object({
      returnLineId: uuid,
      disposition: z.enum(['restock', 'scrap']),
      restock: z
        .object({
          target: z.enum(['staging', 'original', 'source']),
          locationId: uuid.optional(),
        })
        .optional()
        .nullable(),
    })
    .superRefine((d, ctx) => {
      if (d.disposition === 'scrap' && d.restock) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Scrap has no destination.' });
      }
      if (d.restock?.target === 'source' && !d.restock.locationId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose which rack.' });
      }
      if (d.restock && d.restock.target !== 'source' && d.restock.locationId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Only a chosen rack takes a location.' });
      }
    });

  const decisionLines = z
    .array(lineDecision)
    .min(1)
    .max(RETURN_MAX_LINES)
    .superRefine((ls, ctx) => {
      const seen = new Set<string>();
      for (const l of ls) {
        const key = l.returnLineId.toLowerCase();
        if (seen.has(key)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Each returned line may appear at most once.' });
          return;
        }
        seen.add(key);
      }
    });

  // RX-2: one decision per requested exchange line (plan 3.3.3 step 6):
  // approve (the requested item, or a staff choice: a choice differing from
  // a requested item is a substitution and needs a reason, which the
  // database decides), decline (a reason), or add one to a return-only line
  // (G9).
  const exchangeDecision = z.discriminatedUnion('action', [
    z
      .object({
        action: z.literal('approve'),
        exchangeLineId: uuid,
        itemId: uuid.optional().nullable(),
        quantity: quantity.optional().nullable(),
        reason: trimmedOptional(RETURN_REASON_MAX),
      })
      .strict(),
    z.object({ action: z.literal('decline'), exchangeLineId: uuid, reason: requiredReason(RETURN_REASON_MAX) }).strict(),
    z
      .object({
        action: z.literal('add'),
        returnLineId: uuid,
        itemId: uuid,
        quantity: quantity.optional().nullable(),
        reason: trimmedOptional(RETURN_REASON_MAX),
      })
      .strict(),
  ]);

  // The replacement order's options: refused or backordered when short
  // (D19), and the approver's fulfilment override (a delivery names a site
  // the warehouse serves; the database checks the pair).
  const replacementOptions = z
    .object({
      whenShort: z.enum(['refuse', 'backorder']).optional(),
      fulfillmentType: z.enum(['pickup', 'delivery']).optional(),
      deliveryCharterId: uuid.optional().nullable(),
    })
    .strict();

  const approve = z.object({
    lines: decisionLines,
    exchange: z
      .array(exchangeDecision)
      .max(RETURN_MAX_LINES)
      .optional()
      .superRefine((xs, ctx) => {
        const seen = new Set<string>();
        for (const x of xs ?? []) {
          const key = ('exchangeLineId' in x ? x.exchangeLineId : x.returnLineId).toLowerCase();
          if (seen.has(key)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Each exchange line takes one decision.' });
            return;
          }
          seen.add(key);
        }
      }),
    replacement: replacementOptions.optional().nullable(),
  });

  const reason = requiredReason(RETURN_REASON_MAX);

  const deny = z.object({ reason });

  // RX-2: change a replacement (substitution) or issue a new one after a
  // replacement cancel (C-1); cancel a replacement; release one early.
  const changeReplacement = z.object({
    expectedRevision: z.number().int().min(0),
    lines: z
      .array(
        z
          .object({
            exchangeLineId: uuid,
            itemId: uuid.optional().nullable(),
            quantity: quantity.optional().nullable(),
          })
          .strict(),
      )
      .max(RETURN_MAX_LINES)
      .default([]),
    reason,
    whenShort: z.enum(['refuse', 'backorder']).default('refuse'),
    replacement: replacementOptions.omit({ whenShort: true }).optional().nullable(),
  });

  // Desk check F7: the cancel names the revision the caller saw, and the
  // release the replacement order it saw, so a stale tab never acts on a
  // replacement its user has not seen (the database answers return_changed).
  const cancelReplacement = z.object({
    expectedRevision: z.number().int().min(0),
    reason,
  });

  const releaseEarly = z.object({ orderId: uuid, reason: requiredReason(RETURN_RELEASE_REASON_MAX) });

  const candidates = z.object({
    line: uuid,
    q: z
      .string()
      .max(RETURN_CANDIDATE_QUERY_MAX * 2)
      .optional()
      .nullable()
      .transform((v) => (v ?? '').trim().slice(0, RETURN_CANDIDATE_QUERY_MAX)),
  });

  const prepare = z.object({ stopAt: z.enum(['staged']).optional() }).strict();

  const cancel = z.object({
    reason: trimmedOptional(RETURN_REASON_MAX),
    expectedRevision: z.number().int().min(0).optional().nullable(),
  });

  const dispositions = z.object({ lines: decisionLines });

  const steps = z
    .object({
      steps: z.array(z.enum(['approve', 'receive', 'process'])).min(1).max(3),
      expectedRevision: z.number().int().min(0).nullable().optional(),
      expectedPlanSeq: z.number().int().min(0).nullable().optional(),
      approve: approve.optional().nullable(),
      receiveNow: z.boolean().optional(),
      process: z.object({ lines: decisionLines }).optional().nullable(),
    })
    .superRefine((b, ctx) => {
      const order = ['approve', 'receive', 'process'];
      let last = -1;
      const seen = new Set<string>();
      for (const s of b.steps) {
        const i = order.indexOf(s);
        if (seen.has(s) || i <= last) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Steps run in the order approve, receive, process, once each.' });
          return;
        }
        seen.add(s);
        last = i;
      }
      if (b.steps.includes('approve') && !b.approve) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose what happens to every returned line.' });
      }
      if (b.steps.includes('approve') && (b.expectedRevision === undefined || b.expectedRevision === null)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Reload and try again.' });
      }
      if (b.receiveNow && b.steps.includes('receive')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Approve and receive is one step.' });
      }
    });

  return {
    create,
    requester,
    approve,
    deny,
    cancel,
    dispositions,
    steps,
    lineDecision,
    changeReplacement,
    cancelReplacement,
    releaseEarly,
    candidates,
    prepare,
    exchangeDecision,
  };
}

type ReturnSchemas = ReturnType<typeof buildSchemas>;
let built: ReturnSchemas | null = null;

/** The schemas, built on first use. */
export function returnSchemas(): ReturnSchemas {
  if (built === null) built = buildSchemas();
  return built;
}

export type ReturnCreateRequest = z.output<ReturnSchemas['create']>;
export type RequesterReturnRequest = z.output<ReturnSchemas['requester']>;
export type ReturnApproveDecision = z.output<ReturnSchemas['approve']>;
export type ReturnLineDecision = z.output<ReturnSchemas['lineDecision']>;
export type ReturnDenyRequest = z.output<ReturnSchemas['deny']>;
export type ReturnCancelRequest = z.output<ReturnSchemas['cancel']>;
export type ReturnDispositionsRequest = z.output<ReturnSchemas['dispositions']>;
export type ReturnStepsRequest = z.output<ReturnSchemas['steps']>;
export type ReturnExchangeDecision = z.output<ReturnSchemas['exchangeDecision']>;
export type ReturnChangeReplacementRequest = z.output<ReturnSchemas['changeReplacement']>;
export type ReturnCancelReplacementRequest = z.output<ReturnSchemas['cancelReplacement']>;
export type ReturnReleaseEarlyRequest = z.output<ReturnSchemas['releaseEarly']>;
export type ReturnCandidatesQuery = z.output<ReturnSchemas['candidates']>;
export type ReturnPrepareRequest = z.output<ReturnSchemas['prepare']>;

export type ReturnSchemaName = keyof Omit<ReturnSchemas, 'lineDecision' | 'exchangeDecision'>;

/** Parses a body; `{ ok: false, message }` carries the first issue's words. */
export function parseReturnBody<K extends ReturnSchemaName>(
  name: K,
  raw: unknown,
): { ok: true; value: z.output<ReturnSchemas[K]> } | { ok: false; message: string; issues: string[] } {
  const result = (returnSchemas()[name] as z.ZodTypeAny).safeParse(raw);
  if (result.success) return { ok: true, value: result.data as z.output<ReturnSchemas[K]> };
  const issues = result.error.issues.map((i) => i.message);
  return { ok: false, message: issues[0] ?? 'Check the return and try again.', issues };
}

// ── The case table shared with pgTAP ───────────────────────────────────────

export interface ReturnSchemaCase {
  /** The `-- case: <name>` marker in the pgTAP suite. */
  name: string;
  schema: ReturnSchemaName;
  input: unknown;
  /** Whether core accepts it (the database refuses every case listed). */
  coreAccepts: boolean;
}

const L1 = '00000000-0000-4000-8000-000000000001';
const L2 = '00000000-0000-4000-8000-000000000002';

/** Each body the database refuses, and what core says first. */
export function returnSchemaCases(): ReturnSchemaCase[] {
  return [
    { name: 'create_quantity_fractional', schema: 'create', input: { lines: [{ orderRequestLineId: L1, quantity: 1.5 }] }, coreAccepts: false },
    { name: 'create_quantity_zero', schema: 'create', input: { lines: [{ orderRequestLineId: L1, quantity: 0 }] }, coreAccepts: false },
    { name: 'create_quantity_over_cap', schema: 'create', input: { lines: [{ orderRequestLineId: L1, quantity: 10_001 }] }, coreAccepts: false },
    {
      name: 'create_too_many_lines',
      schema: 'create',
      input: {
        lines: Array.from({ length: 101 }, (_, i) => ({
          orderRequestLineId: `00000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}`,
          quantity: 1,
        })),
      },
      coreAccepts: false,
    },
    {
      name: 'create_duplicate_line',
      schema: 'create',
      input: { lines: [{ orderRequestLineId: L1, quantity: 1 }, { orderRequestLineId: L1, quantity: 1 }] },
      coreAccepts: false,
    },
    {
      // RX-2: "return 1, exchange for 2" (brief 4); the 0394 suite's
      // one-transaction proof (C5) uses this body.
      name: 'create_exchange_over_return',
      schema: 'create',
      input: { lines: [{ orderRequestLineId: L1, quantity: 1, exchange: { itemId: L2, quantity: 2 } }] },
      coreAccepts: false,
    },
    {
      name: 'create_exchange_no_item_no_note',
      schema: 'create',
      input: { lines: [{ orderRequestLineId: L1, quantity: 1, exchange: {} }] },
      coreAccepts: false,
    },
    {
      name: 'create_exchange_note_too_long',
      schema: 'create',
      input: { lines: [{ orderRequestLineId: L1, quantity: 1, exchange: { note: 'x'.repeat(501) } }] },
      coreAccepts: false,
    },
    {
      name: 'create_exchange_quantity_fractional',
      schema: 'create',
      input: { lines: [{ orderRequestLineId: L1, quantity: 2, exchange: { itemId: L2, quantity: 1.5 } }] },
      coreAccepts: false,
    },
    { name: 'approve_no_lines', schema: 'approve', input: { lines: [] }, coreAccepts: false },
    {
      name: 'approve_scrap_with_destination',
      schema: 'approve',
      input: { lines: [{ returnLineId: L1, disposition: 'scrap', restock: { target: 'original' } }] },
      coreAccepts: false,
    },
    {
      name: 'approve_unknown_target',
      schema: 'approve',
      input: { lines: [{ returnLineId: L1, disposition: 'restock', restock: { target: 'shelf' } }] },
      coreAccepts: false,
    },
    { name: 'deny_reason_blank', schema: 'deny', input: { reason: '   ' }, coreAccepts: false },
    { name: 'deny_reason_too_long', schema: 'deny', input: { reason: 'x'.repeat(1001) }, coreAccepts: false },
    {
      name: 'approve_exchange_decline_without_reason',
      schema: 'approve',
      input: {
        lines: [{ returnLineId: L1, disposition: 'restock' }],
        exchange: [{ exchangeLineId: L2, action: 'decline' }],
      },
      coreAccepts: false,
    },
    {
      name: 'approve_exchange_unknown_action',
      schema: 'approve',
      input: {
        lines: [{ returnLineId: L1, disposition: 'restock' }],
        exchange: [{ exchangeLineId: L2, action: 'swap' }],
      },
      coreAccepts: false,
    },
    {
      name: 'change_replacement_reason_blank',
      schema: 'changeReplacement',
      input: { expectedRevision: 1, lines: [], reason: '  ' },
      coreAccepts: false,
    },
    { name: 'release_reason_too_long', schema: 'releaseEarly', input: { reason: 'x'.repeat(501) }, coreAccepts: false },
    { name: 'cancel_replacement_reason_blank', schema: 'cancelReplacement', input: { reason: '' }, coreAccepts: false },
  ];
}
