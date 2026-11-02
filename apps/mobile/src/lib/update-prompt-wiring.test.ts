import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  LAUNCH_SCREEN_GROUND,
  UPDATE_PROMPT_LATER,
  UPDATE_PROMPT_RESTART,
} from './ota-update-prompt';

/**
 * The phone update pop-up's wiring across the app (B44), read with the
 * TypeScript parser: what holds the pop-up, the one restart, and the writes
 * and drains Restart now waits for. The rules themselves run in
 * ota-update-prompt.test.ts and use-ota-updates.test.ts; this file keeps the
 * screens connected to them.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

function listSources(...dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
    }
  };
  dirs.forEach((d) => walk(path.join(MOBILE_ROOT, d)));
  return out.sort();
}

const SOURCES = listSources('app', 'src');

function rel(file: string): string {
  return path.relative(MOBILE_ROOT, file).split(path.sep).join('/');
}

function read(file: string): string {
  return readFileSync(path.isAbsolute(file) ? file : path.join(MOBILE_ROOT, file), 'utf8');
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** The called name: `f(...)` and `x.f(...)` are both 'f'. */
function calleeName(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return '';
}

function callsNamed(sf: ts.SourceFile, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  walk(sf, (n) => {
    if (ts.isCallExpression(n) && calleeName(n) === name) out.push(n);
  });
  return out;
}

/**
 * The name of the function a node sits in: a function or a method, or a
 * property or const that holds an arrow or a function expression.
 */
function enclosingName(node: ts.Node): string {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) {
      return p.name.getText();
    }
    if (
      (ts.isPropertyDeclaration(p) || ts.isVariableDeclaration(p)) &&
      p.initializer &&
      (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))
    ) {
      return p.name.getText();
    }
  }
  return '(module)';
}

/** Source text with whitespace and trailing commas dropped, for exact pins that survive a reflow. */
function squeeze(text: string): string {
  return text.replace(/\s+/g, '').replace(/,\)/g, ')');
}

/** Line comments and line-leading block comments dropped, whitespace flattened. */
function flatCode(file: string): string {
  return read(file)
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');
}

function isInsideCallTo(node: ts.Node, name: string): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (
      ts.isCallExpression(p) &&
      calleeName(p) === name &&
      p.arguments.some((a) => a.pos <= node.pos && node.end <= a.end)
    ) {
      return true;
    }
  }
  return false;
}

describe('sheets hold the pop-up', () => {
  it('every Modal is the shared one, which holds the pop-up while it is visible', () => {
    const fromReactNative: string[] = [];
    const usesModal: string[] = [];
    const importsShared: string[] = [];
    for (const file of SOURCES) {
      const sf = parse(file);
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st)) continue;
        const from = (st.moduleSpecifier as ts.StringLiteral).text;
        const bindings = st.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            const imported = (el.propertyName ?? el.name).text;
            if (imported === 'Modal' && from === 'react-native') fromReactNative.push(rel(file));
            if (imported === 'Modal' && from === '@/components/ui/modal')
              importsShared.push(rel(file));
          }
        }
        if (bindings && ts.isNamespaceImport(bindings) && from === 'react-native') {
          expect(sf.text, rel(file)).not.toContain(`${bindings.name.text}.Modal`);
        }
      }
      walk(sf, (n) => {
        if (
          (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
          n.tagName.getText(sf) === 'Modal'
        ) {
          usesModal.push(rel(file));
        }
      });
    }
    expect(fromReactNative).toEqual(['src/components/ui/modal.tsx']);
    const users = [...new Set(usesModal)].sort();
    expect(users.length).toBeGreaterThanOrEqual(35);
    expect(users).toEqual([...new Set(importsShared)].sort());

    const modal = flatCode('src/components/ui/modal.tsx');
    expect(modal).toContain("import { Modal as NativeModal } from 'react-native';");
    expect(modal).toContain(
      "export function Modal(props: React.ComponentProps<typeof NativeModal>) { useHoldUpdatePrompt(props.visible ?? true, 'sheet'); return <NativeModal {...props} />; }",
    );
  });

  it('a tour’s Modal waits for the pop-up too', () => {
    const tour = flatCode('src/components/onboarding/mobile-tour.tsx');
    expect(tour).toContain('const updatePromptOpen = useTourVisible(UPDATE_PROMPT_LOCK_ID);');
    expect(tour).toContain(
      "visible={isFocused && phase !== 'idle' && !whatsNewOpen && !updatePromptOpen}",
    );
  });

  // What's New opens from a timer and tells the lock only in its effects, so
  // the pop-up can show in between. The lock is symmetric, as the tour's is:
  // the sheet steps aside while the pop-up is open or the app restarts, and
  // keeps `open`, so it comes back after Later or a failed restart.
  it('What’s New steps aside for the pop-up too, and comes back after it', () => {
    const whatsNew = flatCode('src/components/onboarding/whats-new.tsx');
    expect(whatsNew).toContain('const updatePromptOpen = useTourVisible(UPDATE_PROMPT_LOCK_ID);');
    expect(whatsNew).toContain('visible={open && !updatePromptOpen}');
    expect(whatsNew).not.toContain('visible={open}');
  });
});

// The rule tests hand the controller the screen by hand (setScreen with
// written values); this keeps the one component that hands it the real
// screen honest: the route key the work routes are written in, What's New,
// the slot, the launch animation, the keyboard and who is signed in, and the
// cover Restart now shows.
describe('the host hands the controller the real screen, and covers a restart', () => {
  const HOST = 'src/components/update-prompt-host.tsx';
  const host = flatCode(HOST);
  /** squeeze, with trailing commas before } and ] dropped too. */
  const tight = (text: string) => squeeze(text).replace(/,([}\]])/g, '$1');

  it('reads each input from where it lives', () => {
    // WORK_ROUTES are written as the segments joined with '/'.
    expect(host).toContain("const routeKey = segments.join('/');");
    expect(host).toContain('const slotTaken = useAnyTourVisibleExcept(UPDATE_PROMPT_LOCK_ID);');
    expect(host).toContain('const whatsNewOpen = useWhatsNewOpen();');
    expect(host).toContain('const { splashActive } = useColdLaunchGate();');
    expect(host).toContain('const keyboardVisible = useKeyboardVisible();');
    expect(host).toContain('const userId = user?.id ?? null;');
    expect(host).toContain(
      "const shown = Keyboard.addListener('keyboardDidShow', () => setVisible(true));",
    );
    expect(host).toContain(
      "const hidden = Keyboard.addListener('keyboardDidHide', () => setVisible(false));",
    );
  });

  it('sends every screen input whenever one changes, and says so when it unmounts', () => {
    expect(tight(host)).toContain(
      tight(
        'React.useEffect(() => { updatePrompt.setScreen({ mounted: true, userId, routeKey, splashActive, keyboardVisible, whatsNewOpen, slotTaken, }); }, [userId, routeKey, splashActive, keyboardVisible, whatsNewOpen, slotTaken]);',
      ),
    );
    expect(tight(host)).toContain(
      tight('React.useEffect(() => () => updatePrompt.setScreen({ mounted: false }), []);'),
    );

    // Every field of ScreenInputs is sent, each from the local of its name,
    // and each but `mounted` is a dependency of the effect that sends it.
    const rules = parse('src/lib/ota-update-prompt.ts');
    const screenInputs = rules.statements.find(
      (st): st is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(st) && st.name.text === 'ScreenInputs',
    );
    const fields = screenInputs!.members.map((m) => m.name!.getText(rules)).sort();
    expect(fields).toEqual([
      'keyboardVisible',
      'mounted',
      'routeKey',
      'slotTaken',
      'splashActive',
      'userId',
      'whatsNewOpen',
    ]);
    const sf = parse(HOST);
    const sends = callsNamed(sf, 'setScreen');
    expect(sends).toHaveLength(2);
    const [send] = sends.filter((call) =>
      squeeze(call.arguments[0]!.getText(sf)).includes('mounted:true'),
    );
    const object = send!.arguments[0] as ts.ObjectLiteralExpression;
    expect(object.properties.map((p) => p.name!.getText(sf)).sort()).toEqual(fields);
    for (const p of object.properties) {
      if (p.name!.getText(sf) === 'mounted') continue;
      expect(ts.isShorthandPropertyAssignment(p), p.getText(sf)).toBe(true);
    }
    let effect: ts.Node | undefined = send!.parent;
    while (effect && !(ts.isCallExpression(effect) && calleeName(effect) === 'useEffect')) {
      effect = effect.parent;
    }
    const deps = (effect as ts.CallExpression).arguments[1] as ts.ArrayLiteralExpression;
    expect(deps.elements.map((e) => e.getText(sf)).sort()).toEqual(
      fields.filter((f) => f !== 'mounted'),
    );
  });

  it('draws the cover only while restarting, over everything, taking every touch, with the words VoiceOver reads', () => {
    expect(host).toContain(
      'const phase = React.useSyncExternalStore(updatePrompt.subscribe, updatePrompt.getPhase);',
    );
    expect(host).toContain("if (phase !== 'restarting') return null;");
    expect(host).toContain('style={[StyleSheet.absoluteFill, styles.overlay]}');
    expect(host).toContain('onStartShouldSetResponder={() => true}');
    expect(host).toContain('accessible accessibilityViewIsModal');
    expect(host).toContain('accessibilityLabel={RESTARTING_LABEL}');
    expect(tight(host)).toContain(
      tight('overlay: { backgroundColor: LAUNCH_SCREEN_GROUND, zIndex: 1000, elevation: 1000, },'),
    );
  });
});

describe('the one restart', () => {
  it('reloadAsync is called only by Restart now and by the crash screen’s own button', () => {
    const calls: string[] = [];
    for (const file of SOURCES) {
      const sf = parse(file);
      for (const call of callsNamed(sf, 'reloadAsync'))
        calls.push(`${rel(file)} ${enclosingName(call)}`);
    }
    expect(calls.sort()).toEqual([
      'src/components/error-boundary.tsx handleReload',
      'src/lib/use-ota-updates.ts restartIntoUpdate',
    ]);
  });

  it('restartIntoUpdate is private, shows the launch screen, and is used only as the restart', () => {
    const sf = parse('src/lib/use-ota-updates.ts');
    const fn = sf.statements.find(
      (st): st is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(st) && st.name?.text === 'restartIntoUpdate',
    );
    expect(fn).toBeDefined();
    expect(ts.getModifiers(fn!)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false).toBe(
      false,
    );
    expect(squeeze(fn!.body!.getText(sf))).toBe(
      squeeze('{ await Updates.reloadAsync({ reloadScreenOptions: RESTART_SCREEN }); }'),
    );
    const uses: string[] = [];
    walk(sf, (n) => {
      if (ts.isIdentifier(n) && n.text === 'restartIntoUpdate' && n.parent !== fn) {
        uses.push(n.parent.getText(sf));
      }
    });
    expect(uses).toEqual(['restart: restartIntoUpdate']);
    for (const file of SOURCES) {
      if (rel(file) !== 'src/lib/use-ota-updates.ts') {
        expect(read(file), rel(file)).not.toContain('restartIntoUpdate');
      }
    }
  });

  it('no screen reads expo-updates’ useUpdates (the controller reads the native state once)', () => {
    for (const file of SOURCES) {
      expect(callsNamed(parse(file), 'useUpdates'), rel(file)).toEqual([]);
    }
  });

  it('expo-updates keeps its defaults: only the url is set, so it checks at every open from closed and never waits for the download', () => {
    const sf = parse('app.config.ts');
    let keys: string[] | null = null;
    walk(sf, (n) => {
      if (
        ts.isPropertyAssignment(n) &&
        n.name.getText(sf) === 'updates' &&
        ts.isObjectLiteralExpression(n.initializer)
      ) {
        keys = n.initializer.properties.map((p) => p.name?.getText(sf) ?? '');
      }
    });
    expect(keys).toEqual(['url']);
  });

  it('the restart and its cover use the launch screen’s colour', () => {
    const sf = parse('app.config.ts');
    let splashGround: string | null = null;
    walk(sf, (n) => {
      if (
        ts.isArrayLiteralExpression(n) &&
        n.elements[0] &&
        ts.isStringLiteral(n.elements[0]) &&
        n.elements[0].text === 'expo-splash-screen' &&
        n.elements[1] &&
        ts.isObjectLiteralExpression(n.elements[1])
      ) {
        for (const p of n.elements[1].properties) {
          if (
            ts.isPropertyAssignment(p) &&
            p.name.getText(sf) === 'backgroundColor' &&
            ts.isStringLiteral(p.initializer)
          ) {
            splashGround = p.initializer.text;
          }
        }
      }
    });
    expect(splashGround).toBe(LAUNCH_SCREEN_GROUND);

    const screen = flatCode('src/lib/restart-screen.ts');
    expect(screen).toContain(
      `export const RESTART_SCREEN = { backgroundColor: '${LAUNCH_SCREEN_GROUND}', image: LAUNCH_ICON, imageResizeMode: 'contain', imageFullScreen: false, spinner: { enabled: false }, fade: true, } as const satisfies ReloadScreenOptions;`,
    );
    expect(screen).toContain(
      "export const LAUNCH_ICON: number = require('../../assets/icon.png');",
    );
  });
});

describe('alerts hold the pop-up', () => {
  it('installAlertHolds() runs once, from the root layout', () => {
    const calls: string[] = [];
    for (const file of SOURCES) {
      for (const call of callsNamed(parse(file), 'installAlertHolds')) {
        calls.push(`${rel(file)} ${enclosingName(call)}`);
      }
    }
    expect(calls).toEqual(['app/_layout.tsx (module)']);
  });
});

describe('work in progress holds the pop-up', () => {
  const HOLDS: Record<string, string[]> = {
    'src/components/digital-pick.tsx': ["useHoldUpdatePrompt((lines ?? []).some(isDirty), 'pick')"],
    'app/po/[id].tsx': [
      "useHoldUpdatePrompt(Object.values(draft).some((l) => l.received.trim() !== '' || l.rejected.trim() !== '') || notes.trim() !== '', 'receive')",
    ],
    'app/item/[id].tsx': [
      "useHoldUpdatePrompt(photoBusy, 'photo')",
      "useHoldUpdatePrompt(isDirty, 'item-note')",
    ],
    'app/maintenance/[id].tsx': [
      "useHoldUpdatePrompt(noteBody.trim() !== '' || resolveNote.trim() !== '' || resolvePhotos.length > 0, 'maintenance-draft')",
    ],
    'app/order/[id].tsx': ["useHoldUpdatePrompt(uploading, 'photo')"],
    'src/components/po-attachments.tsx': ["useHoldUpdatePrompt(busy, 'attachment')"],
    'src/components/ui/modal.tsx': ["useHoldUpdatePrompt(props.visible ?? true, 'sheet')"],
  };

  it('each draft, upload and sheet holds with its own expression, and nothing else calls the hook', () => {
    const found: Record<string, string[]> = {};
    for (const file of SOURCES) {
      if (rel(file) === 'src/lib/update-prompt-holds.ts') continue;
      const sf = parse(file);
      const calls = callsNamed(sf, 'useHoldUpdatePrompt').map((c) => squeeze(c.getText(sf)));
      if (calls.length > 0) found[rel(file)] = calls;
    }
    const expected = Object.fromEntries(
      Object.entries(HOLDS).map(([file, calls]) => [file, calls.map(squeeze)]),
    );
    expect(found).toEqual(expected);
  });

  // A picker, its resize, upload and save are one flow the pop-up cannot see.
  const PICKER = /^(?:ImagePicker\.launch\w+|DocumentPicker\.getDocumentAsync|scanDocumentPages)$/;

  it.each([
    ['app/item/[id].tsx', ['pickFromCamera', 'pickFromLibrary']],
    ['app/maintenance/[id].tsx', ['pickFromCamera', 'pickFromLibrary']],
    ['app/order/[id].tsx', ['fromCamera', 'fromLibrary']],
    [
      'src/components/po-attachments.tsx',
      ['pickDocument', 'pickFromLibrary', 'scanDocument', 'takePhoto'],
    ],
  ])('%s starts every picker inside whileUpdatePromptHeld', (file, names) => {
    const sf = parse(file);
    const handlers = new Set<string>();
    walk(sf, (n) => {
      if (ts.isCallExpression(n) && PICKER.test(n.expression.getText(sf))) {
        handlers.add(enclosingName(n));
      }
    });
    expect([...handlers].sort()).toEqual(names);
    let references = 0;
    walk(sf, (n) => {
      if (!ts.isIdentifier(n) || !handlers.has(n.text)) return;
      const declares =
        (ts.isFunctionDeclaration(n.parent) || ts.isVariableDeclaration(n.parent)) &&
        n.parent.name === n;
      if (declares) return;
      references += 1;
      expect(isInsideCallTo(n, 'whileUpdatePromptHeld'), `${file}: ${n.parent.getText(sf)}`).toBe(
        true,
      );
    });
    expect(references).toBeGreaterThanOrEqual(names.length);
  });

  it('the share sheet is held, wherever it opens', () => {
    let shares = 0;
    for (const file of SOURCES) {
      const sf = parse(file);
      walk(sf, (n) => {
        if (ts.isCallExpression(n) && n.expression.getText(sf) === 'Share.share') {
          shares += 1;
          expect(isInsideCallTo(n, 'whileUpdatePromptHeld'), rel(file)).toBe(true);
        }
      });
    }
    expect(shares).toBeGreaterThanOrEqual(1);
  });
});

describe('writes in flight are counted, and the drains stop for a restart', () => {
  it('api() counts every call but a GET', () => {
    expect(flatCode('src/lib/api.ts')).toContain(
      "const call = send<T>(path, opts); return (opts.method ?? 'GET') === 'GET' ? call : trackWrite(call);",
    );
  });

  it('the supabase client counts its writes', () => {
    expect(flatCode('src/lib/supabase.ts')).toContain('global: { fetch: writeTrackingFetch },');
  });

  it('the upload transports count their uploads', () => {
    expect(flatCode('src/lib/storage-upload.ts')).toContain(
      'result = await trackWrite(task.uploadAsync());',
    );
    const signed = flatCode('src/lib/signed-photo-upload.ts');
    expect(signed).toContain('const upload = trackWrite(task.uploadAsync());');
    expect(signed).toContain('await trackWrite( FileSystem.uploadAsync(');
    expect(flatCode('src/lib/multipart-upload.ts')).toContain('return trackWrite( doFetch(url, {');
  });

  it('the sync drain stops before its next row, and no sync starts, while a restart waits', () => {
    const sync = flatCode('src/lib/sync.ts');
    expect(sync).toContain('if (restartPaused) break; await markSending(');
    expect(sync).toContain(
      'export async function syncNow(force = false): Promise<void> { if (restartPaused) return;',
    );
  });

  it('the count drain stops before its next row, and no drain starts, while a restart waits', () => {
    const counts = flatCode('src/lib/cycle-count-sync.ts');
    expect(counts).toContain('if (this.restartPaused) break; try { await outboxMarkSending(');
    expect(counts).toContain('if (this.inFlight || this.restartPaused) return;');
    // outbox-scope.test.ts pins the loop itself.
    expect(counts).toContain('for (const row of send)');
  });
});

/**
 * The runbook's simulator proof (docs/runbooks/mobile-ota.md, "Prove
 * phone-update behaviour on a simulator") expects what iOS's own alert does
 * with these two buttons. Later is the alert's cancel action, so Escape on a
 * hardware keyboard chooses it. Restart now is its preferred action, the bold
 * one, yet the simulator proof of 2026-10-31 found that on iOS 27 Return does
 * not choose it. So the iPad check restarts with a tap and says Return does
 * nothing there, instead of making a restart by Return a pass condition that
 * every later proof would fail. When either button changes, the first test
 * fails: rewrite the iPad check with it.
 */
describe('the runbook’s simulator proof expects what iOS’s alert does', () => {
  const RUNBOOK = path.resolve(MOBILE_ROOT, '../../docs/runbooks/mobile-ota.md');
  const HEADING = '## Prove phone-update behaviour on a simulator (test channel)';

  /** The proof section's lines, from its heading to the next heading of its level. */
  function proofLines(): string[] {
    const lines = readFileSync(RUNBOOK, 'utf8').split('\n');
    const start = lines.indexOf(HEADING);
    expect(start, HEADING).toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
    return lines.slice(start, end === -1 ? undefined : end);
  }

  const flat = (lines: string[]) => lines.join(' ').replace(/\s+/g, ' ').trim();

  it('Later is the alert’s cancel action and Restart now its preferred one', () => {
    expect(squeeze(flatCode('src/lib/use-ota-updates.ts'))).toContain(
      squeeze(
        "Alert.alert(UPDATE_PROMPT_TITLE, UPDATE_PROMPT_MESSAGE, [ { text: UPDATE_PROMPT_LATER, style: 'cancel', onPress: onLater }, { text: UPDATE_PROMPT_RESTART, isPreferred: true, onPress: onRestartNow }, ]);",
      ),
    );
  });

  // Mutation caught: the iPad check counting on Return to restart again, or
  // dropping the tap, Escape, or the warning that Return does nothing.
  it('so the iPad check restarts with a tap, Escape chooses Later, and Return is never a pass condition', () => {
    const lines = proofLines();
    const first = lines.findIndex((l) => /^\s*- On an iPad\b/.test(l));
    expect(first, 'the iPad check').toBeGreaterThan(-1);
    const bullet = [lines[first]!];
    for (const l of lines.slice(first + 1)) {
      if (!l.trim() || /^\s*(?:- |\d+\. )/.test(l)) break;
      bullet.push(l);
    }
    const ipad = flat(bullet);
    expect(ipad).toContain('the message is centred, in both orientations');
    expect(ipad).toContain(`tapping ${UPDATE_PROMPT_RESTART} restarts once`);
    expect(ipad).toMatch(new RegExp(`Escape chooses ${UPDATE_PROMPT_LATER}\\b`));
    expect(ipad).toContain(`Return does not choose ${UPDATE_PROMPT_RESTART}`);

    // Every clause of the proof that names the Return key says it does not
    // restart, so no step expects it to.
    const returns = flat(lines)
      .split(/[.;:] /)
      .filter((clause) => /\bReturn\b/.test(clause));
    expect(returns.length).toBeGreaterThan(0);
    for (const clause of returns) {
      expect(clause).toContain(`Return does not choose ${UPDATE_PROMPT_RESTART}`);
    }
  });
});
