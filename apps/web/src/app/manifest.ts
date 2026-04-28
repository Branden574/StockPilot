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
    // Branded PNG icons can be added later under public/icon.png + icon-maskable.png.
    icons: [],
  };
}
