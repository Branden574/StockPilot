/**
 * The customer's names, for the guards that keep them out of the repository:
 * customer-addresses.guard.test.ts (docket S15, addresses at its mail domains
 * anywhere in the tracked tree) and customer-names-in-copy.guard.test.ts
 * (docket S17, its names in the copy people see). Test support: only tests
 * import it.
 *
 * Each name is held as its pieces in order, and a piece that would otherwise
 * hold a whole name is joined from smaller ones at run time, so no literal in
 * this file holds a name and a search of the repository for one never lands
 * here. The guards build every spelling they test from these pieces.
 */

/**
 * The customer's names, each as its pieces in order. 1-6 are the first
 * labels of its mail domains, in the order of CUSTOMER_DOMAINS below; 7-10
 * name its warehouse and a site. No supplier is listed.
 */
export const CUSTOMER_NAMES: readonly (readonly string[])[] = [
  // 1. The full name, in three pieces.
  ['learn', '4', 'life'],
  // 2. The abbreviation with its region word.
  ['l4' + 'l', 'north'],
  // 3. The abbreviation.
  ['l4' + 'l'],
  // 4 and 5. The two site names.
  ['cv', 'west'],
  ['cv', 'south'],
  // 6. The acronym.
  ['ll' + 'ac'],
  // 7. The warehouse code: its letters, then its digit.
  ['dc', '4'],
  // 8. The same code with its digit as a Roman numeral.
  ['dc', 'iv'],
  // 9. The three-letter site code.
  ['cv' + 'w'],
  // 10. The warehouse's city.
  ['fres' + 'no'],
];

// The last label of each mail domain, for names 1-6 in order.
const DOMAIN_ENDINGS = ['org', 'com', 'org', 'org', 'org', 'org'] as const;

/**
 * The customer's mail domains: names 1-6 with their pieces joined, each with
 * its last label, in the order S15's guard has always read them.
 */
export const CUSTOMER_DOMAINS: readonly string[] = DOMAIN_ENDINGS.map(
  (ending, i) => `${CUSTOMER_NAMES[i]!.join('')}.${ending}`,
);
