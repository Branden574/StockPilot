'use client';

import { ClipboardList } from 'lucide-react';

import { SHORTFALL_PO_BUTTON_LABEL } from '@stockpilot/core';

import { Button } from '@/components/ui/button';
import { openShortfallPo } from '@/lib/orders/shortfall-po';
import { cn } from '@/lib/utils';

/**
 * "Draft PO for what is short" on the readiness strip (F2-5): opens the dialog
 * the page mounted once (DraftShortfallPoDialog, draft-shortfall-po-dialog.tsx),
 * so a refresh that takes the button away (nothing is left to draft once the
 * drafts exist) keeps the open dialog and its links to the new drafts. It
 * writes nothing by itself.
 *
 * Its own module, so the strip does not load the dialog's server actions.
 */
export function DraftShortfallPoButton({ orderId, className }: { orderId: string; className?: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn('h-7 px-2 text-xs', className)}
      aria-haspopup="dialog"
      data-testid="readiness-draft-shortfall-po"
      data-shortfall-po={orderId}
      onClick={(e) => openShortfallPo(orderId, e.currentTarget)}
    >
      <ClipboardList className="size-3.5" aria-hidden />
      {SHORTFALL_PO_BUTTON_LABEL}
    </Button>
  );
}
