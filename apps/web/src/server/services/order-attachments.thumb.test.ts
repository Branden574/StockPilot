import { describe, expect, it } from 'vitest';

import { attachmentWantsThumb } from './order-attachments';

// Which attachments get a ~400px transformed grid variant. HEIC/HEIF must
// NOT request a transform (Supabase's transformer can't decode them — the
// signed URL would mint fine and then 400 at fetch time), and non-images
// (PDFs) never should.
describe('attachmentWantsThumb', () => {
  it('thumbs standard raster images', () => {
    for (const ct of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      expect(attachmentWantsThumb(ct)).toBe(true);
    }
  });

  it('skips HEIC/HEIF (transform cannot decode them)', () => {
    expect(attachmentWantsThumb('image/heic')).toBe(false);
    expect(attachmentWantsThumb('image/heif')).toBe(false);
  });

  it('skips non-images and unknown types', () => {
    expect(attachmentWantsThumb('application/pdf')).toBe(false);
    expect(attachmentWantsThumb(null)).toBe(false);
    expect(attachmentWantsThumb('')).toBe(false);
  });
});
