import { describe, expect, it } from 'vitest';

import {
  hasUnsafeStorageSegment,
  isBoundarySafeStoragePath,
  isValidStoragePath,
  itemImageAnyPathShape,
  itemImagePathShape,
  maintenanceAttachmentPathShape,
  MAX_STORAGE_PATH_LENGTH,
  orderAttachmentPathShape,
  orgLogoPathShape,
  poAttachmentPathShape,
  poImportPathShape,
  procedureVideoPathShape,
} from './storage-path';

/**
 * The security property under test, stated once so every case below can be
 * read against it:
 *
 *   A caller-supplied storage path must be accepted ONLY when it is exactly a
 *   path one of this product's uploaders mints, under the SERVER's own org id
 *   and the entity id of the call it arrived on. Everything else is refused —
 *   and in particular no encoding of "climb out of this folder" may be
 *   expressible, because the path is interpolated into a fetch() URL by
 *   @supabase/storage-js and the WHATWG URL parser resolves `..` segments
 *   before the request leaves Node, so a traversal escapes the org prefix AND
 *   the bucket while a `startsWith` check still passes.
 *
 * These are asserted as the PROPERTY, never as observed behavior: the matrix
 * below is applied uniformly to EVERY shape, so a shape added later without
 * the same protections fails here rather than shipping.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const ENTITY = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const OTHER_ENTITY = '88888888-8888-4888-8888-888888888888';
const FILE = '33333333-3333-4333-8333-333333333333.webp';

/** Built with fromCharCode rather than written as literals: a raw NUL or DEL
 *  in a source file is invisible in a diff and easily lost in transit, and
 *  these two bytes are the payload — the test would silently stop testing
 *  anything if one were mangled into a space. */
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(0x7f);

/**
 * Every shape this module exposes, with a legitimate path for it and the
 * "directory" prefix hostile variants are built from.
 *
 * `legit` values are the REAL mint conventions, read off the writers:
 *   item-image           ItemImagesService.createUploadUrl
 *   order-attachment     order-attachments-panel.tsx
 *   procedure-video      video-uploader.tsx (+ its .poster.jpg sibling)
 *   maintenance          MaintenanceAttachmentsService.createUploadUrl
 *   po-attachment        po-attachments-panel.tsx / mobile po-attachments.tsx
 *   po-import            PoImportsService.presignUpload / createFromScan
 *   org-logo             org-logo-uploader.tsx
 */
const SHAPES = [
  {
    name: 'itemImagePathShape',
    shape: () => itemImagePathShape(ORG, ENTITY),
    dir: `${ORG}/items/${ENTITY}`,
    legit: [
      `${ORG}/items/${ENTITY}/${FILE}`,
      `${ORG}/items/${ENTITY}/33333333-3333-4333-8333-333333333333-thumb.webp`,
    ],
    wrongOrg: `${OTHER_ORG}/items/${ENTITY}/${FILE}`,
    wrongEntity: `${ORG}/items/${OTHER_ENTITY}/${FILE}`,
  },
  {
    name: 'itemImageAnyPathShape',
    shape: () => itemImageAnyPathShape(),
    dir: `${ORG}/items/${ENTITY}`,
    legit: [
      `${ORG}/items/${ENTITY}/${FILE}`,
      // The books-import cover rehost's shorter form.
      `${ORG}/${ENTITY}/cover.jpg`,
      // Mobile's base36 filename.
      `${ORG}/items/${ENTITY}/k3j4h5g6f7d8.jpg`,
    ],
    // Structural by design — it cannot pin ids, because the owning org is
    // exactly what is unknown at its call site (an unauthenticated public
    // page). Item-level pinning is enforced on the WRITE side instead.
    wrongOrg: null,
    wrongEntity: null,
  },
  {
    name: 'orderAttachmentPathShape',
    shape: () => orderAttachmentPathShape(ORG, ENTITY),
    dir: `${ORG}/${ENTITY}`,
    legit: [`${ORG}/${ENTITY}/${FILE}`, `${ORG}/${ENTITY}/33333333-3333-4333-8333-333333333333.pdf`],
    wrongOrg: `${OTHER_ORG}/${ENTITY}/${FILE}`,
    wrongEntity: `${ORG}/${OTHER_ENTITY}/${FILE}`,
  },
  {
    name: 'procedureVideoPathShape',
    shape: () => procedureVideoPathShape(ORG, ENTITY),
    dir: `${ORG}/${ENTITY}`,
    legit: [
      `${ORG}/${ENTITY}/33333333-3333-4333-8333-333333333333.mp4`,
      // The poster frame — two dotted groups, which is why
      // OBJECT_FILENAME_SEGMENT allows more than one.
      `${ORG}/${ENTITY}/33333333-3333-4333-8333-333333333333.poster.jpg`,
    ],
    wrongOrg: `${OTHER_ORG}/${ENTITY}/33333333-3333-4333-8333-333333333333.mp4`,
    wrongEntity: `${ORG}/${OTHER_ENTITY}/33333333-3333-4333-8333-333333333333.mp4`,
  },
  {
    name: 'maintenanceAttachmentPathShape',
    shape: () => maintenanceAttachmentPathShape(ORG, ENTITY),
    dir: `${ORG}/${ENTITY}`,
    legit: [
      `${ORG}/${ENTITY}/33333333-3333-4333-8333-333333333333.jpg`,
      `${ORG}/${ENTITY}/33333333-3333-4333-8333-333333333333.png`,
      `${ORG}/${ENTITY}/33333333-3333-4333-8333-333333333333.webp`,
      `${ORG}/${ENTITY}/33333333-3333-4333-8333-333333333333.jpeg`,
    ],
    wrongOrg: `${OTHER_ORG}/${ENTITY}/33333333-3333-4333-8333-333333333333.jpg`,
    wrongEntity: `${ORG}/${OTHER_ENTITY}/33333333-3333-4333-8333-333333333333.jpg`,
  },
  {
    name: 'poAttachmentPathShape',
    shape: () => poAttachmentPathShape(ORG, ENTITY),
    dir: `${ORG}/${ENTITY}`,
    legit: [
      // Web: crypto.randomUUID().
      `${ORG}/${ENTITY}/33333333-3333-4333-8333-333333333333.pdf`,
      // Mobile: Math.random().toString(36).slice(2, 14).
      `${ORG}/${ENTITY}/k3j4h5g6f7d8.pdf`,
    ],
    wrongOrg: `${OTHER_ORG}/${ENTITY}/33333333-3333-4333-8333-333333333333.pdf`,
    wrongEntity: `${ORG}/${OTHER_ENTITY}/33333333-3333-4333-8333-333333333333.pdf`,
  },
  {
    name: 'poImportPathShape',
    shape: () => poImportPathShape(ORG),
    dir: `${ORG}/po-imports`,
    legit: [
      // presignUpload: randomUUID + a server-chosen extension.
      `${ORG}/po-imports/33333333-3333-4333-8333-333333333333.pdf`,
      `${ORG}/po-imports/33333333-3333-4333-8333-333333333333.csv`,
      // createFromScan: the 64-hex sha256 of the uploaded bytes.
      `${ORG}/po-imports/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.pdf`,
      `${ORG}/po-imports/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.jpg`,
    ],
    wrongOrg: `${OTHER_ORG}/po-imports/33333333-3333-4333-8333-333333333333.pdf`,
    // A PO import has no parent entity at upload time, so the only "wrong
    // entity" available is the literal folder segment.
    wrongEntity: `${ORG}/order-attachments/33333333-3333-4333-8333-333333333333.pdf`,
  },
  {
    name: 'orgLogoPathShape',
    shape: () => orgLogoPathShape(ORG),
    dir: ORG,
    legit: [`${ORG}/logo-1754870000000.png`, `${ORG}/logo-1754870000000.avif`],
    wrongOrg: `${OTHER_ORG}/logo-1754870000000.png`,
    wrongEntity: null,
  },
] as const;

describe.each(SHAPES)('$name', (entry) => {
  it('accepts every REAL mint convention for this surface', () => {
    for (const path of entry.legit) {
      expect(isValidStoragePath(path, entry.shape()), path).toBe(true);
    }
  });

  it('REFUSES a literal `..` traversal that a startsWith(org) check would pass', () => {
    // The exact finding: prefix intact, escapes the org folder AND the bucket
    // once the URL parser normalizes it.
    expect(
      isValidStoragePath(`${entry.dir}/../../item-images/victim-org/victim-item/cover.jpg`, entry.shape()),
    ).toBe(false);
    expect(isValidStoragePath(`${entry.dir}/../${FILE}`, entry.shape())).toBe(false);
    // A bare `.` segment normalizes away and must be refused for the same reason.
    expect(isValidStoragePath(`${entry.dir}/./${FILE}`, entry.shape())).toBe(false);
  });

  it('REFUSES the percent-encoded and double-encoded traversals', () => {
    expect(
      isValidStoragePath(`${entry.dir}/%2e%2e/%2e%2e/order-attachments/victim/proof.jpg`, entry.shape()),
    ).toBe(false);
    expect(isValidStoragePath(`${entry.dir}/%252e%252e/item-images/victim/x.jpg`, entry.shape())).toBe(
      false,
    );
    // %2f is an encoded separator — same family, same single rule.
    expect(isValidStoragePath(`${entry.dir}%2f..%2f${FILE}`, entry.shape())).toBe(false);
  });

  it('REFUSES an absolute path, a backslash, an empty segment and a bucket hop', () => {
    expect(isValidStoragePath(`/${entry.dir}/${FILE}`, entry.shape())).toBe(false);
    expect(isValidStoragePath(`${entry.dir}\\..\\..\\item-images\\victim\\x.jpg`, entry.shape())).toBe(
      false,
    );
    expect(isValidStoragePath(`${entry.dir}//${FILE}`, entry.shape())).toBe(false);
    // A different bucket named as a leading segment.
    expect(isValidStoragePath(`item-images/${entry.dir}/${FILE}`, entry.shape())).toBe(false);
  });

  it('REFUSES an embedded NUL and a trailing newline', () => {
    // The NUL truncation payload: everything after it is dropped by some C
    // string consumers, so `photo.jpg<NUL>.html` can be stored as one thing and
    // served as another.
    expect(isValidStoragePath(`${entry.dir}/photo.jpg${NUL}.html`, entry.shape())).toBe(false);
    expect(isValidStoragePath(`${entry.dir}/${FILE}\n`, entry.shape())).toBe(false);
    expect(isValidStoragePath(`${entry.dir}/${FILE}\r\n`, entry.shape())).toBe(false);
    expect(isValidStoragePath(`${entry.dir}/${FILE}\t`, entry.shape())).toBe(false);
    expect(isValidStoragePath(`${entry.dir}/${FILE}${DEL}`, entry.shape())).toBe(false);
  });

  it('REFUSES an over-length path and the empty string', () => {
    expect(isValidStoragePath('a'.repeat(MAX_STORAGE_PATH_LENGTH + 1), entry.shape())).toBe(false);
    expect(isValidStoragePath('', entry.shape())).toBe(false);
  });

  it('REFUSES a path that trails extra segments past the filename', () => {
    // A shape that forgot its `$` anchor would accept this — the filename
    // would match and the rest would be ignored, so an attacker could append
    // a whole second path.
    const first = entry.legit[0]!;
    expect(isValidStoragePath(`${first}/extra/segments.jpg`, entry.shape())).toBe(false);
    // And a path that PRE-pends, which a missing `^` anchor would accept.
    expect(isValidStoragePath(`prefix/${first}`, entry.shape())).toBe(false);
  });

  it('REFUSES a wrong org id and a wrong entity id where the shape pins them', () => {
    if (entry.wrongOrg) {
      expect(isValidStoragePath(entry.wrongOrg, entry.shape())).toBe(false);
    }
    if (entry.wrongEntity) {
      expect(isValidStoragePath(entry.wrongEntity, entry.shape())).toBe(false);
    }
  });
});

describe('the two shapes that deliberately do NOT pin ids', () => {
  it('itemImageAnyPathShape accepts any org/item pair — and that is the documented trade, because its caller (the public item page) does not know the owning org', () => {
    expect(isValidStoragePath(`${OTHER_ORG}/items/${OTHER_ENTITY}/${FILE}`, itemImageAnyPathShape())).toBe(
      true,
    );
    // What it still guarantees — the HI-8 property — is that no traversal,
    // bucket hop or absolute path can be expressed.
    expect(
      isValidStoragePath(`${OTHER_ORG}/items/${OTHER_ENTITY}/../../x/y.jpg`, itemImageAnyPathShape()),
    ).toBe(false);
    // It is still structurally strict: the ids must be UUID-shaped, so a
    // free-form folder name is refused.
    expect(isValidStoragePath(`not-a-uuid/items/${OTHER_ENTITY}/${FILE}`, itemImageAnyPathShape())).toBe(
      false,
    );
  });

  it('isBoundarySafeStoragePath is a weaker EDGE guard, not a substitute for the service-layer shape', () => {
    // It admits any org/entity pair (a schema does not know the caller's org),
    // which is exactly why the service-layer check has to stay load-bearing.
    expect(isBoundarySafeStoragePath(`${OTHER_ORG}/items/${OTHER_ENTITY}/${FILE}`)).toBe(true);
    // But it still refuses the whole traversal family.
    expect(isBoundarySafeStoragePath(`${ORG}/../../item-images/victim/x.jpg`)).toBe(false);
    expect(isBoundarySafeStoragePath(`/${ORG}/items/${ENTITY}/${FILE}`)).toBe(false);
    expect(isBoundarySafeStoragePath(`${ORG}/%2e%2e/x.jpg`)).toBe(false);
    expect(isBoundarySafeStoragePath('')).toBe(false);
  });
});

describe('hasUnsafeStorageSegment — layer (b), the belt-and-braces denylist', () => {
  /**
   * This layer exists so a subtle bug in a shape regex (a missing anchor, a
   * forgotten escape) is not the ONLY thing between a hostile path and a
   * service-role storage call. It is therefore tested INDEPENDENTLY of any
   * shape: it has to hold on its own.
   */
  it('refuses every member of the traversal alphabet on its own, with no shape involved', () => {
    for (const bad of [
      `${ORG}/../${FILE}`,
      `${ORG}/./${FILE}`,
      '..',
      `${ORG}/%2e%2e/${FILE}`,
      `${ORG}/%252e%252e/${FILE}`,
      `${ORG}\\${FILE}`,
      `/${ORG}/${FILE}`,
      `${ORG}//${FILE}`,
      `${ORG}/${FILE}${NUL}`,
      `${ORG}/${FILE}\n`,
      `${ORG}/${FILE}${DEL}`,
      '',
      'a'.repeat(MAX_STORAGE_PATH_LENGTH + 1),
    ]) {
      expect(hasUnsafeStorageSegment(bad), JSON.stringify(bad)).toBe(true);
    }
  });

  it('permits the real mint conventions, so it is not vacuously refusing everything', () => {
    for (const good of [
      `${ORG}/items/${ENTITY}/${FILE}`,
      `${ORG}/${ENTITY}/cover.jpg`,
      `${ORG}/po-imports/33333333-3333-4333-8333-333333333333.csv`,
      `${ORG}/logo-1754870000000.png`,
    ]) {
      expect(hasUnsafeStorageSegment(good), good).toBe(false);
    }
  });

  it('a path exactly at the length cap is permitted; one character over is not (the boundary itself, not just each side of it)', () => {
    expect(hasUnsafeStorageSegment('a'.repeat(MAX_STORAGE_PATH_LENGTH))).toBe(false);
    expect(hasUnsafeStorageSegment('a'.repeat(MAX_STORAGE_PATH_LENGTH + 1))).toBe(true);
  });

  it('refuses a non-string, so a JSON body sending a number or an object cannot reach a shape match', () => {
    expect(hasUnsafeStorageSegment(null as unknown as string)).toBe(true);
    expect(hasUnsafeStorageSegment(undefined as unknown as string)).toBe(true);
    expect(hasUnsafeStorageSegment(42 as unknown as string)).toBe(true);
  });
});

describe('isValidStoragePath runs BOTH layers', () => {
  it('refuses a traversal even against a deliberately BROKEN, unanchored shape — layer (b) catches what a bad regex would let through', () => {
    // This is the failure mode layer (b) exists for, made concrete: an
    // unanchored shape that matches anywhere in the string. `shape.test()`
    // alone accepts the traversal; isValidStoragePath must not.
    const broken = /items/;
    expect(broken.test(`${ORG}/../../items/victim/x.jpg`)).toBe(true);
    expect(isValidStoragePath(`${ORG}/../../items/victim/x.jpg`, broken)).toBe(false);
  });

  it('a valid path still passes both layers (the pairing is not vacuous)', () => {
    expect(isValidStoragePath(`${ORG}/items/${ENTITY}/${FILE}`, itemImagePathShape(ORG, ENTITY))).toBe(
      true,
    );
  });
});

describe('regex-metacharacter injection through the id arguments', () => {
  it('an org id carrying regex metacharacters cannot widen the shape into a wildcard', () => {
    // The ids are interpolated into a RegExp source. Unescaped, an org id of
    // `.*` would turn the shape into a match-anything wildcard — so the
    // escaping is a security control, not cosmetic.
    const shape = itemImagePathShape('.*', ENTITY);
    expect(isValidStoragePath(`${ORG}/items/${ENTITY}/${FILE}`, shape)).toBe(false);
    // It matches only the LITERAL two characters.
    expect(isValidStoragePath(`.*/items/${ENTITY}/${FILE}`, shape)).toBe(true);
  });

  it('an entity id carrying metacharacters is likewise literal', () => {
    const shape = orderAttachmentPathShape(ORG, '(.*)');
    expect(isValidStoragePath(`${ORG}/${ENTITY}/${FILE}`, shape)).toBe(false);
    expect(isValidStoragePath(`${ORG}/(.*)/${FILE}`, shape)).toBe(true);
  });
});

describe('filename segment rules', () => {
  it('refuses a bare dot-run as a filename — `.`, `..` and `...` are unrepresentable', () => {
    for (const name of ['.', '..', '...', '.hidden']) {
      expect(isValidStoragePath(`${ORG}/items/${ENTITY}/${name}`, itemImagePathShape(ORG, ENTITY))).toBe(
        false,
      );
    }
  });

  it('refuses a filename with no extension, and one whose extension is empty', () => {
    expect(isValidStoragePath(`${ORG}/items/${ENTITY}/photo`, itemImagePathShape(ORG, ENTITY))).toBe(
      false,
    );
    expect(isValidStoragePath(`${ORG}/items/${ENTITY}/photo.`, itemImagePathShape(ORG, ENTITY))).toBe(
      false,
    );
  });

  it('refuses a space in the filename — the org-logo uploader sanitizes its extension precisely so this never has to be relaxed', () => {
    expect(isValidStoragePath(`${ORG}/logo-1754870000000.my png`, orgLogoPathShape(ORG))).toBe(false);
    expect(isValidStoragePath(`${ORG}/logo 1754870000000.png`, orgLogoPathShape(ORG))).toBe(false);
  });

  it('maintenanceAttachmentPathShape stays STRICTER than the others: a non-UUID filename and a non-image extension are refused', () => {
    // That surface mints every path server-side and has no legacy variants, so
    // it can afford to pin the filename to a real UUID plus one of four image
    // extensions. Relaxing it to match the other shapes would be a
    // regression, so it is pinned here.
    expect(
      isValidStoragePath(`${ORG}/${ENTITY}/k3j4h5g6f7d8.jpg`, maintenanceAttachmentPathShape(ORG, ENTITY)),
    ).toBe(false);
    expect(
      isValidStoragePath(
        `${ORG}/${ENTITY}/33333333-3333-4333-8333-333333333333.svg`,
        maintenanceAttachmentPathShape(ORG, ENTITY),
      ),
    ).toBe(false);
    expect(
      isValidStoragePath(
        `${ORG}/${ENTITY}/33333333-3333-4333-8333-333333333333.html`,
        maintenanceAttachmentPathShape(ORG, ENTITY),
      ),
    ).toBe(false);
  });

  it('poImportPathShape requires the literal `po-imports/` folder, so a caller cannot park an import row on some other folder in the bucket', () => {
    expect(
      isValidStoragePath(`${ORG}/po-imports/33333333-3333-4333-8333-333333333333.pdf`, poImportPathShape(ORG)),
    ).toBe(true);
    expect(
      isValidStoragePath(`${ORG}/po-import/33333333-3333-4333-8333-333333333333.pdf`, poImportPathShape(ORG)),
    ).toBe(false);
    expect(
      isValidStoragePath(`${ORG}/${ENTITY}/33333333-3333-4333-8333-333333333333.pdf`, poImportPathShape(ORG)),
    ).toBe(false);
    // And it is not nestable — no extra folder between the org and the file.
    expect(
      isValidStoragePath(
        `${ORG}/po-imports/nested/33333333-3333-4333-8333-333333333333.pdf`,
        poImportPathShape(ORG),
      ),
    ).toBe(false);
  });

  it('orgLogoPathShape is exactly TWO segments — a logo has no parent entity below the org', () => {
    expect(isValidStoragePath(`${ORG}/logo-1.png`, orgLogoPathShape(ORG))).toBe(true);
    expect(isValidStoragePath(`${ORG}/${ENTITY}/logo-1.png`, orgLogoPathShape(ORG))).toBe(false);
    expect(isValidStoragePath('logo-1.png', orgLogoPathShape(ORG))).toBe(false);
  });
});
