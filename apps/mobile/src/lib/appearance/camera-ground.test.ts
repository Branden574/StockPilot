import { afterEach, describe, expect, it, vi } from 'vitest';

import { cameraGroundShown, retainCameraGround, subscribeCameraGround } from './camera-ground';

/**
 * The Scan tab's dark camera page tells the Liquid Glass tab bar it is the
 * ground under it (LG-1). A count, so two holders at once (a remount that
 * overlaps) never drop the flag early.
 */
describe('camera ground', () => {
  const releases: (() => void)[] = [];
  const retain = () => {
    const release = retainCameraGround();
    releases.push(release);
    return release;
  };
  afterEach(() => {
    for (const release of releases.splice(0)) release();
  });

  it('is not shown until a camera page holds it, and not after it lets go', () => {
    expect(cameraGroundShown()).toBe(false);
    const release = retain();
    expect(cameraGroundShown()).toBe(true);
    release();
    expect(cameraGroundShown()).toBe(false);
  });

  it('two holders need two releases, and a second call of one release does nothing', () => {
    const first = retain();
    const second = retain();
    first();
    first();
    expect(cameraGroundShown()).toBe(true);
    second();
    expect(cameraGroundShown()).toBe(false);
    first();
    second();
    expect(cameraGroundShown()).toBe(false);
  });

  it('tells its listeners each time the answer changes, and only then', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCameraGround(listener);
    const first = retain();
    expect(listener).toHaveBeenCalledTimes(1);
    const second = retain();
    expect(listener).toHaveBeenCalledTimes(1);
    first();
    expect(listener).toHaveBeenCalledTimes(1);
    second();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    retain();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
