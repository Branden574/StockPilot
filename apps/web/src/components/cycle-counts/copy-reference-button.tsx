'use client';

import { Check, Copy } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

/**
 * Copies a count's reference ("CC-000042") to the clipboard. Success is
 * announced only after the browser confirms the write; a refused or missing
 * clipboard says so and leaves the reference on screen to select by hand.
 */
export function CopyReferenceButton({ reference }: { reference: string }) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(reference);
      setCopied(true);
      toast.success(`Copied ${reference}`);
    } catch {
      setCopied(false);
      toast.error('Could not copy. Select the reference and copy it manually.');
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy reference ${reference}`}
      title="Copy reference"
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex h-7 w-7 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2"
    >
      {copied ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
    </button>
  );
}
