/**
 * THE ONE MAILTO RULE FOR STORED ADDRESSES (web and phone).
 *
 * A screen that shows an email address it read from the database makes a
 * mailto: link from it only when the link cannot open anything the screen
 * does not show. Before, the phone's Team and Users cards opened
 * `mailto:${email}` and the web's support triage built
 * `mailto:${ticket.email}?subject=...` from the stored text, so an address
 * such as "a@b.com?bcc=x@y.z" opened a message with a hidden copy to someone
 * the screen never names, and an address with invisible or look-alike
 * characters opened a message to an address other than the one shown. The
 * redesign fixed the supplier cards this way (P5.8, phone and web); this is
 * that rule, moved here so every screen on both apps uses one copy.
 *
 * Plain is an allow-list, so anything not named here fails closed: the text
 * without its outer spaces is one '@' between a name and a domain, both ASCII
 * only. The name is dot-separated runs of letters, digits and
 * ! $ ' * + = ^ _ ` { | } ~ - (never '?', '&', ',', ';', '#', '%', '/',
 * quotes, brackets, colons or spaces, which make a mailto: link do more than
 * address one person). The domain is two or more dot-separated labels of
 * letters, digits and inner hyphens. The name is at most 64 characters, each
 * domain label at most 63 and the whole address at most 254 (RFC 5321). So no
 * control, invisible (a zero-width joiner, a tag character, a direction
 * mark), look-alike (Cyrillic, fullwidth) or other non-ASCII character, and no
 * over-long address, can reach the link. The name and the domain go out
 * percent-encoded on either side of a literal '@' (RFC 6068: the separating
 * '@' stays literal; an encoded %40 would be a character inside the name).
 *
 * A screen shows the stored text either way, and makes it a link only when
 * this returns one.
 */
export function plainAddressMailtoUrl(
  email: string | null | undefined,
  opts: { subject?: string | null } = {},
): string | null {
  const address = (email ?? '').trim();
  if (address.length > 254) return null;
  const parts = address.split('@');
  if (parts.length !== 2) return null;
  const [name = '', domain = ''] = parts;
  if (!NAME.test(name) || name.length > 64) return null;
  if (!DOMAIN.test(domain)) return null;
  const to = `mailto:${encodeURIComponent(name)}@${encodeURIComponent(domain)}`;
  const subject = mailSubject(opts.subject);
  return subject ? `${to}?subject=${encodeURIComponent(subject)}` : to;
}

const ATOM = "[A-Za-z0-9!$'*+=^_`{|}~-]+";
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const NAME = new RegExp(`^${ATOM}(?:\\.${ATOM})*$`);
const DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

/**
 * Line breaks, other control characters and invisible format characters
 * (zero-width, direction marks, the byte-order mark, tag characters). A
 * subject is one line: a decoded line break would start a new header in a
 * mail program that copies the subject into a raw message, and an invisible
 * character only hides text. Spelled as ranges, not a Unicode property escape,
 * so every JavaScript engine the phone runs parses it.
 */
const SUBJECT_UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff]|\udb40[\udc00-\udc7f]/g;

/** A UTF-16 code unit of a surrogate pair standing on its own. */
function isLoneSurrogate(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return ch.length === 1 && code >= 0xd800 && code <= 0xdfff;
}

/**
 * The subject on one line, without control or invisible characters, at most
 * 200 characters (the support ticket's own subject limit), or null. Cut by
 * whole characters, never inside a surrogate pair, and with any lone
 * surrogate dropped: encodeURIComponent throws on one, which would take the
 * whole screen down instead of leaving one link out.
 */
function mailSubject(subject: string | null | undefined): string | null {
  const whole = Array.from(subject ?? '')
    .filter((ch) => !isLoneSurrogate(ch))
    .join('');
  const oneLine = whole.replace(SUBJECT_UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  const cut = Array.from(oneLine).slice(0, 200).join('').trim();
  return cut || null;
}
