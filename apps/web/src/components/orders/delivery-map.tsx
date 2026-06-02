'use client';
import * as React from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Map as MlMap, Marker as MlMarker } from 'maplibre-gl';

interface LocationPayload {
  available: boolean;
  driver?: { lat: number; lng: number; heading: number | null; recordedAt: string };
  destination?: { lat: number; lng: number } | null;
  distanceMiles?: number | null;
}

export function DeliveryMap({ orderId, token, email }: { orderId: string; token: string; email: string }) {
  const mapRef = React.useRef<HTMLDivElement>(null);
  const [payload, setPayload] = React.useState<LocationPayload | null>(null);

  // Poll the token-scoped endpoint every 12s.
  React.useEffect(() => {
    let cancelled = false;
    const url = `/api/v1/public/order-requests/${orderId}/location?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
    async function tick() {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as LocationPayload;
        if (!cancelled) setPayload(data);
      } catch {
        /* keep last payload on a transient failure */
      }
    }
    void tick();
    const t = setInterval(() => void tick(), 12_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [orderId, token, email]);

  // Lazy-init MapLibre + update markers when the payload changes.
  const mapObj = React.useRef<MlMap | null>(null);
  const markers = React.useRef<{ driver?: MlMarker; dest?: MlMarker }>({});
  React.useEffect(() => {
    if (!payload?.available || !payload.driver || !mapRef.current) return;
    let disposed = false;
    void (async () => {
      const maplibregl = (await import('maplibre-gl')).default;
      if (disposed || !mapRef.current) return;
      const d = payload.driver!;
      if (!mapObj.current) {
        mapObj.current = new maplibregl.Map({
          container: mapRef.current,
          style: 'https://demotiles.maplibre.org/style.json', // free OSM demo style; swap for a MapTiler key if rate-limited
          center: [d.lng, d.lat],
          zoom: 12,
        });
      }
      const map = mapObj.current;
      const setMarker = (key: 'driver' | 'dest', lng: number, lat: number, color: string) => {
        const existing = markers.current[key];
        if (existing) existing.setLngLat([lng, lat]);
        else markers.current[key] = new maplibregl.Marker({ color }).setLngLat([lng, lat]).addTo(map);
      };
      setMarker('driver', d.lng, d.lat, '#2563eb');
      if (payload.destination) setMarker('dest', payload.destination.lng, payload.destination.lat, '#16a34a');
      map.easeTo({ center: [d.lng, d.lat] });
    })();
    return () => { disposed = true; };
  }, [payload]);

  // Tear the map down on unmount.
  React.useEffect(() => () => { mapObj.current?.remove(); mapObj.current = null; }, []);

  if (!payload) return null;
  if (!payload.available) {
    return <p className="text-muted-foreground mt-3 text-sm">Live location isn&apos;t available right now.</p>;
  }
  return (
    <div className="mt-4">
      <div ref={mapRef} className="h-64 w-full overflow-hidden rounded-lg border" />
      <p className="text-muted-foreground mt-2 text-sm">
        {payload.distanceMiles != null ? `Driver is about ${payload.distanceMiles} mi away` : 'Driver en route'}
        {payload.driver ? ` · updated ${new Date(payload.driver.recordedAt).toLocaleTimeString()}` : ''}
      </p>
    </div>
  );
}
