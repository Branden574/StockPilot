import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'StockPilot',
    short_name: 'StockPilot',
    description: "Inventory you'll actually enjoy using.",
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#0a0f1f',
    theme_color: '#0a0f1f',
    orientation: 'portrait-primary',
    icons: [
      { src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
