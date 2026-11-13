import * as React from 'react';

import { retainCameraGround } from '../../../lib/appearance/camera-ground';

/**
 * Drawn (as nothing) by a page whose ground under the tab bar is the camera:
 * while it is mounted the Liquid Glass tab bar draws its Night look over that
 * page (LG-1; lib/appearance/camera-ground.ts). Used only inside an `lg`
 * branch, so Classic never mounts it.
 */
export function CameraGround(): null {
  React.useEffect(() => retainCameraGround(), []);
  return null;
}
