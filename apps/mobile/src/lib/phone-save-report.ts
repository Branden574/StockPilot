import { outboxRefusalSentence } from './outbox-scope';
import { Sentry } from './sentry';

/**
 * A change the phone could not save on itself, reported to the team (docket
 * B10 review).
 *
 * The count screen, the count scanner and Distribute catch a failed
 * updateLocalLine or enqueue so that they can say why. Before, the failure
 * escaped as an unhandled promise rejection, which Sentry reports by default
 * (@sentry/react-native's ReactNativeErrorHandlers tracks unhandled
 * rejections), so a failing store on a phone (SQLITE_FULL, SQLITE_IOERR)
 * reached the team. Caught, it reached only the person. It is reported here.
 *
 * The outbox's two refusals (no account to queue the change for, or the
 * workspace still loading after a different account signed in) are expected
 * and retryable: said to the person, never reported.
 *
 * `area` names the save, as the web's error reporter tags do
 * ('cycle-count.save', 'cycle-count.scan', 'bundle.distribute.queue').
 */
export function reportPhoneSaveFailure(e: unknown, area: string): void {
  if (outboxRefusalSentence(e) !== null) return;
  console.warn(`[${area}] the phone could not save`, e);
  Sentry.captureException(e, { tags: { area } });
}
