import { z } from 'zod';

import { formatLimit } from './request-limits';

/** True when `value` has more than `max` enumerable keys; stops counting at max + 1. */
function hasMoreKeysThan(value: object, max: number): boolean {
  let count = 0;
  for (const _key in value) {
    count += 1;
    if (count > max) return true;
  }
  return false;
}

/**
 * z.record(key, value) with an upper bound on its keys.
 *
 * zod has no .max() for a keyed object. This refuses one with more than
 * `maxKeys` keys with a single issue, before any key or value is validated;
 * within the bound it is exactly z.record(key, value). Anything that is not a
 * plain object goes on to z.record, which refuses it as before.
 *
 * Every z.record in source goes through here unless no key and no value can
 * fail (apps/web/src/test/zod-array-bounds.guard.test.ts).
 */
export function boundedRecord<Key extends z.KeySchema, Value extends z.ZodTypeAny>(
  key: Key,
  value: Value,
  maxKeys: number,
  message = `Send at most ${formatLimit(maxKeys)} ${maxKeys === 1 ? 'entry' : 'entries'}.`,
): z.ZodEffects<
  z.ZodRecord<Key, Value>,
  z.output<z.ZodRecord<Key, Value>>,
  z.input<z.ZodRecord<Key, Value>>
> {
  const record = z.record(key, value);
  const gated = z.preprocess((input, ctx) => {
    if (
      input !== null &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      hasMoreKeysThan(input, maxKeys)
    ) {
      // A fatal issue: zod answers here and never runs the record.
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, fatal: true });
    }
    return input;
  }, record);
  // The gate takes what the record takes, so its input is the record's input.
  return gated as unknown as z.ZodEffects<
    z.ZodRecord<Key, Value>,
    z.output<z.ZodRecord<Key, Value>>,
    z.input<z.ZodRecord<Key, Value>>
  >;
}
