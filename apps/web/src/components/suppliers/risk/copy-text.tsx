'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';

/**
 * Plain text to copy into an email (the follow-up questions for a vendor):
 * shown as text, never as markup, with a Copy button that says whether it
 * worked. Where the browser will not copy, the text is selected for the
 * person to copy themselves.
 */
export function CopyText({ text, label }: { text: string; label: string }) {
  const id = React.useId();
  const [said, setSaid] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLTextAreaElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setSaid('Copied.');
    } catch {
      ref.current?.focus();
      ref.current?.select();
      setSaid('Your browser did not copy it. The text is selected: copy it yourself.');
    }
  }

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-muted-foreground block text-[12.5px]">
        {label}
      </label>
      <textarea
        id={id}
        ref={ref}
        readOnly
        dir="auto"
        value={text}
        rows={Math.min(14, text.split('\n').length + 1)}
        className="border-line-strong bg-card text-foreground w-full rounded-md border px-3 py-2 font-mono text-[12.5px] leading-5"
      />
      <div className="flex items-center gap-3">
        <Button type="button" size="sm" variant="outline" onClick={copy}>
          Copy the questions
        </Button>
        <span role="status" className="text-muted-foreground text-[12.5px]">
          {said}
        </span>
      </div>
    </div>
  );
}
