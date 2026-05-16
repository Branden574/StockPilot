import Link from 'next/link';

import { ShipmentsDeprecatedBanner } from '@/components/shipments/shipments-deprecated-banner';
import { Button } from '@/components/ui/button';

export default function NewShipmentPage() {
  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <ShipmentsDeprecatedBanner />
      <div className="mt-6">
        <Link
          href="/dashboard/shipments"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to shipments
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Shipments are read-only
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          The shipments workflow has been replaced. Create and track outbound
          work under Orders.
        </p>
        <div className="mt-6">
          <Button asChild variant="gradient">
            <Link href="/dashboard/orders">Go to Orders</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
