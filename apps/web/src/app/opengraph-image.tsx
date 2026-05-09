import { ImageResponse } from 'next/og';

export const alt = "StockPilot — Inventory you'll actually enjoy using";
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * OG card — Mark D · Stencil Frame brand sheet, social-share size.
 * Paper background, ink mark, quiet editorial type. Mirrors the
 * brand sheet's "Brief" framing.
 */
export default async function Image() {
  const INK = '#0c0c0e';
  const PAPER = '#f6f4ef';

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'center',
          padding: '88px 96px',
          backgroundColor: PAPER,
          color: INK,
          fontFamily: 'system-ui',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 20,
            marginBottom: 40,
          }}
        >
          <svg
            width="84"
            height="84"
            viewBox="0 0 100 100"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <mask id="og-m" maskUnits="userSpaceOnUse">
                <rect width="100" height="100" fill="white" />
                <path
                  d="M 32 78 Q 72 78 72 66 Q 72 54 54 54 Q 32 54 32 42 Q 32 24 72 24"
                  stroke="black"
                  strokeWidth="11"
                  strokeLinecap="round"
                  fill="none"
                />
                <circle cx="72" cy="24" r="6" fill="black" />
              </mask>
            </defs>
            <rect
              x="12"
              y="12"
              width="76"
              height="76"
              rx="16"
              fill={INK}
              mask="url(#og-m)"
            />
          </svg>
          <span
            style={{
              fontSize: 36,
              fontWeight: 600,
              letterSpacing: -0.6,
            }}
          >
            Stock<span style={{ fontWeight: 500, opacity: 0.6 }}>Pilot</span>
          </span>
        </div>
        <h1
          style={{
            fontSize: 88,
            fontWeight: 600,
            margin: 0,
            lineHeight: 1.04,
            letterSpacing: -2.2,
            maxWidth: '92%',
          }}
        >
          Inventory you&apos;ll{' '}
          <span style={{ fontStyle: 'italic', opacity: 0.7 }}>actually</span>{' '}
          enjoy using.
        </h1>
        <p
          style={{
            marginTop: 36,
            fontSize: 26,
            color: '#5a5d56',
            maxWidth: '78%',
            lineHeight: 1.4,
          }}
        >
          Multi-location stock, scanning, purchase orders, and reports — built
          for teams that move fast.
        </p>
      </div>
    ),
    { ...size },
  );
}
