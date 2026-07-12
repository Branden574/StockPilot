'use client';

import { Bug, CheckCircle2, CreditCard, ImagePlus, Lightbulb, Loader2, MessageCircle, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { submitDashboardTicketAction } from '@/server/actions/support-tickets';

type DashboardCategory = 'bug' | 'feature' | 'billing' | 'other';

const TYPES: Array<{ value: DashboardCategory; label: string; icon: React.ElementType }> = [
  { value: 'bug', label: 'Report a problem', icon: Bug },
  { value: 'feature', label: 'Request a feature', icon: Lightbulb },
  { value: 'billing', label: 'Billing question', icon: CreditCard },
  { value: 'other', label: 'Something else', icon: MessageCircle },
];

const ACCEPT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const MAX_BYTES = 5 * 1024 * 1024;
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * In-app "Support & feedback" form. Project rule: form errors render INLINE
 * (never toasts), and success is an inline confirmation + reset. The optional
 * screenshot uploads straight from the browser to the private
 * support-attachments bucket under `${userId}/…` (the only path the bucket's
 * insert policy allows — mig 0260); only the resulting storage key is sent to
 * the server action.
 */
export function SupportTicketForm({ userId }: { userId: string }) {
  const router = useRouter();
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [category, setCategory] = React.useState<DashboardCategory>('bug');
  const [subject, setSubject] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [file, setFile] = React.useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState(false);

  // Object URLs leak until revoked. They're created/released in the pick and
  // remove handlers; this ref + unmount effect releases the last one if the
  // user navigates away mid-edit.
  const previewUrlRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  /** Swap (or clear) the selected file + its preview, revoking the old URL. */
  function replaceFile(next: File | null) {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const url = next ? URL.createObjectURL(next) : null;
    previewUrlRef.current = url;
    setFile(next);
    setPreviewUrl(url);
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    e.target.value = '';
    if (!picked) return;
    if (!ACCEPT_TYPES.includes(picked.type as (typeof ACCEPT_TYPES)[number])) {
      setError('Screenshots must be PNG, JPG, or WEBP.');
      return;
    }
    if (picked.size > MAX_BYTES) {
      setError('That image is over 5 MB. Please pick a smaller screenshot.');
      return;
    }
    setError(null);
    replaceFile(picked);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setSuccess(false);

    if (subject.trim().length < 3) {
      setError('Add a short subject (at least 3 characters).');
      return;
    }
    if (message.trim().length < 10) {
      setError('Tell us a little more (at least 10 characters).');
      return;
    }

    setBusy(true);
    try {
      // 1. Upload the screenshot first (if any) so the ticket row can carry
      //    its storage key. The bucket policy only accepts `${userId}/…`.
      let attachmentPath: string | undefined;
      if (file) {
        const ext = EXT_BY_MIME[file.type] ?? 'png';
        const path = `${userId}/${crypto.randomUUID()}.${ext}`;
        const supabase = createClient();
        const up = await supabase.storage
          .from('support-attachments')
          .upload(path, file, { contentType: file.type });
        if (up.error) {
          setError('Could not upload your screenshot. Try again, or submit without it.');
          return;
        }
        attachmentPath = path;
      }

      // 2. Create the ticket.
      const res = await submitDashboardTicketAction({
        category,
        subject: subject.trim(),
        message: message.trim(),
        attachmentPath,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }

      setSuccess(true);
      setCategory('bug');
      setSubject('');
      setMessage('');
      replaceFile(null);
      // Pull the fresh "My submissions" list into the server-rendered section.
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <div>
        <Label className="mb-2 block">What can we help with?</Label>
        <div role="radiogroup" aria-label="Request type" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {TYPES.map((t) => {
            const active = category === t.value;
            const Icon = t.icon;
            return (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setCategory(t.value)}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-center text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  active
                    ? 'border-primary bg-primary/5 text-foreground'
                    : 'border-border text-[var(--ed-ink-3)] hover:bg-muted',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="support-subject">Subject</Label>
        <Input
          id="support-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={140}
          placeholder="One line summarizing it"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="support-message">Details</Label>
        <Textarea
          id="support-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={6}
          maxLength={4000}
          placeholder="What happened (or what you'd like to see)? Steps to reproduce, expected vs. actual, links — the more detail, the faster we can help."
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="support-screenshot">Screenshot (optional)</Label>
        <input
          ref={fileInputRef}
          id="support-screenshot"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={onPickFile}
          className="hidden"
        />
        {previewUrl ? (
          <div className="border-border relative inline-block overflow-hidden rounded-lg border">
            {/* Local blob: preview — next/image can't optimize object URLs. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="Screenshot preview" className="max-h-48 w-auto max-w-full" />
            <button
              type="button"
              onClick={() => replaceFile(null)}
              aria-label="Remove screenshot"
              className="bg-background/90 border-border absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full border shadow-sm transition-colors hover:bg-muted"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
          >
            <ImagePlus className="h-4 w-4" aria-hidden />
            Attach a screenshot
          </Button>
        )}
        <p className="text-muted-foreground text-xs">PNG, JPG, or WEBP — up to 5 MB.</p>
      </div>

      {error && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
        >
          {error}
        </div>
      )}
      {success && (
        <div
          role="status"
          className="border-success/40 bg-success/10 flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
        >
          <CheckCircle2 className="text-success mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Thanks — we got it. Your submission is listed below and we&apos;ll follow up by email
            if we need anything.
          </span>
        </div>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {busy ? 'Sending…' : 'Send to StockPilot'}
        </Button>
      </div>
    </form>
  );
}
