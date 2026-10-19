/**
 * Links on a warehouse's page: "New order from here", and the contact lines
 * (Address & contact, and the manager's email). Ported from the phone Suppliers screen (P5.8,
 * `supplierTelUrl` / `supplierMailtoUrl`), so one plain number or address
 * becomes a link and anything else is shown as the stored words with no link.
 *
 * Before, the page built `tel:${contact_phone}` and `mailto:${email}` from the
 * stored text, so letters, '*', '#', ',' or ';' reached the dialler ("555-1234
 * or 555-9999" dialled one long number the page never shows), and an address
 * such as "a@b.com?bcc=x@y.z" opened a message copied to someone the page
 * never names. The words on the page are unchanged either way.
 */

/**
 * The tel: link for a stored phone, or null when the text is not one plain
 * phone number. Plain is an allow-list that fails closed, the same rule as the
 * phone's supplier card (`supplierTelUrl` in apps/mobile/src/screens/
 * suppliers.tsx, after its verify fixes). The text, with its outer spaces
 * trimmed and any non-breaking space read as a space, holds only ASCII digits,
 * spaces, dots, dashes and round brackets, with at most one '+', only at the
 * start and followed straight away by a digit from 1 to 9. Without a '+', and
 * after '+1', the text must be grouped as one North American number:
 * 555-0100, (555) 010-0100, (555)-010-0100, 555.010.0100 or 1-555-010-0100,
 * never a number with a trailing group such as '555-0100 123'. After '+7' it
 * is 11 digits. After any other '+' it is 8 to 15 digits (E.164), and a
 * bracketed trunk 0 right after the country code, as in '+44 (0)20 7946
 * 0958', is not dialled; a bracketed 0 anywhere else, or written any other
 * way, is shown as text. A number written with a dialling prefix such as 011
 * instead of '+' is shown as text. So an extension, a second number, letters,
 * a service code ('*', '#'), a pause (',', ';') or a parameter never becomes
 * a link. Only the digits and the leading '+' reach the dialler.
 */
export function warehouseTelUrl(phone: string | null | undefined): string | null {
  const text = (phone ?? '').replace(/[\u00a0\u2007\u202f]/g, ' ').trim();
  // A '+' must be followed straight away by a country code's first digit, so
  // '+ 1 ...' or '+(1) ...' cannot step around the +1 rule below.
  if (!/^(?:\+(?=[1-9]))?[0-9 .()-]+$/.test(text)) return null;
  const digits = (t: string) => t.replace(/[^0-9]/g, '');
  // North American shapes: a 7-digit local number, a 10-digit one with its
  // area code, and the 10-digit one after a leading 1 or +1.
  const local = '[0-9]{3}[ .-]?[0-9]{4}';
  const withArea = `(?:\\([0-9]{3}\\)[ .-]?|[0-9]{3}[ .-]?)${local}`;
  if (!text.startsWith('+')) {
    const northAmerican = new RegExp(`^(?:${local}|${withArea}|1[ .-]?${withArea})$`);
    return northAmerican.test(text) ? `tel:${digits(text)}` : null;
  }
  if (text.startsWith('+1')) {
    return new RegExp(`^\\+1[ .-]?${withArea}$`).test(text) ? `tel:+${digits(text)}` : null;
  }
  // A bracketed trunk 0 is dropped only straight after the real country code.
  // Country codes are prefix-free (ITU-T E.164): 7 is one digit, the codes
  // below are two, every other one (1 is handled above) is three.
  const countryCodeLength = (d: string) =>
    d.startsWith('7')
      ? 1
      : /^(?:2[07]|3[0-469]|4[013-9]|5[1-8]|6[0-6]|8[1246]|9[0-58])/.test(d)
        ? 2
        : 3;
  const trunk = /^\+([0-9]{1,3})[ .-]*\(0\)/.exec(text);
  const code = trunk?.[1];
  if (trunk && code !== undefined && code.length !== countryCodeLength(code)) return null;
  const rest = trunk && code !== undefined ? `+${code} ${text.slice(trunk[0].length)}` : text;
  // Any other bracket holding only zeros is a trunk written another way: fail
  // closed rather than dial it.
  if (/\([ .-]*0[0 .-]*\)/.test(rest)) return null;
  const dialled = digits(rest);
  if (dialled.startsWith('7')) return dialled.length === 11 ? `tel:+${dialled}` : null;
  return dialled.length >= 8 && dialled.length <= 15 ? `tel:+${dialled}` : null;
}

/**
 * The mailto: link for a stored email, or null when the text is not one plain
 * address. Plain is an allow-list, so anything not named here fails closed:
 * the text without its outer spaces is one '@' between a name and a domain,
 * both ASCII only. The name is dot-separated runs of letters, digits and
 * ! $ ' * + = ^ _ ` { | } ~ - (never '?', '&', ',', ';', '#', '%', '/',
 * quotes, brackets, colons or spaces, which make a mailto: link do more than
 * address one person). The domain is two or more dot-separated labels of
 * letters, digits and inner hyphens. The name is at most 64 characters, each
 * domain label at most 63 and the whole address at most 254 (RFC 5321). The
 * name and the domain go out percent-encoded on either side of a literal '@'
 * (RFC 6068).
 */
export function warehouseMailtoUrl(email: string | null | undefined): string | null {
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

/**
 * "New order from here": the storefront with this warehouse chosen. The
 * storefront reads `warehouseId` (orders/new/page.tsx); it never read the
 * `warehouse` this link used to send, so the warehouse was not preselected
 * (CONFLICTS D2).
 */
export function newOrderFromWarehouseHref(warehouseId: string): string {
  return `/dashboard/orders/new?warehouseId=${encodeURIComponent(warehouseId)}`;
}
