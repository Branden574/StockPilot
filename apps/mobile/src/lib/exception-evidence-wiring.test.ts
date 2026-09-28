import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { attrText, parseTsx, readSource, tagOf, TOUCHABLE_TAG, walkJsx, type JsxNode } from './__fixtures__/jsx-touch-audit';

/**
 * Photo evidence screens (F1-4): WIRING PINS for the Photos section, its two
 * sheets and the exception detail screen.
 *
 * The screens cannot render under this node test environment (vitest excludes
 * app/, which imports native modules at load), so the load-bearing wiring is
 * pinned at source level; the decisions themselves are pure and tested in
 * exception-evidence.test.ts, exception-evidence-upload.test.ts and
 * signed-photo-upload.test.ts. Each pin encodes an owner rule:
 *   1. online only: offline the add control, Retry and Remove are DISABLED
 *      with the reason, fed the live network state, and nothing is queued;
 *   2. no phantom photo: a photo is added only when the server recorded it,
 *      and a "record" retry records the same upload rather than a copy;
 *   3. a failed photo read is "could not be loaded" with Try again, never
 *      "no photos";
 *   4. the camera falls back to the library when it is not allowed;
 *   5. 44pt tap targets and spoken names on every control.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

/** Source with comments stripped, so a header explaining what a screen avoids
 *  cannot trip the negative pins. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const detail = codeOnly(read('../../app/exceptions/[id].tsx'));
const section = codeOnly(read('../components/exception-evidence-section.tsx'));
const sheets = codeOnly(read('../components/exception-evidence-sheets.tsx'));
const card = codeOnly(read('../components/item-verification-card.tsx'));
const viewer = codeOnly(read('../components/photo-viewer.tsx'));
const cachedImage = codeOnly(read('../components/ui/cached-image.tsx'));

describe('exception detail screen', () => {
  it('renders the Photos section from the detail read, fed the live network state and the server\'s hints', () => {
    const jsx = detail.slice(
      detail.indexOf('<ExceptionEvidenceSection'),
      detail.indexOf('/>', detail.indexOf('<ExceptionEvidenceSection')),
    );
    for (const prop of [
      'occurrenceId={o.id}',
      'block={detail.evidence}',
      'readTick={readTick}',
      'resolved={resolved}',
      'canAct={o.canAct}',
      'online={!offline}',
      'timeZone={detail.timeZone}',
      'onChanged={onPhotosChanged}',
    ]) {
      expect(jsx).toContain(prop);
    }
    expect(detail).toContain('onPhotosChanged={() => void load()}');
  });

  // Mutation caught: taking the tick after the read lands, which retires an
  // "Added" row on a read that started before the photo was recorded.
  it('stamps each read with the tick taken BEFORE it is sent', () => {
    expect(detail).toMatch(/const readTick = evidenceTick\(\);\s+try \{\s+const detail = await getException\(id\);/);
    expect(detail).toContain(
      "setState({ kind: 'ready', detail, receivedAt: receivedAt.toISOString(), banner: null, readTick });",
    );
  });

  it('words photo events through core, with the org time zone', () => {
    expect(detail).toContain("e.kind === 'evidence_added' || e.kind === 'evidence_removed' ? (");
    expect(detail).toMatch(/evidenceTimelineLines\(\{\s+kind: e\.kind,\s+actorLabel: e\.actor\?\.label \?\? null,\s+note: e\.note,\s+evidence: e\.evidence,\s+timeZone: detail\.timeZone,\s+\}\)/);
  });

  it('with no workspace it says so and Try again loads the workspace again (not a spinner forever)', () => {
    expect(detail).toContain('{!orgId && !workspaceLoading ? (');
    expect(detail).toContain('{EXCEPTION_WORKSPACE_UNAVAILABLE}');
    expect(detail).toContain('await retryWorkspace();');
    expect(detail).toContain('onPress={() => void reloadWorkspace()}');
  });
});

describe('Photos section', () => {
  it('reads nothing itself: the rows come from the detail read, the writes through the Bearer routes', () => {
    expect(section).not.toContain('supabase');
    expect(section).not.toContain('.rpc(');
    expect(sheets).not.toContain('supabase');
  });

  // Owner decision F1 Q6: online only. Mutation caught: any offline queue.
  it('queues nothing offline: no outbox, no local storage', () => {
    for (const code of [section, sheets]) {
      expect(code).not.toMatch(/outbox|enqueue|AsyncStorage|SecureStore|expo-sqlite|\bdb\b/);
    }
  });

  // Mutation caught: `online: true`, or dropping `online` from the call.
  it('the add control follows the shared rule with the live network state, disabled with the reason', () => {
    expect(section).toContain('evidenceAddControl({ block, resolved, canAct, online, visible })');
    expect(section).toContain('disabled={add.reason !== null}');
    expect(section).toContain('{add.reason}');
    expect(section).toContain('{add.offered ? (');
    expect(section).not.toMatch(/online:\s*true/);
  });

  it('a failed photo read says so, with Try again, and offers no add', () => {
    expect(section).toContain('{parts.unavailable ? (');
    expect(section).toContain('{EXCEPTION_EVIDENCE_UNAVAILABLE_COPY}');
    expect(section).toMatch(/onPress=\{onChanged\}[\s\S]{0,120}Try again/);
    // "No photos yet." only after a successful read with nothing listed or
    // on its way (evidenceSectionParts).
    expect(section).toContain('{parts.showNone ? (');
    expect(section).toMatch(/\{parts\.unavailable \? null : \(\s+<>\s+\{add\.offered \? \(/);
  });

  // Review finding 2026-09-27. Mutation caught: the rows rendered only in
  // the successful-read branch, so an unavailable re-read hid an upload in
  // flight and a failed row with its Retry and Discard.
  it('the rows being added render whatever the read says: from evidenceSectionParts, at the top level of the section', () => {
    expect(section).toContain('const parts = evidenceSectionParts(block, visible);');
    const jsx = section.slice(section.indexOf('  return (\n    <View style={{ gap: 10 }}>'));
    expect(jsx.length).toBeGreaterThan(0);
    // A direct child of the section's root View, not inside any branch.
    expect(jsx).toMatch(/\n {6}\{parts\.queue\.map\(\(entry\) => \(/);
    expect(jsx).toMatch(/\n {6}\{parts\.photos\.map\(\(p, i\) => \{/);
    // Every branch goes through the parts, none through the block itself.
    expect(jsx).not.toMatch(/block\.status/);
  });

  // Review finding 2026-09-27. Mutation caught: a photo whose 1-hour link
  // expired (or whose file cannot be read) opening blank.
  it('a photo that fails to load says so, with Try again that re-reads, in the list and from the viewer', () => {
    expect(section).toContain('onError={() => markFailed(p.thumbUrl ?? p.url)}');
    expect(section).toContain('const failed = evidencePhotoFailed(p, failedUrls);');
    expect(section).toContain('{EXCEPTION_EVIDENCE_PHOTO_FAILED_COPY}');
    expect(section).toMatch(
      /\{EXCEPTION_EVIDENCE_PHOTO_FAILED_COPY\}[\s\S]{0,400}onPress=\{onChanged\}[\s\S]{0,200}Try again/,
    );
    expect(section).toMatch(
      /<PhotoViewer[\s\S]{0,300}onError=\{\(\) => \{\s+markFailed\(viewing\.url\);\s+setViewing\(null\);/,
    );
    expect(viewer).toMatch(/<CachedImage\s+uri=\{uri\}[^>]*onError=\{onError\}/);
    expect(cachedImage).toContain('onError={onError}');
  });

  it('shows the rows through visibleEvidenceQueue with the read tick, and counts them for the cap', () => {
    expect(section).toContain('const visible = visibleEvidenceQueue(queue, block, readTick);');
    expect(section).toContain('evidenceCapCheck({ liveCount, visible, incoming: photos.length })');
    expect(section).toContain('room={evidenceRoomLeft(liveCount, visible)}');
  });

  // Mutation caught: `resume: entry.resume` for every retry (an "upload"
  // retry would then finalize a path the server already removed).
  it('only a "record" retry resumes the earlier upload', () => {
    expect(section).toContain("resume: entry.retry === 'record' ? entry.resume : null,");
  });

  it('drops a superseded attempt\'s progress and result (one guard per row)', () => {
    expect(section).toContain('const [guard] = React.useState(createPhotoAttemptGuard);');
    expect(section).toContain('const token = guard.start(entry.key);');
    expect(section.match(/if \(!guard\.isCurrent\(entry\.key, token\)\) return;/g)).toHaveLength(2);
    expect(section).toContain('if (guard.isCurrent(entry.key, token)) patch(entry.key, { progress: fraction });');
  });

  // Mutation caught: re-reading inside the try, where a failed re-read would
  // mark a recorded photo "Not added".
  it('re-reads after a recorded photo OUTSIDE the try, and marks the row done with its id and tick first', () => {
    const run = section.slice(section.indexOf('async function runUpload('), section.indexOf('async function addPicked('));
    expect(run).toMatch(/evidenceId: res\.evidenceId,\s+doneAt: evidenceTick\(\),/);
    expect(run.trimEnd()).toMatch(/\n {4}\}\s+onChanged\(\);\s+\}$/);
    // Nothing in the try re-reads.
    const tryBlock = run.slice(run.indexOf('    try {'), run.indexOf('} catch (e) {'));
    expect(tryBlock).not.toContain('onChanged(');
  });

  it('a failed row offers Retry (disabled offline, with the reason) where it can help, and Discard always', () => {
    expect(section).toContain('const retryReason = evidenceRetryDisabledReason(online);');
    expect(section).toContain('{entry.retry ? (');
    expect(section).toContain('disabled={retryReason !== null}');
    expect(section).toContain('onPress={() => discard(entry.key)}');
    expect(section).toContain('{evidenceQueueRowCopy(entry)}');
  });

  it('Remove is offered only where the server says, and is disabled offline with the reason', () => {
    expect(section).toContain('{p.canRemove ? (');
    expect(section).toMatch(/disabled=\{!online\}\s+onPress=\{\(\) => setRemoving\(p\)\}/);
    expect(section).toContain('{EVIDENCE_REMOVE_OFFLINE_COPY}');
  });

  it('words each photo through core: who added it and its two times', () => {
    expect(section).toContain('{exceptionEvidenceAddedByCopy(p.uploadedBy.label)}');
    expect(section).toMatch(
      /exceptionEvidenceTimesCopy\(\s*\{ capturedAt: p\.capturedAt, uploadedAt: p\.uploadedAt \},\s*timeZone,?\s*\)/,
    );
    expect(section).toContain('exceptionEvidenceCountLabel(block.liveCount)');
    expect(section).toContain('{EXCEPTION_EVIDENCE_PRIVACY_COPY}');
  });

  it('opens a photo full screen with the signed link', () => {
    expect(section).toContain('uri={viewing.url}');
    expect(section).toContain('source={{ uri: p.thumbUrl ?? p.url }}');
  });
});

describe('Add and Remove sheets', () => {
  // Mutation caught: a plain alert on denial with no way on to the library.
  it('the camera falls back to the library when it is not allowed, or not there', () => {
    expect(sheets).toContain("const denial = photoPermissionDenial('camera', perm.canAskAgain);");
    expect(sheets).toMatch(/offerLibraryInstead\(denial\.title, /);
    expect(sheets).toContain("{ text: 'Choose from library', onPress: () => void pick(chooseFromLibrary) },");
    expect(sheets).toMatch(/\} catch \{[\s\S]{0,120}offerLibraryInstead\(\s+'Camera unavailable',/);
    expect(sheets).toContain("const denial = photoPermissionDenial('library', perm.canAskAgain);");
  });

  it('the library never offers more photos than there is room for', () => {
    expect(sheets).toContain('const left = Math.max(0, room - photos.length);');
    expect(sheets).toContain('selectionLimit: Math.max(1, left),');
    expect(sheets).toContain('allowsMultipleSelection: left > 1,');
    expect(sheets).toContain('setPhotos((prev) => [...prev, ...picked].slice(0, Math.max(0, room)));');
  });

  it('asks the picker for EXIF only to read the capture time', () => {
    expect(sheets.match(/exif: true/g)).toHaveLength(2);
    expect(sheets).toContain("evidenceCapturedAt({ source: 'camera', exif: a.exif, pickedAt: new Date() })");
    expect(sheets).toContain("evidenceCapturedAt({ source: 'library', exif: a.exif, pickedAt: new Date() })");
  });

  // Mutation caught: dropping `!online` (Add stays live in airplane mode).
  it('Add is disabled offline (first) or with a note over the limit, with the reason shown', () => {
    expect(sheets).toContain(
      'const reason = !online ? EXCEPTION_EVIDENCE_OFFLINE_COPY : text.tooLong ? EVIDENCE_NOTE_TOO_LONG_COPY : null;',
    );
    expect(sheets).toContain('disabled={reason !== null || photos.length === 0 || picking}');
    expect(sheets).toContain("onPress={() => onAdd(photos, note.trim() || null)}");
  });

  it('Remove is a soft remove through the Bearer route, says so first, and shows a failure inline', () => {
    expect(sheets).toContain('await removeEvidence(occurrenceId, photo.id, reason.trim() || null);');
    expect(sheets).toContain('setError(describeRemoveEvidenceError(e));');
    expect(sheets).toContain('{EXCEPTION_EVIDENCE_REMOVE_COPY}');
    expect(sheets).toMatch(/const disabledReason = !online\s+\? EVIDENCE_REMOVE_OFFLINE_COPY/);
    expect(sheets).toContain('accessibilityRole="alert"');
  });
});

type Found = { el: JsxNode; sf: ts.SourceFile; file: string };

function elementsOf(file: string, pred: (el: JsxNode, sf: ts.SourceFile) => boolean): Found[] {
  const sf = parseTsx(readSource(path.join(MOBILE_ROOT, file)), file);
  const out: Found[] = [];
  walkJsx(sf, (el) => {
    if (pred(el, sf)) out.push({ el, sf, file });
  });
  return out;
}

function where(f: Found): string {
  const { line } = f.sf.getLineAndCharacterOfPosition(f.el.getStart(f.sf));
  return `${f.file}:${line + 1} <${tagOf(f.el, f.sf)}>`;
}

/** The text an element renders: JSX text and string or template literals in
 *  its children, never its attributes. */
function textOf(node: ts.Node): string {
  let out = '';
  const visit = (n: ts.Node) => {
    if (ts.isJsxAttributes(n)) return;
    if (ts.isJsxText(n)) out += n.text;
    else if (ts.isStringLiteral(n) && !ts.isJsxAttribute(n.parent)) out += n.text;
    else if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n)) out += n.getText();
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out.replace(/\s+/g, ' ').trim();
}

const PHOTO_FILES = [
  'src/components/exception-evidence-section.tsx',
  'src/components/exception-evidence-sheets.tsx',
];

describe('tap targets and spoken names', () => {
  const minTap = Number(/const MIN_TAP = (\d+);/.exec(card)![1]);

  it('MIN_TAP is at least 44', () => {
    expect(minTap).toBeGreaterThanOrEqual(44);
  });

  it.each(PHOTO_FILES)('%s: every Button is 44pt or taller', (file) => {
    const buttons = elementsOf(file, (el, sf) => tagOf(el, sf) === 'Button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      const size = attrText(b.el, 'size', b.sf);
      if (size === undefined || size === 'md') continue;
      const style = attrText(b.el, 'style', b.sf) ?? '';
      expect(style, `${where(b)} is size ${size} with no minHeight`).toContain('minHeight: MIN_TAP');
    }
  });

  it.each(PHOTO_FILES)('%s: every touchable has a role, a name and a 44pt target (or is the full-screen scrim)', (file) => {
    const src = readSource(path.join(MOBILE_ROOT, file));
    const touchables = elementsOf(file, (el, sf) => TOUCHABLE_TAG.test(tagOf(el, sf)));
    expect(touchables.length).toBeGreaterThan(0);
    for (const t of touchables) {
      expect(['button', 'imagebutton'], `${where(t)} role`).toContain(attrText(t.el, 'accessibilityRole', t.sf));
      expect(attrText(t.el, 'accessibilityLabel', t.sf), `${where(t)} name`).toBeTruthy();
      const style = attrText(t.el, 'style', t.sf) ?? '';
      const ok =
        style.includes('StyleSheet.absoluteFill') ||
        style.includes('minHeight: MIN_TAP') ||
        (style === 'styles.close' && /close: \{\s+minWidth: MIN_TAP,\s+minHeight: MIN_TAP,/.test(src));
      expect(ok, `${where(t)} style ${style}`).toBe(true);
      expect(attrText(t.el, 'hitSlop', t.sf), `${where(t)} hitSlop`).toBeUndefined();
    }
  });

  // Simulator walk 2026-09-27 (review finding 10): expo-image sets
  // isAccessibilityElement = accessible ?? false on iOS, and a React Native
  // View is not an accessibility element unless it says so, so a name on
  // either is never read by VoiceOver: the photo previews in both sheets and
  // the rows of photos being added were silent. Mutation caught: dropping
  // `accessible` from any of them.
  it.each(PHOTO_FILES)('%s: every Image or View with a spoken name is an accessibility element', (file) => {
    const named = elementsOf(
      file,
      (el, sf) => ['Image', 'View'].includes(tagOf(el, sf)) && attrText(el, 'accessibilityLabel', sf) !== undefined,
    );
    expect(named.length).toBeGreaterThan(0);
    for (const n of named) {
      expect(attrText(n.el, 'accessible', n.sf), `${where(n)} has a name but is not accessible`).toBe('true');
    }
  });

  it('the Remove on each photo is named for its photo (several "Remove" buttons would sound alike)', () => {
    const removes = elementsOf(PHOTO_FILES[0]!, (el, sf) => tagOf(el, sf) === 'Button' && textOf(el) === 'Remove');
    expect(removes).toHaveLength(1);
    expect(attrText(removes[0]!.el, 'accessibilityLabel', removes[0]!.sf)).toBe('`Remove photo ${i + 1}`');
  });

  it('the Button primitive forwards a spoken name when one is given', () => {
    const btn = readSource(path.join(MOBILE_ROOT, 'src/components/ui/button.tsx'));
    expect(btn).toContain('accessibilityLabel={accessibilityLabel}');
    expect(btn).toContain('accessibilityHint={accessibilityHint}');
  });
});

describe('copy', () => {
  // Owner rule: no emojis anywhere.
  it.each([...PHOTO_FILES, 'src/lib/exception-evidence.ts', 'src/lib/exception-evidence-upload.ts', 'app/exceptions/[id].tsx'])(
    '%s has no emoji',
    (file) => {
      expect(readSource(path.join(MOBILE_ROOT, file))).not.toMatch(/\p{Extended_Pictographic}/u);
    },
  );
});
