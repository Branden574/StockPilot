import { z } from 'zod';

/**
 * The most list entries one request may carry in total: every element of every
 * list, at any depth (lists inside objects and inside other lists all count).
 *
 * Each list has its own .max() (request-limits.ts), but a list inside a list
 * multiplies: receipt lines times the serial numbers on each. This total holds
 * the whole request to one budget.
 *
 * A purchase order, recurring order, import approval or receipt at
 * MAX_PO_LINES (50,000) lines is 50,000 entries with nothing nested: the
 * budget is four times that. A receipt's serial numbers are one per accepted
 * unit; the web form sends them through a Server Action, whose body Next.js
 * limits to 1 MB, so even serials of three characters stay under 175,000
 * entries. The phone sends no serials or lots.
 */
export const REQUEST_ENTRY_BUDGET = 200_000;

/** The plain answer for a request over the budget. */
export const ENTRY_BUDGET_MESSAGE = 'This request has too many entries.';

/**
 * True when `value` holds more than `budget` list entries in total, counting
 * every element of every array at any depth. It also answers true past
 * `budget` objects and arrays visited, so a shape that shares or repeats
 * references cannot keep it walking.
 *
 * Iterative, with its own stack: a deeply nested body cannot overflow the call
 * stack. It stops the moment either count passes the budget, and an array's
 * length is counted before any of its elements is visited.
 */
export function exceedsEntryBudget(value: unknown, budget: number = REQUEST_ENTRY_BUDGET): boolean {
  let entries = 0;
  let nodes = 0;
  const pending: object[] = [];
  if (value !== null && typeof value === 'object') pending.push(value);
  while (pending.length > 0) {
    const node = pending.pop()!;
    nodes += 1;
    if (nodes > budget) return true;
    if (Array.isArray(node)) {
      entries += node.length;
      if (entries > budget) return true;
      for (let i = 0; i < node.length; i += 1) {
        const element: unknown = node[i];
        if (element !== null && typeof element === 'object') pending.push(element);
      }
      continue;
    }
    for (const key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      const child = (node as Record<string, unknown>)[key];
      if (child !== null && typeof child === 'object') pending.push(child);
    }
  }
  return false;
}

/**
 * `schema`, behind the request entry budget: input over REQUEST_ENTRY_BUDGET
 * is refused with one issue (ENTRY_BUDGET_MESSAGE) before `schema` parses
 * anything. Within the budget it is exactly `schema`.
 *
 * Every schema with a list inside a list goes through here
 * (apps/web/src/test/zod-array-bounds.guard.test.ts).
 */
export function withEntryBudget<T extends z.ZodTypeAny>(
  schema: T,
  budget: number = REQUEST_ENTRY_BUDGET,
): z.ZodEffects<T, z.output<T>, z.input<T>> {
  const gated = z.preprocess((input, ctx) => {
    if (exceedsEntryBudget(input, budget)) {
      // A fatal issue: zod answers here and never runs `schema`.
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: ENTRY_BUDGET_MESSAGE, fatal: true });
    }
    return input;
  }, schema);
  // The gate takes what the schema takes, so its input is the schema's input.
  return gated as unknown as z.ZodEffects<T, z.output<T>, z.input<T>>;
}
