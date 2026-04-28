import 'server-only';

import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

export class ItemImagesService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ItemImagesService(await withContext());
  }

  async list(itemId: string) {
    const { data, error } = await this.ctx.supabase
      .from('item_images')
      .select('id, storage_path, alt, sort_order, is_primary')
      .eq('organization_id', this.ctx.organizationId)
      .eq('item_id', itemId)
      .order('sort_order', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);
    return data ?? [];
  }

  async signedUrls(paths: string[]): Promise<Map<string, string>> {
    if (paths.length === 0) return new Map();
    const { data, error } = await this.ctx.supabase.storage
      .from('item-images')
      .createSignedUrls(paths, 60 * 60); // 1 hour
    if (error) throw new ServiceError('internal_error', error.message);
    const map = new Map<string, string>();
    for (const entry of data ?? []) {
      if (entry.signedUrl && entry.path) map.set(entry.path, entry.signedUrl);
    }
    return map;
  }

  async record(itemId: string, storagePath: string, isFirst: boolean) {
    assertPermission(this.ctx, 'items:update');
    const { data, error } = await this.ctx.supabase
      .from('item_images')
      .insert({
        organization_id: this.ctx.organizationId,
        item_id: itemId,
        storage_path: storagePath,
        is_primary: isFirst,
      })
      .select('id, storage_path, sort_order, is_primary')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    return data;
  }

  async remove(imageId: string) {
    assertPermission(this.ctx, 'items:update');
    const { data: img } = await this.ctx.supabase
      .from('item_images')
      .select('storage_path')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', imageId)
      .maybeSingle();
    if (!img) throw new ServiceError('not_found', 'Image not found');

    await this.ctx.supabase.storage.from('item-images').remove([img.storage_path as string]);
    const { error } = await this.ctx.supabase
      .from('item_images')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', imageId);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  /**
   * Returns a presigned upload URL the client can PUT directly to.
   * Path scheme: {organization_id}/items/{item_id}/{uuid}.{ext}
   * Storage RLS already restricts by organization id in the path.
   */
  async createUploadUrl(itemId: string, fileExt: string) {
    assertPermission(this.ctx, 'items:update');
    const safeExt = fileExt.replace(/[^a-z0-9]/gi, '').slice(0, 5).toLowerCase() || 'jpg';
    const fileName = `${crypto.randomUUID()}.${safeExt}`;
    const path = `${this.ctx.organizationId}/items/${itemId}/${fileName}`;
    const { data, error } = await this.ctx.supabase.storage
      .from('item-images')
      .createSignedUploadUrl(path);
    if (error) throw new ServiceError('internal_error', error.message);
    return { path, signedUrl: data.signedUrl, token: data.token };
  }
}
