import type { ImageSourcePropType } from 'react-native';

/**
 * The artifact's scene images: the out-of-focus stockroom photo behind Liquid
 * Glass, day for Day glass and night for Night glass, pre-blurred so no list
 * ever has a live blur behind it (plan 5.2 content layer, 5.5).
 *
 * NOT IN THE REPOSITORY YET. The two JPEGs (artifact assets e3383aa6... day,
 * 207,961 bytes, and e173ee98... night, 178,986 bytes) are listed in the
 * artifact but cannot be read by the tools; the owner was asked to export them
 * (stockpilot-work/liquid-glass/DECISIONS.md Q7). Until they are added here
 * (as `require('../../../../assets/liquid-glass/scene-day.jpg')` and so on,
 * pre-blurred, about 150 KB each), SceneBackground draws the opaque --bg
 * fallback the artifact itself names ("fallback --bg, opaque"), and no glass
 * screen is called an exact match.
 */
export const SCENE_IMAGES: { day: ImageSourcePropType | null; night: ImageSourcePropType | null } =
  {
    day: null,
    night: null,
  };
