import Link from 'next/link';

export function ShipmentsDeprecatedBanner() {
  return (
    <div className="border-amber-500/30 bg-amber-500/5 text-foreground rounded-xl border p-4 text-sm">
      <p className="font-medium">Shipments are read-only.</p>
      <p className="text-muted-foreground mt-1">
        New outbound work is tracked under{' '}
        <Link href="/dashboard/orders" className="underline">
          Orders
        </Link>
        . Historical shipments stay here for reference; you can&apos;t create
        or modify them.
      </p>
    </div>
  );
}
