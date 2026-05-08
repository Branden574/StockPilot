import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { BundleForm } from '@/components/bundles/bundle-form';
import { hasPermission } from '@stockpilot/core';
import { requireOrgContext } from '@/lib/auth/session';
import { BundlesService } from '@/server/services/bundles';

export default async function EditBundlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireOrgContext();
  if (!hasPermission(ctx.role, 'bundles:manage')) {
    redirect(`/dashboard/bundles/${id}`);
  }

  const svc = await BundlesService.forCurrentUser();
  let detail;
  try {
    detail = await svc.get(id);
  } catch {
    notFound();
  }

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href={`/dashboard/bundles/${id}`}
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to bundle
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Edit bundle</h1>
      </div>
      <BundleForm
        initial={{
          id: detail.bundle.id,
          name: detail.bundle.name,
          sku: detail.bundle.sku,
          description: detail.bundle.description,
          preassemblyEnabled: detail.bundle.preassembly_enabled,
          components: detail.components.map((c) => ({
            itemId: c.itemId,
            itemName: c.itemName,
            itemSku: c.itemSku,
            quantity: c.quantity,
            isOptional: c.isOptional,
          })),
        }}
      />
    </div>
  );
}
