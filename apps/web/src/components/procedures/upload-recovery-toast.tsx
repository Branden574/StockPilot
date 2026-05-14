'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

/**
 * Shows a one-shot recovery toast on the edit page when the user arrives
 * with `?upload_recovery=1` — meaning at least one video failed to upload
 * after a create-procedure submit. The query param is then stripped from
 * the URL so a refresh doesn't keep firing the toast.
 *
 * The failed files themselves were held in memory on the previous page
 * and are gone after the redirect; the user has to re-drop them into
 * this page's uploader. That's the trade-off for not touching
 * sessionStorage (per the brief).
 */
export function UploadRecoveryToast() {
  const router = useRouter();
  const search = useSearchParams();
  const flag = search.get('upload_recovery');
  // Guard so React strict mode double-render doesn't fire twice.
  const firedRef = React.useRef(false);

  React.useEffect(() => {
    if (flag !== '1' || firedRef.current) return;
    firedRef.current = true;
    toast.warning(
      "Some video uploads didn't finish. Re-drop the missing files.",
    );
    // Strip the query param. Use replace so back-button doesn't re-toast.
    const params = new URLSearchParams(search.toString());
    params.delete('upload_recovery');
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : window.location.pathname);
  }, [flag, router, search]);

  return null;
}
