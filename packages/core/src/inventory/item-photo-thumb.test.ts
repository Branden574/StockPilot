import { describe, expect, it } from 'vitest';

import { ITEM_PHOTO_THUMB, itemPhotoThumbFormat, itemPhotoThumbSize } from './item-photo-thumb';

/**
 * The phone's item photo thumbnail (docket B31): the same size as the web's
 * (200 px longest edge, aspect kept, never enlarged), in a format that keeps
 * what the master had.
 */
describe('itemPhotoThumbSize', () => {
  it('is the 200 px longest edge the web thumbnail has', () => {
    expect(ITEM_PHOTO_THUMB).toEqual({ maxEdge: 200, quality: 0.8 });
  });

  it('shrinks a landscape photo to 200 px wide, aspect kept', () => {
    // The phone uploads at most 1600 px on the long edge (image-resize.ts).
    expect(itemPhotoThumbSize(1600, 1200)).toEqual({ width: 200, height: 150 });
    expect(itemPhotoThumbSize(4032, 3024)).toEqual({ width: 200, height: 150 });
  });

  it('shrinks a portrait photo to 200 px tall, aspect kept', () => {
    expect(itemPhotoThumbSize(1200, 1600)).toEqual({ width: 150, height: 200 });
    expect(itemPhotoThumbSize(900, 1600)).toEqual({ width: 113, height: 200 });
  });

  it('shrinks a square photo to 200 x 200', () => {
    expect(itemPhotoThumbSize(1600, 1600)).toEqual({ width: 200, height: 200 });
  });

  it('never enlarges a photo that already fits', () => {
    expect(itemPhotoThumbSize(120, 80)).toEqual({ width: 120, height: 80 });
    expect(itemPhotoThumbSize(200, 200)).toEqual({ width: 200, height: 200 });
    expect(itemPhotoThumbSize(200, 120)).toEqual({ width: 200, height: 120 });
  });

  it('shrinks when only one edge is too long', () => {
    expect(itemPhotoThumbSize(201, 100)).toEqual({ width: 200, height: 100 });
    expect(itemPhotoThumbSize(100, 400)).toEqual({ width: 50, height: 200 });
  });

  it('never yields a zero edge for an extreme strip', () => {
    expect(itemPhotoThumbSize(4000, 1)).toEqual({ width: 200, height: 1 });
    expect(itemPhotoThumbSize(1, 4000)).toEqual({ width: 1, height: 200 });
  });
});

describe('itemPhotoThumbFormat', () => {
  it('is JPEG for a JPEG master (camera photos, and every photo the phone shrank)', () => {
    expect(itemPhotoThumbFormat('jpg')).toBe('jpg');
    expect(itemPhotoThumbFormat('jpeg')).toBe('jpg');
    expect(itemPhotoThumbFormat('JPG')).toBe('jpg');
  });

  it('is PNG for a master that may be transparent, so its background is not painted black', () => {
    expect(itemPhotoThumbFormat('png')).toBe('png');
    expect(itemPhotoThumbFormat('webp')).toBe('png');
    expect(itemPhotoThumbFormat('PNG')).toBe('png');
  });
});
