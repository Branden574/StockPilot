import { outboxRefusalSentence } from './outbox-scope';

/**
 * WHAT A COUNT SCREEN SAYS WHEN THE PHONE DID NOT SAVE A COUNT, OR DID NOT
 * CLEAR ONE (docket B10).
 *
 * updateLocalLine (cycle-count-cache.ts) saves a count on the phone and queues
 * it for the server in one step, and throws when it cannot: the outbox refused
 * it (no account to queue it for, or the workspace still loading: the saved
 * one is another account's, or an older build's not yet recorded as this
 * account's; outbox-scope.ts), or the phone's own store failed. Nothing is saved either way. The count screen and the count scanner
 * let that throw escape as an unhandled rejection, so nothing was said: the
 * count screen kept the number in its box as if it were saved, and the
 * scanner stayed busy and ignored every scan after it. Each now says why, in
 * the outbox's own sentence. (The AI shelf scan copies a count the server
 * already recorded with mirrorRecordedCount, which queues nothing and is
 * never refused.)
 *
 * An emptied box clears the line's saved count (B4a) with clearLocalLine,
 * which queues the clear through the same writer, so it is refused in the
 * same cases and said the same way.
 */

/** The phone's own store failed. Its error text is not written for people. */
export const COUNT_NOT_SAVED_ON_PHONE = 'This phone could not save the count. Try again.';

/** The alert for a count updateLocalLine did not save. */
export function countNotSavedAlert(e: unknown): { title: string; message: string } {
  return {
    title: 'Count not saved',
    message: outboxRefusalSentence(e) ?? COUNT_NOT_SAVED_ON_PHONE,
  };
}

/** The phone's own store failed to clear a count. */
export const COUNT_NOT_CLEARED_ON_PHONE = 'This phone could not clear the count. Try again.';

/** The alert for an emptied box whose count clearLocalLine did not clear. */
export function countNotClearedAlert(e: unknown): { title: string; message: string } {
  return {
    title: 'Count not cleared',
    message: outboxRefusalSentence(e) ?? COUNT_NOT_CLEARED_ON_PHONE,
  };
}

/**
 * The alert for a count updateLocalLine answered null for (S75): the line is
 * no longer in the copy of the count on this phone (a pull removed it, the
 * count was posted or cancelled, or it is no longer sent to this member), so
 * nothing was saved or queued. The screens never mark such a line saved; on
 * OK they load the count again, or close it when it is no longer on this
 * phone or open to the member.
 */
export const COUNT_LINE_NOT_SAVED: { title: string; message: string } = {
  title: 'Count not saved',
  message:
    'This line is no longer in the count saved on this phone, so this number was not saved. Tap OK to load the count again, or to close it if it is no longer open to you.',
};

/** What a count screen's alerts ask Alert.alert for. */
type ShowAlert = (
  title: string,
  message: string,
  buttons: { text: string; onPress: () => void }[],
  options: { cancelable: boolean; onDismiss: () => void },
) => void;

/**
 * One alert at a time for one screen: never two at once, so its button is
 * answered once, and nothing once the screen has closed (an answer still to
 * come then does nothing). The count scanners say why a count cannot be
 * opened through one: the read runs again each time the account, workspace
 * or access changes, and each refusal used to put up its own alert.
 */
export interface OneAlert {
  /** Says it, unless one is already up or the screen has closed. True when said. */
  say(title: string, message: string, onAnswered: () => void): boolean;
  /** The screen closed: nothing more is said, and an answer still to come does nothing. */
  close(): void;
}

export function createOneAlert(show: ShowAlert): OneAlert {
  let open = false;
  let closed = false;
  return {
    say(title, message, onAnswered) {
      if (open || closed) return false;
      open = true;
      // OK, or a dismissal on Android: answered once.
      const answer = () => {
        if (!open) return;
        open = false;
        if (!closed) onAnswered();
      };
      show(title, message, [{ text: 'OK', onPress: answer }], { cancelable: true, onDismiss: answer });
      return true;
    },
    close() {
      closed = true;
    },
  };
}

/**
 * "Count not saved" for a line no longer on the phone (COUNT_LINE_NOT_SAVED),
 * for one count screen: never two at once, so OK is answered once (it loads
 * the count again or leaves the screen, once), and nothing once the screen
 * has closed (the count screen's unmount flushes its waiting saves, whose
 * answers land after it has gone).
 */
export interface LineGoneNotice {
  /** Says it, unless it is already up or the screen has closed. True when said. */
  say(onAnswered: () => void): boolean;
  /** The screen closed: nothing more is said, and an answer still to come does nothing. */
  close(): void;
}

export function createLineGoneNotice(show: ShowAlert): LineGoneNotice {
  const one = createOneAlert(show);
  return {
    say: (onAnswered) => one.say(COUNT_LINE_NOT_SAVED.title, COUNT_LINE_NOT_SAVED.message, onAnswered),
    close: () => one.close(),
  };
}
