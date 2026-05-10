'use client';

import { Loader2, Trash2, Upload } from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/client';
import { setAvatarUrlAction } from '@/server/actions/profile';

interface AvatarUploaderProps {
  userId: string;
  initialUrl: string | null;
  fullName: string | null;
  email: string;
}

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/avif'];
const MAX_BYTES = 5 * 1024 * 1024;

export function AvatarUploader({
  userId,
  initialUrl,
  fullName,
  email,
}: AvatarUploaderProps) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [url, setUrl] = React.useState(initialUrl);
  const [busy, setBusy] = React.useState(false);

  async function pickFile() {
    inputRef.current?.click();
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) await upload(file);
    e.target.value = '';
  }

  async function upload(file: File) {
    if (!ACCEPT.includes(file.type)) {
      toast.error("That file type isn't supported. Use PNG, JPG, WEBP, or AVIF.");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error('Image is over 5 MB. Pick a smaller file.');
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      const ext = file.name.split('.').pop() ?? 'jpg';
      const path = `${userId}/${Date.now()}.${ext}`;
      const upRes = await supabase.storage
        .from('user-avatars')
        .upload(path, file, { upsert: true, contentType: file.type });
      if (upRes.error) {
        toast.error(upRes.error.message);
        return;
      }
      const { data } = supabase.storage.from('user-avatars').getPublicUrl(path);
      // Append a cache-buster so the topbar avatar reloads without a hard refresh.
      const cacheBust = `${data.publicUrl}?t=${Date.now()}`;
      const r = await setAvatarUrlAction({ url: cacheBust });
      if (!r.ok) {
        toast.error(r.error.message);
        return;
      }
      setUrl(cacheBust);
      toast.success('Avatar updated.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const r = await setAvatarUrlAction({ url: null });
      if (!r.ok) {
        toast.error(r.error.message);
        return;
      }
      setUrl(null);
      toast.success('Avatar removed.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const initials = (fullName ?? email).slice(0, 2).toUpperCase();

  return (
    <div className="flex items-center gap-4">
      <div className="border-border bg-muted relative grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-full border">
        {url ? (
          <Image src={url} alt="Avatar" fill sizes="64px" className="object-cover" />
        ) : (
          <span className="text-lg font-semibold">{initials}</span>
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
        <Button onClick={pickFile} disabled={busy} variant="outline">
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
