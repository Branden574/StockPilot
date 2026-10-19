/**
 * The mailto: link for a supplier's email, or null when the stored text is not
 * one plain address (the table then shows the text, not a link).
 *
 * Before, the Suppliers table built `mailto:${email}` from the stored text, so
 * an email such as "a@b.com?bcc=x@y.z" opened a message copied to someone the
 * row never names (the zod check in the suppliers service does not stop a
 * direct table write). This is the phone's fail-closed rule
 * (apps/mobile/src/screens/suppliers.tsx, P5.8) on the web.
 *
 * Plain is an allow-list, so anything not named here fails closed: the text
 * without its outer spaces is one '@' between a name and a domain, both ASCII
 * only. The name is dot-separated runs of letters, digits and
 * ! $ ' * + = ^ _ ` { | } ~ - (never '?', '&', ',', ';', '#', '%', '/',
 * quotes, brackets, colons or spaces, which make a mailto: link do more than
 * address one person). The domain is two or more dot-separated labels of
 * letters, digits and inner hyphens. The name is at most 64 characters, each
 * domain label at most 63 and the whole address at most 254 (RFC 5321). So no
 * control, invisible, look-alike or other non-ASCII character, and no
 * over-long address, can reach the link. The name and the domain go out
 * percent-encoded on either side of a literal '@' (RFC 6068).
 */
export function supplierMailtoUrl(email: string | null | undefined): string | null {
  const address = (email ?? '').trim();
  if (address.length > 254) return null;
  const parts = address.split('@');
  if (parts.length !== 2) return null;
  const [name = '', domain = ''] = parts;
  const atom = "[A-Za-z0-9!$'*+=^_`{|}~-]+";
  const label = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
  if (!new RegExp(`^${atom}(?:\\.${atom})*$`).test(name) || name.length > 64) return null;
  if (!new RegExp(`^${label}(?:\\.${label})+$`).test(domain)) return null;
  return `mailto:${encodeURIComponent(name)}@${encodeURIComponent(domain)}`;
}
