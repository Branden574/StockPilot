'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  createProcedureAction,
  updateProcedureAction,
} from '@/server/actions/procedures';

import { VideoUploader, type UploadedVideo } from './video-uploader';

interface CategoryOption {
  id: string;
  name: string;
  color: string | null;
}

interface WarehouseOption {
  id: string;
  name: string;
}

interface Defaults {
  id?: string;
  title?: string;
  description?: string | null;
  body?: string | null;
  categoryId?: string | null;
  authoringWarehouseId?: string | null;
}

interface ProcedureFormProps {
  mode: 'create' | 'edit';
  categories: CategoryOption[];
  warehouses: WarehouseOption[];
  /** Org id for the storage path prefix (RLS gates the first segment). */
  organizationId: string;
  defaults?: Defaults;
  videos?: UploadedVideo[];
}

const NULL_VALUE = '__none';

/**
 * Procedure create/edit form. The video uploader is inline but ONLY
 * shown in edit mode (we need a procedure id to upload against). The
 * create flow saves the procedure first, then routes to the edit page
 * so videos can be attached.
 */
export function ProcedureForm({
  mode,
  categories,
  warehouses,
  organizationId,
  defaults,
  videos = [],
}: ProcedureFormProps) {
  const router = useRouter();
  const isEdit = mode === 'edit';
  const [title, setTitle] = React.useState(defaults?.title ?? '');
  const [description, setDescription] = React.useState(defaults?.description ?? '');
  const [body, setBody] = React.useState(defaults?.body ?? '');
  const [categoryId, setCategoryId] = React.useState<string>(
    defaults?.categoryId ?? NULL_VALUE,
  );
  const [authoringWarehouseId, setAuthoringWarehouseId] = React.useState<string>(
    defaults?.authoringWarehouseId ?? NULL_VALUE,
  );
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const t = title.trim();
    if (!t) {
      toast.error('Give the procedure a title.');
      return;
    }
    setBusy(true);
    const payload = {
      title: t,
      description: description.trim() || null,
      body: body.trim() || null,
      categoryId: categoryId === NULL_VALUE ? null : categoryId,
      authoringWarehouseId:
        authoringWarehouseId === NULL_VALUE ? null : authoringWarehouseId,
    };
    try {
      if (isEdit && defaults?.id) {
        const res = await updateProcedureAction(defaults.id, payload);
        if (!res.ok) {
          toast.error(res.error.message);
          return;
        }
        toast.success('Procedure saved.');
        router.push(`/dashboard/procedures/${defaults.id}`);
        router.refresh();
      } else {
        const res = await createProcedureAction(payload);
        if (!res.ok) {
          toast.error(res.error.message);
          return;
        }
        toast.success('Procedure created. Add videos next.');
        // Send the author to the edit page so they can attach videos to
        // the freshly-created procedure.
        router.push(`/dashboard/procedures/${res.data.id}/edit`);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Replace a fluorescent ballast"
          maxLength={200}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Short description</Label>
        <Input
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One sentence summary"
          maxLength={2000}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="category">Category</Label>
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger id="category">
              <SelectValue placeholder="No category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NULL_VALUE}>No category</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="warehouse">Authoring warehouse</Label>
          <Select
            value={authoringWarehouseId}
            onValueChange={setAuthoringWarehouseId}
          >
            <SelectTrigger id="warehouse">
              <SelectValue placeholder="No warehouse" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NULL_VALUE}>No warehouse</SelectItem>
              {warehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="body">Instructions (Markdown)</Label>
        <Textarea
          id="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={14}
          placeholder={
            '## Tools needed\n- ladder\n- screwdriver\n\n## Steps\n1. Turn off the breaker.\n2. ...'
          }
          className="font-mono text-sm"
          maxLength={50_000}
        />
        <p className="text-xs text-muted-foreground">
          Supports standard Markdown — headings, lists, tables, task lists, and
          fenced code blocks. Raw HTML is not rendered.
        </p>
      </div>

      {isEdit && defaults?.id && (
        <div className="space-y-2">
          <Label>Videos</Label>
          <VideoUploader
            procedureId={defaults.id}
            organizationId={organizationId}
            initialVideos={videos}
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={busy} variant="gradient">
          {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {isEdit ? 'Save changes' : 'Create procedure'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.back()}
          disabled={busy}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
