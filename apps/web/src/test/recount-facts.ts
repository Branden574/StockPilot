/**
 * The answer PostgREST gives while the database does not have
 * exception_recount_facts yet (migration 0460 not pushed): the function is not
 * in its schema cache. Spread first into a stub's results so a test reads the
 * Exception Center's counts directly, exactly as before 0460; a test that
 * gives the function its own answer overrides it.
 */
export const RECOUNT_FACTS_NOT_YET = {
  'rpc:exception_recount_facts': {
    data: null,
    error: {
      code: 'PGRST202',
      message:
        'Could not find the function public.exception_recount_facts(p_exception_ids, p_org) in the schema cache',
    },
  },
};
