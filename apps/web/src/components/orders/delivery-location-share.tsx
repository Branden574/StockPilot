'use client';
import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { shareDeliveryLocationAction } from '@/server/actions/delivery-tracking';

const MIN_INTERVAL_MS = 15_000;

export function DeliveryLocationShare({ orderId }: { orderId: string }) {
  const [sharing, setSharing] = React.useState(false);
  const watchId = React.useRef<number | null>(null);
  const lastSent = React.useRef(0);

  const stop = React.useCallback(() => {
    if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    setSharing(false);
  }, []);

  React.useEffect(() => () => { if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current); }, []);

  function start() {
    if (!('geolocation' in navigator)) { toast.error('Location not available on this device.'); return; }
    setSharing(true);
    watchId.current = navigator.geolocation.watchPosition(
      async (pos) => {
        const now = Date.now();
        if (now - lastSent.current < MIN_INTERVAL_MS) return;
        lastSent.current = now;
        const res = await shareDeliveryLocationAction({
          orderId,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          heading: pos.coords.heading ?? undefined,
          accuracy: pos.coords.accuracy ?? undefined,
        });
        if (!res.ok) { toast.error(res.error.message); stop(); }
      },
      (e) => { toast.error(`Location error: ${e.message}`); stop(); },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    );
  }

  return (
    <div className="rounded-lg border p-3">
      <p className="text-sm font-medium">Live delivery tracking</p>
      <p className="text-muted-foreground mb-2 text-xs">
        While on, the customer can see your location on a map until this delivery completes. Foreground only.
      </p>
      <Button type="button" variant={sharing ? 'outline' : 'gradient'} size="sm" onClick={sharing ? stop : start}>
        {sharing ? 'Stop sharing' : 'Share my location'}
      </Button>
    </div>
  );
}
