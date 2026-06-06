'use client';
import * as React from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Map as MlMap, Marker as MlMarker, StyleSpecification } from 'maplibre-gl';

interface LocationPayload {
  available: boolean;
  driver?: { lat: number; lng: number; heading: number | null; recordedAt: string };
  destination?: { lat: number; lng: number } | null;
  distanceMiles?: number | null;
}

// Basemap: a real street map. Falls back to no-key OpenStreetMap raster tiles so
// it works with zero setup, and auto-upgrades to MapTiler vector tiles (nicer +
// higher rate limits) the moment NEXT_PUBLIC_MAPTILER_KEY is set. The previous
// demotiles.maplibre.org style was a coarse world overview with NO streets at
// delivery zoom, so the customer saw a marker on a blank map.
const OSM_RASTER_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

function resolveBasemapStyle(): StyleSpecification | string {
  const key = process.env.NEXT_PUBLIC_MAPTILER_KEY;
  return key
    ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${key}`
    : OSM_RASTER_STYLE;
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
      try {
        const maplibregl = (await import('maplibre-gl')).default;
        if (disposed || !mapRef.current) return;
        const d = payload.driver!;
        if (!mapObj.current) {
          mapObj.current = new maplibregl.Map({
            container: mapRef.current,
            style: resolveBasemapStyle(),
            center: [d.lng, d.lat],
            zoom: 13,
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
      } catch (err) {
        // Don't let a map-init failure become a silent unhandled rejection —
        // the customer just won't see the map, but we want it in the logs.
        console.error('[delivery-map] failed to initialize map', err);
      }
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
