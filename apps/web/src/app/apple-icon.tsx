import { ImageResponse } from 'next/og';

/**
 * Apple touch icon — Mark D · Stencil Frame, static.
 * iOS strips animation from touch icons, so this is a still rendering
 * of the carved-S frame at the spec size.
 */
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default async function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f6f4ef',
        }}
      >
        <svg
          width="180"
          height="180"
          viewBox="0 0 100 100"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <mask id="m" maskUnits="userSpaceOnUse">
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
            fill="#0c0c0e"
            mask="url(#m)"
          />
        </svg>
      </div>
    ),
    { ...size },
  );
}
