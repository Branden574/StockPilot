/**
 * True when `value` holds an array longer than `max` anywhere in it: at the
 * top level, inside an object, or inside an element of another array.
 *
 * WHY: a stopgap for GHSA-mrhx-c7xc-m3w5. zod below 4.6.6 builds one
 * validation issue for every failing array element, with no cap, and this app
 * runs zod 3.25.76, for which there is no fix. In zod 3, `.max()` does not stop
 * it: ZodArray._parse (node_modules/zod/v3/types.js) records the too_big issue,
 * marks the result dirty and then still parses every element. Measured on
 * 3.25.76, a 1 MB body whose `lines` is 500,000 numbers makes about 145 MB of
 * issue objects before the route can answer 400.
 *
 * So a route that parses an unauthenticated body calls this on the decoded
 * JSON BEFORE safeParse, with `max` set to the longest array its schema
 * accepts anywhere in the body, and refuses the body when it answers true.
 * A body it refuses either has an array longer than any field of the schema
 * takes, which zod refuses too (the words of the 400 can differ when zod's
 * first issue is about another field), or has one under a key the schema
 * would have stripped and accepted. So a route uses it only where its own
 * clients never send an array longer than `max`.
 *
 * It costs one pass over the value JSON.parse already built, and less when the
 * body is refused: an array's length is checked before any of its elements is
 * visited. It walks with its own stack, not recursion, so a deeply nested body
 * cannot overflow the call stack.
 */
export function hasArrayLongerThan(value: unknown, max: number): boolean {
  const pending: object[] = [];
  if (value !== null && typeof value === 'object') pending.push(value);
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (Array.isArray(node)) {
      if (node.length > max) return true;
      for (const element of node) {
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
