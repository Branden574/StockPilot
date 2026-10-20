'use client';

import { Check, Copy } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

/**
 * Copies a count's reference ("CC-000042") to the clipboard. Success is
 * announced only after the browser confirms the write; a refused or missing
 * clipboard says so and leaves the reference on screen to select by hand.
 *
 * A 28 px quiet icon button beside the title (DESIGN-SPEC 6.2), with the
 * shared Button's 44 px touch target on phones.
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
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={copy}
      aria-label={`Copy reference ${reference}`}
      title="Copy reference"
      className="text-muted-foreground hover:text-foreground h-7 w-7 [&_svg]:size-3.5"
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
    </Button>
  );
}
