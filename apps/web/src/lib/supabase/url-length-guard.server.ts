import 'server-only';

import { reportError } from '@/lib/error-reporter';

import { makeGuardedSupabaseFetch } from './url-length-guard';

/**
 * The server Supabase clients' URL-length guard (admin.ts, server.ts and the
 * Bearer data client in lib/auth/api-context.ts): the same check as the
 * browser client's (url-length-guard.ts), reporting through the server
 * reportError, which keeps the report's POST alive past the response. A
 * request that trips the guard is often a route's last read, and its report
 * was otherwise left in flight as the route answered.
 */
export const guardedServerSupabaseFetch = makeGuardedSupabaseFetch(reportError);
