/**
 * Capture a poster frame from a video file in the browser: load it into an
 * off-DOM <video>, seek a beat past the start (frame 0 is often black),
 * draw to a canvas capped at 640px wide, and encode a JPEG.
 *
 * Best-effort by design — returns null on any failure (unsupported codec,
 * decode error, canvas taint) and the caller records the video without a
 * poster; the Procedures grid then falls back to the old video-first-frame
 * trick for that row.
 */
export async function captureVideoPoster(file: File): Promise<Blob | null> {
  try {
    const url = URL.createObjectURL(file);
    try {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      video.src = url;

      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error('metadata load failed'));
      });

      // ~1s in, clamped to the middle of very short clips.
      const target = Math.min(1, (video.duration || 2) / 2);
      await new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error('seek failed'));
        video.currentTime = target;
      });

      const width = Math.min(640, video.videoWidth || 640);
      const scale = width / (video.videoWidth || width);
      const height = Math.round((video.videoHeight || width * 0.5625) * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d) return null;
      ctx2d.drawImage(video, 0, 0, width, height);

      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.8);
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}
