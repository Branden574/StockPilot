/**
 * The Liquid Glass scene photo (the out-of-focus stockroom behind Day and
 * Night glass; spec/design-system.md 3.1-3.2, FOLLOWUPS SC1).
 *
 * THE PHOTOS ARE NOT IN THE REPOSITORY. The repository is public and the
 * owner has not yet confirmed where they came from, so they are installed
 * locally by scripts/liquid-glass/install-scene.mjs (sha-checked) into
 * apps/web/public/liquid-glass/, a path .gitignore covers. next.config.ts
 * checks at build time whether every web file is there and inlines the answer
 * as NEXT_PUBLIC_LIQUID_GLASS_SCENE. Only then does app/layout.tsx emit
 * scenePhotoCss(), which sets --lg-scene-photo; the glass material reads it
 * through var(--lg-scene-photo, none) (tokens.generated.css). Without the
 * photos nothing references them: no request, no 404, and the opaque --bg
 * shows, the documented fallback (and what every CI and Vercel build does
 * until the photos are committed). The reduced, contrast and forced-colours
 * materials never draw the photo.
 *
 * Plain module, NO IMPORTS: next.config.ts reads it.
 */

export const SCENE_PHOTO_FLAG_NAME = 'NEXT_PUBLIC_LIQUID_GLASS_SCENE';

/** Where the web serves the photos from (apps/web/public/liquid-glass). */
export const SCENE_PUBLIC_PATH = '/liquid-glass';

const SCHEMES = ['light', 'dark'] as const;
type SceneScheme = (typeof SCHEMES)[number];

/** The web files install-scene.mjs writes, by scheme (pinned to its SCENE_OUTPUTS by a test). */
function filesOf(scheme: SceneScheme) {
  return {
    jpg: `scene-${scheme}.jpg`,
    avif1x: `scene-${scheme}-1x.avif`,
    webp1x: `scene-${scheme}-1x.webp`,
    avif2x: `scene-${scheme}-2x.avif`,
    webp2x: `scene-${scheme}-2x.webp`,
  };
}

/** Every web file the photo needs; the build turns the photo on only when all are present. */
export const SCENE_WEB_FILES: readonly string[] = SCHEMES.flatMap((scheme) =>
  Object.values(filesOf(scheme)),
);

/**
 * Whether every web file is installed, given a way to test one file name
 * (next.config.ts passes an existsSync over apps/web/public/liquid-glass).
 */
export function isScenePhotoInstalled(exists: (fileName: string) => boolean): boolean {
  return SCENE_WEB_FILES.every((name) => exists(name));
}

/** True when this build found the installed photos (inlined by next.config.ts). */
export function isScenePhotoBuilt(): boolean {
  return process.env.NEXT_PUBLIC_LIQUID_GLASS_SCENE === '1';
}

/**
 * The photo for one scheme: AVIF, then WebP, at 1x (1200 px) and 2x (2400
 * px), then the original JPEG. A background is never preloaded, so a page
 * that is not glass never fetches it.
 */
export function sceneImageSet(scheme: SceneScheme): string {
  const f = filesOf(scheme);
  const url = (name: string) => `url("${SCENE_PUBLIC_PATH}/${name}")`;
  return (
    'image-set(' +
    [
      `${url(f.avif1x)} 1x type("image/avif")`,
      `${url(f.avif2x)} 2x type("image/avif")`,
      `${url(f.webp1x)} 1x type("image/webp")`,
      `${url(f.webp2x)} 2x type("image/webp")`,
      `${url(f.jpg)} 2x type("image/jpeg")`,
    ].join(',') +
    ')'
  );
}

/**
 * The inline style app/layout.tsx emits when the photos were built in. It
 * declares only --lg-scene-photo, Day on the glass root and Night on its
 * .dark form, inside @media screen. Unlayered on purpose: nothing else
 * declares this property, so no layer order can matter, and an inline style
 * that named a layer before globals.css's links would reorder the layers.
 */
export function scenePhotoCss(): string {
  const root = ':root[data-appearance="liquid-glass"]';
  return (
    '@media screen{' +
    `${root}{--lg-scene-photo:${sceneImageSet('light')}}` +
    `${root}.dark{--lg-scene-photo:${sceneImageSet('dark')}}` +
    '}'
  );
}
