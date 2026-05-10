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
  warehouses: WarehouseRow[];
}

export function PublicTokenControls({
  appUrl,
  initialToken,
  initialBlurb,
  warehouses,
}: Props) {
  const router = useRouter();
  const [token, setToken] = React.useState<string | null>(initialToken);
  const [rotating, setRotating] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

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
