/**
 * The largest object each upload path takes, in bytes: its storage bucket's
 * own file_size_limit, so the finalize check (server/security/upload-checks.ts
 * checkStoredUpload, part 6) never reads past what the bucket would have let
 * in. Each is the migration that set it.
 */

const MB = 1024 * 1024;

/** item-images (0047). */
export const ITEM_IMAGE_MAX_BYTES = 10 * MB;
/** user-avatars and org-logos (0047). */
export const AVATAR_MAX_BYTES = 5 * MB;
export const ORG_LOGO_MAX_BYTES = 5 * MB;
/** support-attachments (0260). */
export const SUPPORT_SCREENSHOT_MAX_BYTES = 5 * MB;
/** po-attachments (0211) and order-attachments (0143). */
export const PO_ATTACHMENT_MAX_BYTES = 15 * MB;
export const ORDER_ATTACHMENT_MAX_BYTES = 15 * MB;
/** procedure-videos (0187): the video. */
export const PROCEDURE_VIDEO_MAX_BYTES = 1024 * MB;
/**
 * The poster of a procedure video, in the same bucket: a frame the app makes
 * at 640 pixels wide (components/procedures/capture-poster.ts), far under
 * this. The bucket's own cap is the video's, which no picture needs.
 */
export const PROCEDURE_POSTER_MAX_BYTES = 2 * MB;
