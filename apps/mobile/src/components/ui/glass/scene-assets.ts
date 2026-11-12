import type { ImageSourcePropType } from 'react-native';

/**
 * The scene illustrations: the out-of-focus stockroom behind Liquid Glass,
 * light for Day glass and dark for Night glass, pre-blurred so no list ever
 * has a live blur behind it (plan 5.2 content layer, 5.3, 5.5).
 *
 * The illustrations were made for StockPilot by Claude Design during the
 * Liquid Glass design work (confirmed 2026-11-05). The two 1200x750 phone
 * copies are committed: scripts/liquid-glass/install-scene.mjs writes them
 * from the originals into apps/mobile/assets/liquid-glass/ and pins their
 * SHA-256 in scripts/liquid-glass/scene-files.sha256.
 *
 * Plain requires, never inside a try block: Metro resolves both when it
 * bundles (a dev build, `expo export`, a store build, an OTA), so a missing
 * file fails the bundle instead of leaving the scene off without a word.
 * Both phone update scripts first run scripts/refuse-uncommitted-scene.sh,
 * which refuses a scene file that is missing or is not the committed, pinned
 * one. Which one is drawn is SceneBackground's choice (Day the day file,
 * Night the night file, neither in classic or under Reduce Transparency).
 * scene-assets.test.ts runs Metro's own dependency collector under this
 * app's Metro config on this file, the run-time mapping and that guard.
 */
const day = require('../../../../assets/liquid-glass/scene-light.jpg') as ImageSourcePropType;
const night = require('../../../../assets/liquid-glass/scene-dark.jpg') as ImageSourcePropType;

export const SCENE_IMAGES: { day: ImageSourcePropType; night: ImageSourcePropType } = {
  day,
  night,
};
