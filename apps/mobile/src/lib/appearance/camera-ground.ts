import * as React from 'react';

/**
 * Whether the Scan tab's camera page is mounted (LG-1).
 *
 * That page is dark in every scheme: the glass viewfinder is black
 * (components/ui/glass/screens/scan.tsx) with the live camera over it. The
 * Liquid Glass tab capsule floats over it, and the system glass of a small
 * bar takes its light or dark form from what is behind it, whatever scheme it
 * was given: in Day it drew near-black while the icons and labels kept the Day
 * ink, so they could not be seen. The page holds this while it is mounted
 * (components/ui/glass/camera-ground.tsx) and the tab bar draws its Night
 * look while the Scan tab is the one in front (appearance/tab-bar.ts
 * glassTabBarLook).
 *
 * A count, not a flag: a remount that overlaps the old page never drops it
 * early. Each release works once.
 */
let holders = 0;
const listeners = new Set<() => void>();

export function cameraGroundShown(): boolean {
  return holders > 0;
}

/** Hold the camera ground; the returned function lets go (once). */
export function retainCameraGround(): () => void {
  let held = true;
  holders += 1;
  if (holders === 1) listeners.forEach((fn) => fn());
  return () => {
    if (!held) return;
    held = false;
    holders -= 1;
    if (holders === 0) listeners.forEach((fn) => fn());
  };
}

export function subscribeCameraGround(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Reactive cameraGroundShown. */
export function useCameraGround(): boolean {
  return React.useSyncExternalStore(subscribeCameraGround, cameraGroundShown, cameraGroundShown);
}
