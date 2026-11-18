// The SQL teardown.mjs selects with. Pure: no database, no imports, so the
// guard test can check the shapes it builds.

/** The seeder's shapes (seed.mjs). */
export const SLUG_RE = '^loadtest-[a-z0-9]{4,16}$';
export const EMAIL_RE = '^loadtest\\+[a-z0-9]{4,16}-[a-z-]+-[0-9]+@example\\.com$';
export const EMAIL_RE_JS = /^loadtest\+[a-z0-9]{4,16}-[a-z-]+-[0-9]+@example\.com$/;

/** A SQL string literal. */
export function sqlLit(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * A uuid[] literal. Empty is '{}'::uuid[], never array[null]: `x <> all(array[null])`
 * is NULL, which a NOT EXISTS reads as "no other organization" for everyone.
 */
export function uuidArray(ids) {
  for (const id of ids)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id)))
      throw new Error('not a uuid');
  return ids.length ? `array[${ids.map(sqlLit).join(',')}]::uuid[]` : `'{}'::uuid[]`;
}

/** Load-test organizations: the seeder's slug AND its name for that slug. */
export function seededOrgsSql() {
  return `select id || '|' || slug || '|' || name from public.organizations
           where slug::text ~ ${sqlLit(SLUG_RE)}
             and name = 'Load Test Org ' || substr(slug::text, 10)
           order by slug;`;
}

/**
 * Seeder-shaped accounts that belong to no organization except `orgIds`.
 * With no load-test organization, any membership at all keeps an account.
 */
export function seededUsersSql(orgIds) {
  return `select u.id || '|' || u.email from auth.users u
           where u.email ~ ${sqlLit(EMAIL_RE)}
             and not exists (select 1 from public.organization_members om
                              where om.user_id = u.id
                                and not (om.organization_id = any(${uuidArray(orgIds)})))
           order by u.email;`;
}
