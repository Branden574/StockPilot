/**
 * What a form sends for an optional text field, on create and on edit.
 *
 * - Text is sent as it is.
 * - An empty field whose record had text (the person emptied it on an edit) is
 *   sent as '', which the update schemas accept and the services store as null.
 * - An empty field whose record had none, or a new record (`before` is
 *   undefined), is left out, so the field is not written.
 */
export function editedOptionalText(
  value: string | undefined,
  before: string | null | undefined,
): string | undefined {
  if (value) return value;
  return before ? '' : undefined;
}
