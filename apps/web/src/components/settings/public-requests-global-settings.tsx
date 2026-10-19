'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { SettingsPanel } from '@/components/settings/settings-nav';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  setPublicRequestBlurbAction,
  setWarehousePublicOrderableAction,
} from '@/server/actions/order-requests';

interface WarehouseRow {
  id: string;
  name: string;
  isPublicOrderable: boolean;
}

/**
 * Org-wide public request settings that apply across EVERY public link:
 * the public blurb (top of every /r/<token> page) and the per-warehouse
 * is_public_orderable toggles (a link can never expose items from a closed
 * warehouse, no matter its catalog config). Split out of the retired
 * PublicTokenControls — token management now lives per-link in the links
 * manager, where rotation keeps the links table and legacy org column in
 * sync (the old org-level Regenerate button would have desynced them).
 */
export function PublicRequestsGlobalSettings({
  initialBlurb,
  warehouses,
}: {
  initialBlurb: string | null;
  warehouses: WarehouseRow[];
}) {
  const router = useRouter();

  const [blurb, setBlurb] = React.useState(initialBlurb ?? '');
  const blurbInitial = React.useRef(initialBlurb ?? '');
  const [savingBlurb, setSavingBlurb] = React.useState(false);
  const [blurbError, setBlurbError] = React.useState<string | null>(null);

  const [warehouseState, setWarehouseState] = React.useState<WarehouseRow[]>(warehouses);
  const [togglingWarehouseId, setTogglingWarehouseId] = React.useState<string | null>(null);
  const [warehouseError, setWarehouseError] = React.useState<string | null>(null);

  // Debounced auto-save for the blurb, same cadence as the previous controls.
  React.useEffect(() => {
    if (blurb === blurbInitial.current) return;
    const t = setTimeout(async () => {
      setSavingBlurb(true);
      setBlurbError(null);
      const res = await setPublicRequestBlurbAction({
        blurb: blurb.trim() ? blurb : null,
      });
      setSavingBlurb(false);
      if (!res.ok) {
        setBlurbError(res.error.message);
        return;
      }
      blurbInitial.current = blurb;
      router.refresh();
    }, 800);
    return () => clearTimeout(t);
  }, [blurb, router]);

  async function toggleWarehouse(warehouseId: string, on: boolean) {
    setTogglingWarehouseId(warehouseId);
    setWarehouseError(null);
    const res = await setWarehousePublicOrderableAction({
      warehouseId,
      isPublicOrderable: on,
    });
    setTogglingWarehouseId(null);
    if (!res.ok) {
      setWarehouseError(res.error.message);
      return;
    }
    setWarehouseState((cur) =>
      cur.map((w) => (w.id === warehouseId ? { ...w, isPublicOrderable: on } : w)),
    );
    router.refresh();
  }

  return (
    <>
      <SettingsPanel
        title={
          // The heading names the field: the textarea's label sits inside it.
          <label htmlFor="public-blurb">Public blurb</label>
        }
        description="Shown at the top of every public request page. Use it to set expectations or describe who you serve."
        bodyClassName="space-y-2"
      >
        <Textarea
          id="public-blurb"
          value={blurb}
          onChange={(e) => setBlurb(e.target.value)}
          rows={4}
          maxLength={1000}
          placeholder="Tell visitors who you are and how requests are fulfilled."
        />
        {blurbError ? (
          <p role="alert" className="text-destructive text-[12.5px]">
            {blurbError}
          </p>
        ) : (
          <p className="text-muted-foreground text-[12px]">
            {savingBlurb ? 'Saving…' : 'Saves automatically.'}
          </p>
        )}
      </SettingsPanel>

      <SettingsPanel
        title="Public-orderable warehouses"
        description="Applies to every link: only items in warehouses you flip on here can ever appear on a public request page."
        flush
      >
        {warehouseError ? (
          <p role="alert" className="text-destructive px-[18px] pt-3 text-[12.5px]">
            {warehouseError}
          </p>
        ) : null}
        <ul className="divide-border divide-y">
          {warehouseState.length === 0 && (
            <li className="text-muted-foreground px-[18px] py-6 text-center text-[13px]">
              No warehouses to configure.
            </li>
          )}
          {warehouseState.map((w) => (
            <li
              key={w.id}
              className="flex items-center justify-between gap-3 px-[18px] py-2.5 text-[13.5px]"
            >
              <span className="min-w-0 truncate">{w.name}</span>
              <Button
                type="button"
                variant={w.isPublicOrderable ? 'gradient' : 'outline'}
                size="sm"
                onClick={() => toggleWarehouse(w.id, !w.isPublicOrderable)}
                disabled={togglingWarehouseId === w.id}
              >
                {togglingWarehouseId === w.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {w.isPublicOrderable ? 'Open' : 'Closed'}
              </Button>
            </li>
          ))}
        </ul>
      </SettingsPanel>
    </>
  );
}
