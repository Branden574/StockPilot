/**
 * The AI chat's message limit, in one place (docket B76).
 *
 * The chat route refuses a longer message before any model call
 * (app/api/ai/chat/route.ts), and the web chat panel checks the same number
 * before it shows or sends a message, so a message the route would refuse
 * stays in the box with this sentence instead of being cleared.
 *
 * A plain module (no 'server-only'): the panel is a client component.
 */
export const CHAT_MESSAGE_MAX_CHARS = 2000;

/** The route's answer, and the panel's note, for a longer message. The route
 *  accepts exactly CHAT_MESSAGE_MAX_CHARS, hence "or fewer". */
export const CHAT_MESSAGE_TOO_LONG = `Your message is too long. Keep it to ${CHAT_MESSAGE_MAX_CHARS.toLocaleString('en-US')} characters or fewer.`;
