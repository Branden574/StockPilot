import type { ImageSourcePropType } from 'react-native';

/**
 * The artifact's scene photos: the out-of-focus stockroom behind Liquid
 * Glass, light for Day glass and dark for Night glass, pre-blurred so no list
 * ever has a live blur behind it (plan 5.2 content layer, 5.3, 5.5).
 *
 * NOT IN THE REPOSITORY. The repository is public and the owner has not yet
 * confirmed where the photos came from (FOLLOWUPS SC1), so they are installed
 * locally, never committed: `node scripts/liquid-glass/install-scene.mjs
 * <folder>` checks both originals' SHA-256 and writes the pre-blurred
 * 1200x750 phone copies to apps/mobile/assets/liquid-glass/scene-light.jpg
 * and scene-dark.jpg, paths .gitignore lists.
 *
 * Each require sits directly inside a try block, which makes it OPTIONAL for
 * Metro (Expo's Metro config sets allowOptionalDependencies): a bundle built
 * without the files still builds, and the require throws at run time, so the
 * scene is null and SceneBackground draws the opaque --bg, the fallback the
 * artifact itself names. With the files installed before `expo export` or
 * `eas update`, they are bundled and drawn. scene-assets.test.ts pins the
 * paths to the install script's.
 */
let day: ImageSourcePropType | null = null;
let night: ImageSourcePropType | null = null;
try {
  day = require('../../../../assets/liquid-glass/scene-light.jpg') as ImageSourcePropType;
} catch {
  day = null;
}
try {
  night = require('../../../../assets/liquid-glass/scene-dark.jpg') as ImageSourcePropType;
} catch {
  night = null;
}

export const SCENE_IMAGES: { day: ImageSourcePropType | null; night: ImageSourcePropType | null } =
  { day, night };
