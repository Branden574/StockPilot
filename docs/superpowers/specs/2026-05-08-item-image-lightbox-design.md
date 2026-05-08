# Item Image Lightbox + Always-Visible Delete

**Date:** 2026-05-08
**Status:** Approved (proceeding to implementation plan)
**Owner:** Branden Vincent-Walker

## Goal

Make item images viewable full-screen with zoom, navigation, and download, and make the per-image delete button discoverable on touch devices and at-a-glance on desktop. Books inherit the change automatically because books are inventory items rendered through the same component.

## Scope

- **In:** `<ImageUploader>` on the item detail page (`/dashboard/inventory/[id]`)
- **Out:** Listing thumbnails (inventory list, books list), edit form, image reordering, alt text editing, multi-select delete, the ISBN-fetched cover preview card

## User-visible behavior

1. Each thumbnail in the image grid shows a small trash icon in the top-right corner. The icon is always visible (not hover-gated) and renders on a `bg-black/65` chip so it stays readable on light photos.
2. Clicking anywhere on a thumbnail (other than the trash icon) opens a full-screen lightbox at that image.
3. The lightbox supports:
   - Big image rendered with `object-contain` so the whole photo is visible
   - Prev/next arrow buttons and keyboard ← / →
   - ESC to close (handled by Radix Dialog)
   - "N of M" counter top-center
   - Toolbar top-right: Zoom out · Zoom in · Download · Delete
   - Mouse wheel zooms on desktop (smooth, clamped to 1×–4×); pinch zooms on mobile (same range)
   - Click on the image toggles zoom: 1× → 2×, or any zoom > 1× → 1× (lets touch-only users zoom without a wheel/pinch)
   - When zoom > 1×, drag-to-pan with mouse or single-finger touch
   - Click on the dark backdrop (outside the image) closes the lightbox
4. Deleting from the lightbox advances to the next image, or closes the lightbox if it was the last.
5. Delete uses the existing native `confirm('Remove this image?')` flow from BOTH the grid trash and the lightbox delete button (single behavior, single backend call).

## Architecture

### Files modified

- `apps/web/src/components/inventory/image-uploader.tsx`
  - Drop `opacity-0 group-hover:opacity-100` from the trash button; raise contrast.
  - Wrap thumbnail `<img>` in a `<button>` that sets a local `lightboxIndex` state.
  - Render `<ImageLightbox>` when `lightboxIndex !== null`.
  - Pass `onDelete` to the lightbox so deletion can also originate from there.

### Files added

- `apps/web/src/components/inventory/image-lightbox.tsx`
  - Client component built on the existing `Dialog` primitive (`@radix-ui/react-dialog` is already in `package.json`).
  - Props:
    ```ts
    interface ImageLightboxProps {
      images: Array<{ id: string; url: string; isPrimary: boolean }>;
      startIndex: number;
      onClose: () => void;
      onDelete: (imageId: string) => Promise<void> | void;
    }
    ```
  - Internal state: `currentIndex`, `zoom` (number, 1 / 2 / etc.), `pan` ({ x, y }), `isDragging`.
  - Keyboard handler attached to `document` while open: `ArrowLeft`, `ArrowRight`, `Escape`.
  - Wheel handler on the image container clamps `zoom` between 1 and 4.
  - Touch handlers: track two-finger distance, set `zoom` from delta.
  - Download: `<a download href={url}>` with the filename set to the storage path's basename (a UUID, e.g. `abc123.jpg`). Renaming to `${item.name}-N.jpg` is a follow-up — would require passing item context into the component.

### No backend changes

- `removeImageAction` already exists and handles the storage + DB delete.
- No new RPCs, no new RLS policies, no migration.
- No new dependencies — Radix Dialog is already installed.

## Edge cases

- **Single image:** prev/next buttons hidden when `images.length === 1`.
- **Delete the only image:** lightbox closes after the confirm.
- **Delete the primary:** existing service ordering already falls back to first-by-`sort_order` when no primary exists, so the listing tile keeps showing a cover.
- **Very large image (e.g., 10MB AVIF):** uses `loading="eager"` on the active slide only; neighbors stay lazy.
- **Network failure on download:** browser handles it; no custom error state.
- **Lightbox open while user navigates away:** `useEffect` cleanup removes the keydown listener.

## Testing

Manual:
- Item detail with 1 / 3 / 5+ images
- Click each thumbnail → lightbox opens at the right index
- Arrow keys + ESC navigate
- Wheel zoom on desktop; pinch zoom on mobile (Chrome DevTools touch sim is fine)
- Delete from grid + delete from lightbox; both update the grid and the lightbox state
- Download produces a sensible filename

Automated: not adding lightbox unit tests — UI-only, no logic worth pinning. The existing `removeImageAction` already has its server-side coverage.

## Out-of-scope follow-ups

These are explicitly *not* part of this work but are reasonable next steps:
- Set primary from inside the lightbox
- Drag-to-reorder the grid
- Editing image alt text
- Adding lightbox to listing thumbnails
- Replacing native `confirm()` with a styled AlertDialog (would require adding `@radix-ui/react-alert-dialog`)

## Decision log

| Decision | Why |
|---|---|
| Build lightbox from scratch on Dialog primitive (no `yet-another-react-lightbox` etc.) | No new dep / lockfile churn; ~150 lines total; matches existing visual language |
| Keep native `confirm()` for delete | Existing pattern; styled modal needs new dep |
| Detail page only (not listings or edit form) | Smallest blast radius; explicit user choice |
| No "Set primary" inside lightbox | Out of scope; primary editing is a separate UX flow |
| Zoom states cycle on click (1× → 2× → reset) | Simple alternative to a slider for users who don't have a wheel/pinch |
