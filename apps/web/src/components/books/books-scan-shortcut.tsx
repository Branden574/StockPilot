'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { IsbnScanner } from '@/components/inventory/isbn-scanner';
import { lookupBookByIsbnAction } from '@/server/actions/books-lookup';

export interface BooksScanShortcutHandle {
  open: () => void;
}

export const BooksScanShortcut = React.forwardRef<BooksScanShortcutHandle>(
  function BooksScanShortcut(_, ref) {
    const router = useRouter();
    const [open, setOpen] = React.useState(false);
    const [busy, setBusy] = React.useState(false);

    React.useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);

    async function handleDetected(isbn: string) {
      if (busy) {
        toast.info('Still looking up the last scan — give it a second.');
        return;
      }
      setBusy(true);
      try {
        const res = await lookupBookByIsbnAction({ isbn });
        setOpen(false);
        if (!res.ok) {
          toast.error(res.error.message);
          return;
        }
        const matches = res.data.matches;
        if (matches.length === 1 && matches[0]) {
          router.push(`/dashboard/books/${matches[0].id}`);
          return;
        }
        if (matches.length === 0) {
          toast.error(`No book found for ISBN ${isbn}`, {
            action: {
              label: 'Create new book',
              onClick: () => router.push(`/dashboard/books/new?isbn=${isbn}`),
            },
          });
          return;
        }
        router.push(`/dashboard/books?q=${encodeURIComponent(isbn)}`);
      } finally {
        setBusy(false);
      }
    }

    return (
      <IsbnScanner
        open={open}
        onOpenChange={setOpen}
        onDetected={handleDetected}
        mode="isbn"
      />
    );
  },
);
