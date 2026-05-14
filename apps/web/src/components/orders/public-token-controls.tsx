'use client';

import { Check, Copy, Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  rotatePublicRequestTokenAction,
  setPublicRequestBlurbAction,
  setWarehousePublicOrderableAction,
} from '@/server/actions/order-requests';

interface WarehouseRow {
  id: string;
  name: string;
  isPublicOrderable: boolean;
}

interface Props {
  appUrl: string;
  initialToken: string | null;
  initialBlurb: string | null;
  /**
   * Last rotation timestamp for the public token. Used to surface a
   * 90-day rotation reminder banner. Null when no link has ever been
   * generated.
   */
  initialRotatedAt: string | null;
  warehouses: WarehouseRow[];
}

export function PublicTokenControls({
  appUrl,
  initialToken,
  initialBlurb,
  initialRotatedAt,
  warehouses,
}: Props) {
  const router = useRouter();
  const [token, setToken] = React.useState<string | null>(initialToken);
  const [rotatedAt, setRotatedAt] = React.useState<string | null>(initialRotatedAt);
  const [rotating, setRotating] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  // I11: 90-day rotation reminder. Computed in the client so it stays
  // accurate across long-lived tabs without forcing a server refetch.
  // We treat 90 days as the threshold to match common credential-
  // rotation guidance; teams in heavy use should rotate sooner.
  const ROTATION_THRESHOLD_DAYS = 90;
  const daysSinceRotation = React.useMemo(() => {
    if (!rotatedAt) return null;
    const ms = Date.now() - new Date(rotatedAt).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    return Math.floor(ms / (24 * 60 * 60 * 1000));
  }, [rotatedAt]);
  const showRotationReminder =
    token != null &&
    daysSinceRotation != null &&
    daysSinceRotation >= ROTATION_THRESHOLD_DAYS;

  const [blurb, setBlurb] = React.useState(initialBlurb ?? '');
  const blurbInitial = React.useRef(initialBlurb ?? '');
  const [savingBlurb, setSavingBlurb] = React.useState(false);

  const [warehouseState, setWarehouseState] = React.useState<WarehouseRow[]>(warehouses);
  const [togglingWarehouseId, setTogglingWarehouseId] = React.useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = React.useState(false);

  const publicUrl = token ? `${appUrl.replace(/\/$/, '')}/r/${token}` : null;

  async function copyUrl() {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      toast.success('Public link copied to clipboard.');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy the link. Copy it manually from the field above.");
    }
  }

  async function performRotate() {
    setRotating(true);
    const res = await rotatePublicRequestTokenAction();
    setRotating(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setToken(res.data.token);
    // Reset the local rotation timestamp so the reminder banner clears
    // immediately on success — the server has already persisted `now()`
    // for `public_request_token_rotated_at`.
    setRotatedAt(new Date().toISOString());
    setRotateOpen(false);
    toast.success('Public link regenerated. The old link no longer works.');
    router.refresh();
  }

  function onRotateClick() {
    // Generating the first link isn't destructive; only regenerating an
    // existing link is — the old URL stops working.
    if (token) {
      setRotateOpen(true);
    } else {
      void performRotate();
    }
  }

  // Debounced auto-save for blurb. Saves 800ms after typing stops.
  React.useEffect(() => {
    if (blurb === blurbInitial.current) return;
    const t = setTimeout(async () => {
      setSavingBlurb(true);
      const res = await setPublicRequestBlurbAction({
        blurb: blurb.trim() ? blurb : null,
      });
      setSavingBlurb(false);
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      blurbInitial.current = blurb;
      router.refresh();
    }, 800);
    return () => clearTimeout(t);
  }, [blurb, router]);

  async function toggleWarehouse(warehouseId: string, on: boolean) {
    setTogglingWarehouseId(warehouseId);
    const res = await setWarehousePublicOrderableAction({
      warehouseId,
      isPublicOrderable: on,
    });
    setTogglingWarehouseId(null);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setWarehouseState((cur) =>
      cur.map((w) => (w.id === warehouseId ? { ...w, isPublicOrderable: on } : w)),
    );
    toast.success(on ? 'Warehouse opened to public orders.' : 'Warehouse closed to public orders.');
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {showRotationReminder ? (
        <div className="rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm dark:border-amber-700/40 dark:bg-amber-950/40">
          <p className="font-medium text-amber-900 dark:text-amber-200">
            Public link is {daysSinceRotation} days old
          </p>
          <p className="mt-0.5 text-xs text-amber-800/90 dark:text-amber-200/80">
            Rotate it every 90 days to invalidate links that may have
            leaked (forwarded emails, printed flyers, archived chats).
            Use the Regenerate button below — the old URL stops working
            immediately.
          </p>
        </div>
      ) : null}

      <section className="bg-card space-y-3 rounded-xl border p-4">
        <div>
          <h2 className="text-sm font-medium">Public request link</h2>
          <p className="text-muted-foreground mt-0.5 text-[11.5px]">
            Share this URL with external requesters. Anyone with the link can
            submit a book request to a public-orderable warehouse.
          </p>
        </div>

        {publicUrl ? (
          <div className="flex items-center gap-2">
            <Input value={publicUrl} readOnly className="font-mono text-xs" />
            <Button type="button" variant="outline" onClick={copyUrl}>
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs italic">
            No link generated yet.
          </p>
        )}

        <div>
          <Button type="button" variant="outline" onClick={onRotateClick} disabled={rotating}>
            {rotating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {token ? 'Regenerate link' : 'Generate link'}
          </Button>
        </div>
      </section>

      <DestructiveConfirm
        open={rotateOpen}
        onOpenChange={setRotateOpen}
        title="Regenerate the public link?"
        description="The current public URL stops working immediately. Anyone using the old link (bookmarks, emails, printed flyers) will see a 404. A fresh link is generated and copied here for you to share."
        confirmLabel="Regenerate link"
        pending={rotating}
        onConfirm={performRotate}
      />

      <section className="bg-card space-y-2 rounded-xl border p-4">
        <div>
          <Label htmlFor="public-blurb" className="text-sm font-medium">
            Public blurb
          </Label>
          <p className="text-muted-foreground mt-0.5 text-[11.5px]">
            Shown at the top of the public request page. Use it to set
            expectations or describe who you serve.
          </p>
        </div>
        <Textarea
          id="public-blurb"
          value={blurb}
          onChange={(e) => setBlurb(e.target.value)}
          rows={4}
          maxLength={1000}
          placeholder="Tell visitors who you are and how requests are fulfilled."
        />
        <p className="text-muted-foreground text-[11px]">
          {savingBlurb ? 'Saving…' : 'Saves automatically.'}
        </p>
      </section>

      <section className="bg-card rounded-xl border">
        <div className="border-border border-b px-4 py-3">
          <h2 className="text-sm font-medium">Public-orderable warehouses</h2>
          <p className="text-muted-foreground mt-0.5 text-[11.5px]">
            Only books in warehouses you flip on here will appear on the
            public request page.
          </p>
        </div>
        <ul className="divide-y">
          {warehouseState.length === 0 && (
            <li className="text-muted-foreground p-4 text-center text-xs">
              No warehouses to configure.
            </li>
          )}
          {warehouseState.map((w) => (
            <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <span className="truncate">{w.name}</span>
              <Button
                type="button"
                variant={w.isPublicOrderable ? 'gradient' : 'outline'}
                size="sm"
                onClick={() => toggleWarehouse(w.id, !w.isPublicOrderable)}
                disabled={togglingWarehouseId === w.id}
              >
                {togglingWarehouseId === w.id && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                {w.isPublicOrderable ? 'Open' : 'Closed'}
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
