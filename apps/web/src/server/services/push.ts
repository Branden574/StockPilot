import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { reportError } from '@/lib/error-reporter';

/**
 * Server-side push notification sender.
 *
 * Wraps Expo's Push API (https://exp.host/--/api/v2/push/send) and is
 * intended to be the single bridge between a `notifications` table
 * insert and the user's device. Token rows live in `push_tokens`
 * (one row per device per user); we batch all of a user's tokens into
 * one Expo Push API call, then mark failures so dead tokens get
 * cleaned up next pass.
 *
 * This file is server-only — it uses the service role client to read
 * `push_tokens` because the Expo Push API has no concept of an
 * organization context and we want the same path to work from a
 * webhook, a cron, or an authenticated request.
 *
 * Wire into the notification creation flow by calling
 * `notifyUser({ userId, title, body, link })` right after the
 * `notifications` table insert. The function never throws — every
 * delivery failure is reported via reportError and swallowed so the
 * caller's primary write path (PO approval, order request, etc.)
 * isn't held hostage by Expo being slow or down.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const MAX_BATCH_SIZE = 100; // Expo accepts up to 100 messages per request.

export interface PushPayload {
  /** Target user — we look up all their registered devices. */
  userId: string;
  /** Push title — short, shows on the lock screen. */
  title: string;
  /** Body text — second line, shows below title. */
  body?: string;
  /** Optional deep link. Tap handler in mobile is host-allowlisted. */
  link?: string;
  /** Arbitrary structured data attached to the notification. */
  data?: Record<string, unknown>;
  /** ios.sound default; null silences. */
  sound?: 'default' | null;
  /** Bumps the app badge count if set. */
  badge?: number;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface ExpoResponse {
  data?: ExpoTicket[];
  errors?: Array<{ code?: string; message: string }>;
}

/**
 * Sends an Expo push to every registered device for the user. Returns
 * the number of devices the push was accepted for. Failures are
 * logged but never thrown.
 */
export async function notifyUser(payload: PushPayload): Promise<number> {
  if (!payload.userId) return 0;
  if (!payload.title) return 0;

  try {
    const admin = createAdminClient();
    const { data: tokens, error } = await admin
      .from('push_tokens')
      .select('id, token, platform')
      .eq('user_id', payload.userId);
    if (error) {
      void reportError(new Error(error.message), {
        tag: 'push.fetch_tokens',
        extra: { userId: payload.userId },
      });
      return 0;
    }
    if (!tokens || tokens.length === 0) return 0;

    let delivered = 0;
    for (let i = 0; i < tokens.length; i += MAX_BATCH_SIZE) {
      const batch = tokens.slice(i, i + MAX_BATCH_SIZE);
      const messages = batch.map((t) => ({
        to: t.token,
        sound: payload.sound === null ? undefined : 'default',
        title: payload.title,
        body: payload.body ?? '',
        data: { ...(payload.data ?? {}), link: payload.link ?? null },
        ...(payload.badge != null ? { badge: payload.badge } : null),
      }));

      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messages),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        void reportError(new Error(`Expo push ${res.status}: ${text}`), {
          tag: 'push.expo_http',
          extra: { userId: payload.userId, count: batch.length },
        });
        continue;
      }

      const json = (await res.json()) as ExpoResponse;
      if (json.errors && json.errors.length > 0) {
        for (const e of json.errors) {
          void reportError(new Error(e.message), {
            tag: 'push.expo_response',
            extra: { userId: payload.userId, code: e.code ?? 'unknown' },
          });
        }
      }
      const tickets = json.data ?? [];
      for (let idx = 0; idx < tickets.length; idx++) {
        const ticket = tickets[idx];
        const t = batch[idx];
        if (!ticket || !t) continue;
        if (ticket.status === 'ok') {
          delivered += 1;
        } else if (ticket.details?.error === 'DeviceNotRegistered') {
          // Stale token — remove so we don't keep re-trying. The trailing
          // .then() is REQUIRED: a supabase-js builder is lazy and never sends
          // the request unless awaited or `.then`ed (`void builder` is a no-op).
          void admin.from('push_tokens').delete().eq('id', t.id).then(
            () => {},
            () => {},
          );
        } else {
          void reportError(new Error(ticket.message ?? 'push ticket failed'), {
            tag: 'push.ticket',
            extra: {
              userId: payload.userId,
              code: ticket.details?.error ?? 'unknown',
            },
          });
        }
      }
    }
    return delivered;
  } catch (err) {
    void reportError(err instanceof Error ? err : new Error(String(err)), {
      tag: 'push.notify_user_uncaught',
      extra: { userId: payload.userId },
    });
    return 0;
  }
}
