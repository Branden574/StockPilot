'use client';

import { Building2, Loader2, Trash2, Upload } from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/client';
import { setOrgLogoUrlAction } from '@/server/actions/profile';

interface OrgLogoUploaderProps {
  organizationId: string;
  initialUrl: string | null;
}

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/svg+xml'];
const MAX_BYTES = 5 * 1024 * 1024;

export function OrgLogoUploader({
  organizationId,
  initialUrl,
}: OrgLogoUploaderProps) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [url, setUrl] = React.useState(initialUrl);
  const [busy, setBusy] = React.useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) await upload(file);
    e.target.value = '';
  }

  async function upload(file: File) {
    if (!ACCEPT.includes(file.type)) {
      toast.error('Use PNG, JPG, WEBP, AVIF, or SVG');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error('Max 5 MB');
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      const ext = file.name.split('.').pop() ?? 'png';
      const path = `${organizationId}/logo-${Date.now()}.${ext}`;
      const upRes = await supabase.storage
        .from('org-logos')
        .upload(path, file, { upsert: true, contentType: file.type });
      if (upRes.error) {
        toast.error(upRes.error.message);
        return;
      }
      const { data } = supabase.storage.from('org-logos').getPublicUrl(path);
      const cacheBust = `${data.publicUrl}?t=${Date.now()}`;
      const r = await setOrgLogoUrlAction({ url: cacheBust });
      if (!r.ok) {
        toast.error(r.error.message);
        return;
      }
      setUrl(cacheBust);
      toast.success('Logo updated');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const r = await setOrgLogoUrlAction({ url: null });
      if (!r.ok) {
        toast.error(r.error.message);
        return;
      }
      setUrl(null);
      toast.success('Logo removed');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      <div className="border-border bg-muted relative grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-md border">
        {url ? (
          <Image src={url} alt="Logo" fill sizes="64px" className="object-contain" />
        ) : (
          <Building2 className="text-muted-foreground h-6 w-6" />
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT.join(',')}
          onChange={onFile}
          className="hidden"
        />
        <Button onClick={() => inputRef.current?.click()} disabled={busy} variant="outline">
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          {url ? 'Replace' : 'Upload'}
        </Button>
        {url && (
          <Button onClick={remove} disabled={busy} variant="outline">
            <Trash2 className="h-4 w-4" />
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
