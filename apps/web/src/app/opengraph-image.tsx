import { ImageResponse } from 'next/og';

export const alt = "StockPilot — Inventory you'll actually enjoy using";
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image() {
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
          padding: '80px',
          backgroundColor: '#0a0f1f',
          backgroundImage:
            'radial-gradient(circle at 20% 0%, rgba(59,130,246,0.35), transparent 50%), radial-gradient(circle at 80% 100%, rgba(139,92,246,0.30), transparent 50%)',
          color: 'white',
          fontFamily: 'system-ui',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 32 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 12,
              background: 'linear-gradient(135deg, #3b82f6, #6366f1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 28,
              fontWeight: 700,
            }}
          >
            S
          </div>
          <span style={{ fontSize: 32, fontWeight: 700, letterSpacing: -0.5 }}>StockPilot</span>
        </div>
        <h1
          style={{
            fontSize: 84,
            fontWeight: 700,
            margin: 0,
            lineHeight: 1.05,
            letterSpacing: -2,
            maxWidth: '90%',
          }}
        >
          Inventory you'll{' '}
          <span
            style={{
              backgroundImage: 'linear-gradient(90deg, #60a5fa, #a78bfa)',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            actually
          </span>{' '}
          enjoy using.
        </h1>
        <p
          style={{
            marginTop: 32,
            fontSize: 28,
            color: '#94a3b8',
            maxWidth: '80%',
          }}
        >
          Multi-location stock, scanning, purchase orders, and reports — built for teams that move fast.
        </p>
      </div>
    ),
    { ...size },
  );
}
