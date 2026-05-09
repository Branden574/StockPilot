import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'StockPilot',
    short_name: 'StockPilot',
    description: "Inventory you'll actually enjoy using.",
    start_url: '/dashboard',
    display: 'standalone',
    // Brand palette — Mark D · Stencil Frame (paper / ink).
    background_color: '#f6f4ef',
    theme_color: '#0c0c0e',
    orientation: 'portrait-primary',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/apple-icon',
        sizes: '180x180',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
