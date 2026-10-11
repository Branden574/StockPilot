import * as React from 'react';

import { requesterLoadedSheet, type RequesterSheetLoad } from './requester-returns';
import { describeRequesterReturnError, getRequesterReturnSheet, requesterDoorClosed } from './requester-returns-api';

export type { RequesterSheetLoad };

/**
 * The requester's sheet for the order screen: read whenever the order is
 * read again (`reloadKey`, the order view's own receipt time), and when
 * asked (`reload`, the sheet's Try again or a refusal that means it is
 * behind). Online only: offline nothing is asked and the last answer stays.
 * An answer for an earlier read never replaces a later one.
 */
export function useRequesterReturn(input: {
  orderId: string | null;
  eligible: boolean;
  reloadKey: string | null;
  offline: boolean;
}): { load: RequesterSheetLoad; reload: () => void } {
  const { orderId, eligible, reloadKey, offline } = input;
  const [load, setLoad] = React.useState<RequesterSheetLoad>({ state: 'off' });
  const [asked, setAsked] = React.useState(0);
  const seq = React.useRef(0);

  React.useEffect(() => {
    if (!eligible || !orderId) {
      seq.current += 1;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the gate closed (another order, or the viewer may not ask): forget the answer the screen holds; nothing is fetched
      setLoad((prev) => (prev.state === 'off' ? prev : { state: 'off' }));
      return;
    }
    // Offline nothing is asked; the last answer stays on screen.
    if (offline) return;
    const mine = ++seq.current;
    setLoad((prev) => ({ state: 'loading', sheet: requesterLoadedSheet(prev) }));
    void getRequesterReturnSheet(orderId).then(
      (sheet) => {
        if (seq.current === mine) setLoad({ state: 'ready', sheet });
      },
      (e: unknown) => {
        if (seq.current !== mine) return;
        if (requesterDoorClosed(e)) setLoad({ state: 'closed' });
        else setLoad((prev) => ({ state: 'failed', sheet: requesterLoadedSheet(prev), message: describeRequesterReturnError(e) }));
      },
    );
  }, [orderId, eligible, reloadKey, offline, asked]);

  const reload = React.useCallback(() => setAsked((n) => n + 1), []);
  return { load, reload };
}
