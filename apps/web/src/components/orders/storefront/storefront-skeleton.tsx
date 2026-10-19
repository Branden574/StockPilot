'use client';

// Storefront loading skeletons, shared between:
//   1. the route-level app/(dashboard)/dashboard/orders/new/loading.tsx
//      (what a soft-nav or hard load shows INSTANTLY, before the page
//      segment's data resolves), and
//   2. the in-page <Suspense> fallback around the streamed catalog.
// One module so the two can't drift (perf plan P5) — the owner's
// "generic gray skeleton" complaint was the dashboard-wide PageSkeleton
// being the nearest loading boundary.

import * as React from 'react';

import './storefront.css';

/** Grid-card placeholder matching ProductCard's proportions. */
export function SkeletonCard() {
  return (
    <div className="sf-sk-card">
      <div className="sf-sk ph" />
      <div className="bd">
        <div className="sf-sk" style={{ height: 13, width: '85%' }} />
        <div className="sf-sk" style={{ height: 13, width: '55%' }} />
        <div
          className="sf-sk"
          style={{ height: 32, width: '100%', marginTop: 6, borderRadius: 6 }}
        />
      </div>
    </div>
  );
}

/** Two-column catalog + cart-rail placeholder (the in-page fallback). */
export function CatalogSkeleton() {
  return (
    <div className="sf-shell" aria-busy="true" aria-label="Loading catalog">
      <div style={{ minWidth: 0 }}>
        <div
          className="sf-sk"
          style={{ height: 34, borderRadius: 6, margin: '8px 0 12px' }}
        />
        <div style={{ display: 'flex', gap: 8, margin: '0 0 18px', overflow: 'hidden' }}>
          {[64, 118, 96, 132, 88].map((w, i) => (
            <div
              key={i}
              className="sf-sk"
              style={{ width: w, height: 30, borderRadius: 999 }}
            />
          ))}
        </div>
        <div className="sf-grid">
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </div>
      <div className="sf-rail">
        <div className="sf-cart">
          <div className="sf-cart-head">
            <div className="sf-sk" style={{ width: 130, height: 16 }} />
          </div>
          <div
            style={{
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              flex: 1,
            }}
          >
            <div className="sf-sk" style={{ height: 36, borderRadius: 6 }} />
            <div className="sf-sk" style={{ height: 36, borderRadius: 6 }} />
          </div>
          <div className="sf-cart-foot">
            <div className="sf-sk" style={{ height: 36, borderRadius: 6 }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Full-page storefront skeleton: the page frame with head +
 * setup-bar placeholders above the catalog skeleton. Rendered by the
 * route's loading.tsx so navigation shows the branded "store is
 * opening" state instead of the generic dashboard PageSkeleton.
 */
export function StorefrontPageSkeleton() {
  return (
    <div className="sp-storefront">
      <div className="sf-page" aria-busy="true" aria-label="Loading order page">
        {/* Page head placeholder: the shared page header's boxes (back
            link, the 42 px title line, the subline; the flow on the right). */}
        <div className="sf-head">
          <div style={{ minWidth: 0, maxWidth: '100%' }}>
            <div
              className="sf-sk"
              style={{ width: 110, height: 12, borderRadius: 6, margin: '4px 0 12px' }}
            />
            <div style={{ height: 42, display: 'flex', alignItems: 'center' }}>
              <div className="sf-sk" style={{ width: 210, height: 26 }} />
            </div>
            <div style={{ height: 20, display: 'flex', alignItems: 'center', marginTop: 2 }}>
              <div className="sf-sk" style={{ width: 380, maxWidth: '100%', height: 12 }} />
            </div>
          </div>
          <div
            className="sf-sk"
            style={{ width: 300, maxWidth: '100%', height: 18, borderRadius: 999 }}
          />
        </div>

        {/* Setup bar placeholder: four cells drawn as the real ones are. */}
        <div className="sf-setup">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="sf-setup-cell static">
              <div className="sf-sk" style={{ width: 32, height: 32 }} />
              <div style={{ flex: 1 }}>
                <div
                  className="sf-sk"
                  style={{ width: '45%', height: 10, borderRadius: 5, marginBottom: 6 }}
                />
                <div className="sf-sk" style={{ width: '70%', height: 13 }} />
              </div>
            </div>
          ))}
        </div>

        <CatalogSkeleton />
      </div>
    </div>
  );
}
