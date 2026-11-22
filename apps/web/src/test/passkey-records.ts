/**
 * The answer PostgREST gives while the database does not have the passkey
 * records yet (migration 0475 not pushed): the recovery code's function is not
 * in its schema cache. Spread into a stub's results so a test of the recovery
 * code runs today's path (consume_mfa_recovery_code as the member), exactly as
 * before 0475; a test that gives the function its own answer overrides it.
 */
export const PASSKEY_RECOVERY_NOT_YET = {
  'rpc:consume_recovery_code_with_passkeys': {
    data: null,
    error: {
      code: 'PGRST202',
      message:
        'Could not find the function public.consume_recovery_code_with_passkeys(p_code, p_user_id) in the schema cache',
    },
  },
};

/**
 * A service client as it is while 0475 is not live: its
 * consume_recovery_code_with_passkeys answers PASSKEY_RECOVERY_NOT_YET (and is
 * not recorded), and every other call goes to `client` as it is. For the
 * recovery code's older suites, which pin today's path call by call.
 */
export function beforePasskeyRecords<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== 'rpc') return Reflect.get(target, prop, receiver);
      const rpc = Reflect.get(target, prop, receiver) as (
        fn: string,
        ...rest: unknown[]
      ) => unknown;
      return (fn: string, ...rest: unknown[]) =>
        fn === 'consume_recovery_code_with_passkeys'
          ? Promise.resolve(PASSKEY_RECOVERY_NOT_YET['rpc:consume_recovery_code_with_passkeys'])
          : rpc.call(target, fn, ...rest);
    },
  });
}
