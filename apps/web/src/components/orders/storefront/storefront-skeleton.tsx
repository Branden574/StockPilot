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
          style={{ height: 30, width: '100%', marginTop: 6, borderRadius: 9 }}
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
          style={{ height: 40, borderRadius: 10, margin: '10px 0 12px' }}
        />
        <div style={{ display: 'flex', gap: 6, margin: '0 0 18px' }}>
          {[64, 118, 96, 132, 88].map((w, i) => (
            <div
              key={i}
              className="sf-sk"
              style={{ width: w, height: 34, borderRadius: 999 }}
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
            <div className="sf-sk" style={{ height: 44, borderRadius: 9 }} />
            <div className="sf-sk" style={{ height: 44, borderRadius: 9 }} />
          </div>
          <div className="sf-cart-foot">
            <div className="sf-sk" style={{ height: 42, borderRadius: 11 }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Full-page storefront skeleton: the dark-scoped frame with head +
 * setup-bar placeholders above the catalog skeleton. Rendered by the
 * route's loading.tsx so navigation shows the branded "store is
 * opening" state instead of the generic dashboard PageSkeleton.
 */
export function StorefrontPageSkeleton() {
  return (
    <div className="sp-storefront">
      <div className="sf-page" aria-busy="true" aria-label="Loading order page">
        {/* Page head placeholder */}
        <div className="sf-head">
          <div>
            <div
              className="sf-sk"
              style={{ width: 96, height: 12, borderRadius: 6, marginBottom: 12 }}
            />
            <div className="sf-sk" style={{ width: 250, height: 30, borderRadius: 8 }} />
            <div
              className="sf-sk"
              style={{ width: 380, height: 13, borderRadius: 6, marginTop: 10 }}
            />
          </div>
          <div className="sf-sk" style={{ width: 300, height: 18, borderRadius: 999 }} />
        </div>

        {/* Setup bar placeholder */}
        <div className="sf-setup" style={{ padding: '13px 18px', gap: 18 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 11 }}
            >
              <div className="sf-sk" style={{ width: 32, height: 32, borderRadius: 8 }} />
              <div style={{ flex: 1 }}>
                <div
                  className="sf-sk"
                  style={{ width: '45%', height: 10, borderRadius: 5, marginBottom: 6 }}
                />
                <div className="sf-sk" style={{ width: '70%', height: 13, borderRadius: 6 }} />
              </div>
            </div>
          ))}
        </div>

        <CatalogSkeleton />
      </div>
    </div>
  );
}
