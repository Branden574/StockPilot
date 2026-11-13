/**
 * Text for a Slack or Teams message (docket S56).
 *
 * Slack and Teams read a message's text as markup. Text that was typed in the
 * app, or that came from a request or an error, is shown as text: this module
 * escapes it for the channel it is going to. One rule, used where the chat
 * text is built: the organization's alert cards
 * (server/services/integration-events.ts) and the operator's error channel
 * (error-reporter-core.ts).
 *
 * What is escaped, by channel:
 *   slack   `&`, `<` and `>` become `&amp;`, `&lt;` and `&gt;` (Slack's
 *           documented rule for message text).
 *   teams   the same three entities, then a backslash before `\`, `[` and
 *           `]`, in one pass, so a typed backslash cannot cancel an added one.
 *   plain   nothing.
 * Not escaped in either channel: `*`, `_`, `~`, the backtick and `#`. They
 * only change formatting, Slack has no escape for them, and `#` and `_` are
 * common in item names, SKUs and key prefixes. The one exception is a
 * backtick in or before code (chatBlock, chatCode below).
 *
 * Isomorphic and with NO imports: error-reporter-core.ts reaches browser
 * bundles, so anything imported here would be bundled for the browser too.
 */

export type ChatChannel = 'slack' | 'teams' | 'plain';

/** The longest a single card field is shown, in code points. */
export const CHAT_FIELD_MAX = 300;

/** C0 and C1 control characters and the two Unicode line separators. */
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
/** The same, keeping the line feed and the tab. */
const CONTROL_KEEPING_LINES = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g;
/**
 * Characters that take no space or change the direction text is read in:
 * zero-width space, word joiner, byte order mark, and the bidirectional
 * embedding, override and isolate controls. The zero-width joiner and
 * non-joiner are kept: emoji and some scripts need them.
 */
const INVISIBLE = /[\u200B\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g;

function entities(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Prose for `channel`. */
function escapeFor(text: string, channel: ChatChannel): string {
  if (channel === 'plain') return text;
  const escaped = entities(text);
  return channel === 'teams' ? escaped.replace(/[\\[\]]/g, '\\$&') : escaped;
}

/** Line endings as `\n`; other control characters as a space; no invisible characters. */
function cleanKeepingLines(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_KEEPING_LINES, ' ').replace(INVISIBLE, '');
}

/**
 * One field of a card: on one line, at most `max` code points (with '…' when
 * cut), escaped for `channel`. Escaped last, so an entity is never cut. Gives
 * '' when nothing is left to show.
 */
export function chatField(
  value: string,
  channel: ChatChannel,
  max: number = CHAT_FIELD_MAX,
): string {
  const oneLine = value.replace(CONTROL, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  const points = Array.from(oneLine);
  const cut = points.length > max ? `${points.slice(0, max).join('')}…` : oneLine;
  return escapeFor(cut, channel);
}

/** Every backtick as the modifier letter grave accent (U+02CB), which looks alike. */
function withoutBackticks(text: string): string {
  return text.replace(/`/g, '\u02CB');
}

/**
 * A message of several lines that code follows in the same text (the
 * operator's error report: message, then a digest in a code span and a stack
 * in a code fence). Kept whole: its line breaks, its tabs and its length stay
 * as they are. Escaped for `channel`, and its backticks are replaced, because
 * a backtick here would pair with the delimiters of the code after it and
 * leave that code's text outside its span or fence.
 */
export function chatBlock(text: string, channel: ChatChannel): string {
  return escapeFor(withoutBackticks(cleanKeepingLines(text)), channel);
}

/**
 * Text that goes inside a code span or a code fence. Its backticks are
 * replaced, so the text cannot end the span or the fence. Slack still reads
 * entities inside code, so it gets them; inside code Teams shows a backslash
 * and an entity as typed, so it gets neither.
 */
export function chatCode(text: string, channel: ChatChannel): string {
  const safe = withoutBackticks(cleanKeepingLines(text));
  return channel === 'slack' ? entities(safe) : safe;
}
