import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { AA_TEXT, AA_UI, contrast } from '../components/ui/__fixtures__/contrast';
import { drawerSectionsFor } from './drawer-nav';
import {
  TOUCHABLE_TAG,
  attrText,
  listTsx,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';
import { DEFAULT_TAB_SLOTS, MAX_TAB_SLOTS, MIN_TAB_SLOTS, TAB_SLOT_IDS } from './tab-config';
import { palette, type Palette } from './theme';

// drawer-nav maps icon names to lucide components; the icons are irrelevant
// here and the native package does not load under node (the
// admin-reconciliation-removed test's stand-in).
vi.mock('./nav-icons', () => ({ NAV_ICONS: new Proxy({}, { get: () => () => null }) }));

/**
 * THE PHONE SHELL, READ AS SOURCE (redesign package P5.4: the root layout,
 * the drawer, the bottom tab bar, the workspace switcher, What's New, the
 * tours, the cold-launch splash and the error boundary).
 *
 * The shell took the reference look on the per-mode palette: a solid page
 * coloured tab bar in place of the iOS BlurView, the reference sidebar's rows
 * in the drawer, the app's sheet shape for the workspace switcher, 44pt
 * targets, the muted ink for words that were in ink4. These pin what had to
 * survive it: RootGate's order and timing, the font gate (and the way out of
 * it, CONFLICTS D24), the splash hand-off, What's New only in the signed-in
 * shell, the drawer from the registry with its section keys, the tab bar's
 * slots and inset contract, the tour targets and the sign-out path.
 *
 * The mobile suite has no React Native renderer, so the files are read with
 * the TypeScript parser (the scanner-structure.test.ts method), and the few
 * functions whose answers ARE the behaviour (the font gate, the Tour pill's
 * frame, the splash's tokens) are compiled from the repository's own source
 * and run here with stand-in hooks and a stand-in clock.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const ROOT_LAYOUT = 'app/_layout.tsx';
const DRAWER_LAYOUT = 'app/(drawer)/_layout.tsx';
const TABS_LAYOUT = 'app/(drawer)/(tabs)/_layout.tsx';
const DRAWER = 'src/components/drawer-content.tsx';
const SWITCHER = 'src/components/workspace-switcher.tsx';
const WHATS_NEW = 'src/components/onboarding/whats-new.tsx';
const TOUR = 'src/components/onboarding/mobile-tour.tsx';
const SPLASH = 'src/components/cold-launch-splash.tsx';
const BOUNDARY = 'src/components/error-boundary.tsx';
const ZENDESK_LOGO = 'src/components/zendesk-logo.tsx';

const LIGHT = palette('light');
const DARK = palette('dark');
/** The root's cold-launch ground and the splash's surface: the dark page. */
const SPLASH_GROUND_HEX = DARK.paper;
const ALL_MODULES = new Set(Object.keys(MODULE_REGISTRY) as ModuleId[]);
const MODES: [string, Palette][] = [
  ['light', LIGHT],
  ['dark', DARK],
];

function sourceOf(file: string): string {
  return readSource(path.join(MOBILE_ROOT, file));
}

function treeOf(file: string): ts.SourceFile {
  return parseTsx(sourceOf(file), file);
}

/** Source with comments stripped, so a comment can never satisfy a pin. */
function codeOnly(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** One line per run of whitespace, so a reflow never breaks a pin. */
function flat(src: string): string {
  return src.replace(/\s+/g, ' ');
}

/** The body of `function name(...)`, comments dropped, whitespace flattened. */
function functionText(file: string, name: string): string {
  const sf = treeOf(file);
  const fn = sf.statements.find(
    (st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === name,
  );
  expect(fn, `function ${name} in ${file}`).toBeDefined();
  return flat(codeOnly(fn!.getText(sf)));
}

/** A `name: {...}` entry of a file's StyleSheet.create (2-space indent). */
function styleBlock(file: string, name: string): string {
  return flat(new RegExp(`\\n {2}${name}: \\{([^}]*)\\}`).exec(sourceOf(file))?.[1] ?? '');
}

/** Every element of a file that matches. */
function elements(file: string, match: (el: JsxNode, sf: ts.SourceFile) => boolean) {
  const sf = treeOf(file);
  const els: JsxNode[] = [];
  walkJsx(sf, (el) => {
    if (match(el, sf)) els.push(el);
  });
  return { sf, els };
}

/** The words an element shows: its JSX text, children joined. */
function textOf(el: JsxNode, sf: ts.SourceFile): string {
  const parts: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) parts.push(n.getText(sf).trim());
    ts.forEachChild(n, visit);
  };
  visit(el);
  return parts.filter(Boolean).join(' ');
}

/** Everything a person can read or hear in a file: JSX text and every literal. */
function wordsOf(file: string): string[] {
  const sf = treeOf(file);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) {
      const t = n.getText(sf).replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      out.push(n.text);
    } else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Top-level functions and constants of a file, compiled from the repository's
 * own source (never from input) and run in a context holding only what the
 * caller hands in.
 */
function compileTopLevel(
  file: string,
  names: string[],
  context: Record<string, unknown>,
): Record<string, unknown> {
  const sf = treeOf(file);
  const parts: string[] = [];
  const found = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && names.includes(st.name.text)) {
      parts.push(st.getText(sf));
      found.add(st.name.text);
    } else if (ts.isVariableStatement(st)) {
      const declared = st.declarationList.declarations
        .map((d) => (ts.isIdentifier(d.name) ? d.name.text : ''))
        .filter((n) => names.includes(n));
      if (declared.length > 0) {
        parts.push(st.getText(sf));
        declared.forEach((n) => found.add(n));
      }
    }
  }
  expect([...found].sort(), `${names.join(', ')} in ${file}`).toEqual([...names].sort());
  const js = ts.transpileModule(`${parts.join('\n')}\n({ ${names.join(', ')} });`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new vm.Script(js).runInNewContext({ ...context }) as Record<string, unknown>;
}

/**
 * Just enough of React's hooks to run one custom hook outside a renderer:
 * state cells, effects that run after a render when their dependencies change
 * (the previous cleanup first), a re-render when state changes from outside a
 * render (a timer, a listener), and an unmount that runs every cleanup.
 */
class HookHost<T> {
  private states: unknown[] = [];
  private effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = [];
  private queue: (() => void)[] = [];
  private stateIndex = 0;
  private effectIndex = 0;
  private dirty = false;
  private rendering = false;
  value!: T;
  renders = 0;

  constructor(private readonly hook: () => T) {}

  readonly React = {
    useState: <S>(init: S | (() => S)): readonly [S, (next: S | ((prev: S) => S)) => void] => {
      const i = this.stateIndex++;
      if (i >= this.states.length) {
        this.states.push(typeof init === 'function' ? (init as () => S)() : init);
      }
      const set = (next: S | ((prev: S) => S)) => {
        const prev = this.states[i] as S;
        const value = typeof next === 'function' ? (next as (p: S) => S)(prev) : next;
        if (Object.is(value, prev)) return;
        this.states[i] = value;
        if (this.rendering) this.dirty = true;
        else this.render();
      };
      return [this.states[i] as S, set] as const;
    },
    useEffect: (fn: () => (() => void) | void, deps?: readonly unknown[]) => {
      const i = this.effectIndex++;
      const prev = this.effects[i];
      const changed =
        !prev ||
        !deps ||
        !prev.deps ||
        deps.length !== prev.deps.length ||
        deps.some((d, k) => !Object.is(d, prev.deps![k]));
      if (!changed) return;
      this.queue.push(() => {
        prev?.cleanup?.();
        const cleanup = fn();
        this.effects[i] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
      });
    },
  };

  render(): T {
    this.rendering = true;
    do {
      this.dirty = false;
      this.stateIndex = 0;
      this.effectIndex = 0;
      this.value = this.hook();
      this.renders += 1;
      for (const run of this.queue.splice(0)) run();
    } while (this.dirty);
    this.rendering = false;
    return this.value;
  }

  unmount(): void {
    for (const e of this.effects) e?.cleanup?.();
  }
}

/** A clock for setTimeout / clearTimeout that only moves when told to. */
function stepClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    pending: () => timers.size,
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
  };
}

// ── The root layout ───────────────────────────────────────────────────────

describe('root layout: RootGate keeps its order, its hooks and its timing', () => {
  const src = codeOnly(sourceOf(ROOT_LAYOUT));
  const gate = functionText(ROOT_LAYOUT, 'RootGate');
  const layout = functionText(ROOT_LAYOUT, 'RootLayout');

  it('the gates return in this order: disabled (no session needed), then MFA, then the biometric lock, then the app', () => {
    const disabled = gate.indexOf(
      "if (!loading && accountGate.state === 'disabled') { return <AccountDisabledScreen />;",
    );
    const mfa = gate.indexOf(
      'if (!loading && session && mfaRequired) { return <MfaChallengeScreen />;',
    );
    const lock = gate.indexOf(
      'if (!loading && session && locked) { return <BiometricLockScreen />;',
    );
    const stack = gate.indexOf('<Stack screenOptions=');
    expect(disabled).toBeGreaterThan(-1);
    expect(mfa).toBeGreaterThan(disabled);
    expect(lock).toBeGreaterThan(mfa);
    expect(stack).toBeGreaterThan(lock);
  });

  it("What's New renders only in the signed-in shell, beside the Stack", () => {
    expect(gate).toContain(
      '{session && !loading && !mfaRequired && !locked ? <WhatsNew /> : null}',
    );
    expect(gate.indexOf('<WhatsNew />')).toBeGreaterThan(gate.indexOf('</Stack>'));
    expect((src.match(/<WhatsNew \/>/g) ?? []).length).toBe(1);
  });

  it('every shell hook is still mounted in RootGate, before the gates', () => {
    for (const hook of [
      'usePushNotifications(session?.user ?? null);',
      'useSync(session?.user ?? null);',
      'useHeldOrderSubmissions(session?.user?.id ?? null, seeOrders);',
      "useActivityBeacon(session?.user?.id ?? null, segments.join('/'));",
      'useAccountGate({ onEvicted: onForcedSignOut });',
      'useSessionRevocation(session?.user?.id ?? null, onForcedSignOut, revocationOptions);',
    ]) {
      expect(gate, hook).toContain(hook);
      expect(gate.indexOf(hook), hook).toBeLessThan(
        gate.indexOf("accountGate.state === 'disabled') {"),
      );
    }
  });

  it('the signed-out redirect and the way back from the auth group are unchanged', () => {
    expect(gate).toContain("if (loading || accountGate.state === 'disabled') return;");
    expect(gate).toContain("const inAuthGroup = segments[0] === '(auth)';");
    expect(gate).toContain(
      'if (!session && !inAuthGroup) { router.replace(signedOutRoute() as Href); }',
    );
    expect(gate).toContain(
      "else if (session && inAuthGroup) { clearSessionEnded(); router.replace('/'); }",
    );
  });

  it('RootLayout keeps its order: OTA reload, the database and count sync, the font gate, then the providers and the splash', () => {
    const ota = layout.indexOf('useOtaAutoReload();');
    const db = layout.indexOf('await initDb();');
    const prune = layout.indexOf('await pruneRejected();');
    const sync = layout.indexOf('cycleCountSync.start();');
    const fonts = layout.indexOf('const fontsReady = useFontGate();');
    const blank = layout.indexOf('if (!fontsReady) {');
    const providers = layout.indexOf('<AuthProvider>');
    expect(ota).toBeGreaterThan(-1);
    expect(db).toBeGreaterThan(ota);
    expect(prune).toBeGreaterThan(db);
    expect(sync).toBeGreaterThan(prune);
    expect(fonts).toBeGreaterThan(sync);
    expect(blank).toBeGreaterThan(fonts);
    expect(providers).toBeGreaterThan(blank);
    expect(layout).toContain('cycleCountSync.stop();');
  });

  it('the splash is fire-once per cold launch and hands off to the lock (the Face ID prompt waits for it)', () => {
    expect(src).toMatch(/let coldLaunchHandled = false;/);
    expect(layout).toContain(
      'if (coldLaunchHandled) return false; coldLaunchHandled = true; return true;',
    );
    expect(layout).toContain('<ColdLaunchGateProvider splashActive={splashActive}>');
    expect(layout).toContain(
      '{splashVisible ? ( <ColdLaunchSplash onHandoff={() => setSplashActive(false)} onDone={() => setSplashVisible(false)} /> ) : null}',
    );
    // The splash is stacked over RootGate, never instead of it.
    expect(layout.indexOf('<ColdLaunchSplash')).toBeGreaterThan(layout.indexOf('<RootGate />'));
    expect(layout).toContain(
      "<StatusBar style={splashVisible || mode === 'dark' ? 'light' : 'dark'} />",
    );
  });

  it('the grounds are tokens: the splash ground is the dark page, the rest the page of the mode', () => {
    expect(src).toContain("const SPLASH_GROUND = palette('dark').paper;");
    expect(layout).toContain(
      'return <View style={{ flex: 1, backgroundColor: isCold ? SPLASH_GROUND : c.paper }} />;',
    );
    expect(layout).toContain('backgroundColor: splashVisible ? SPLASH_GROUND : c.paper');
    expect(SPLASH_GROUND_HEX).toBe('#0c0d0a');
    // The light-only palette (a light frame on a dark-mode reload) is gone.
    expect(src).not.toContain("palette('light')");
    expect(src).not.toMatch(/'#[0-9a-f]{6}'/i);
  });

  // Every registered screen and its presentation, exactly as before (the
  // count scanner needs the full-screen modal, the order-placed screen the
  // back swipe off).
  it.each([
    ['(auth)', null],
    ['(drawer)', null],
    ['item/[id]', "{ presentation: 'card' }"],
    ['order/[id]', "{ presentation: 'card' }"],
    ['order/new/index', "{ presentation: 'card' }"],
    ['order/new/browse', "{ presentation: 'card' }"],
    ['order/new/checkout', "{ presentation: 'card' }"],
    ['order/new/placed', "{ presentation: 'card', gestureEnabled: false }"],
    // Manage order items (ordering visibility, 0413; design 8.6).
    ['order/manage-items', "{ presentation: 'card' }"],
    ['scan-po/index', "{ presentation: 'card' }"],
    ['cycle-count/scan/[id]', "{ presentation: 'fullScreenModal' }"],
    ['bundles/index', "{ presentation: 'card' }"],
    ['bundles/[id]', "{ presentation: 'card' }"],
    ['rentals/new', "{ presentation: 'card' }"],
    ['rentals/[id]', "{ presentation: 'card' }"],
    ['maintenance/new', "{ presentation: 'card' }"],
    ['maintenance/[id]', "{ presentation: 'card' }"],
    ['exceptions/[id]', "{ presentation: 'card' }"],
    ['returns/[id]', "{ presentation: 'card' }"],
    ['location/[id]', "{ presentation: 'card' }"],
    ['reports/book-order-totals/index', "{ presentation: 'card' }"],
    ['reports/book-order-totals/[itemId]', "{ presentation: 'card' }"],
    ['schedule/new', "{ presentation: 'card' }"],
    ['ai/chat', "{ presentation: 'card' }"],
    ['zendesk/web', "{ presentation: 'card' }"],
  ])('registers %s', (name, options) => {
    const { sf, els } = elements(
      ROOT_LAYOUT,
      (el, s) => tagOf(el, s) === 'Stack.Screen' && attrText(el, 'name', s) === name,
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'options', sf) ?? null).toBe(options);
  });

  it('registers no other screen', () => {
    const { els } = elements(ROOT_LAYOUT, (el, s) => tagOf(el, s) === 'Stack.Screen');
    expect(els).toHaveLength(25);
  });
});

describe('the font gate has a way out (CONFLICTS D24)', () => {
  function gate(initialFontsReady: boolean) {
    const clock = stepClock();
    const fonts = { ready: initialFontsReady };
    let compiled: { useFontGate: () => boolean; FONT_GATE_TIMEOUT_MS: number };
    const host: HookHost<boolean> = new HookHost(() => compiled.useFontGate());
    compiled = compileTopLevel(ROOT_LAYOUT, ['FONT_GATE_TIMEOUT_MS', 'useFontGate'], {
      React: host.React,
      useBrandFonts: () => fonts.ready,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    }) as typeof compiled;
    return { clock, fonts, host, timeout: compiled.FONT_GATE_TIMEOUT_MS };
  }

  it('waits 4 seconds for the brand fonts, no longer', () => {
    expect(gate(false).timeout).toBe(4000);
  });

  // The defect: useBrandFonts() reports only a successful load, so a font
  // that failed or never answered kept the app on a blank screen for good.
  it('fonts that never load (or fail): closed until the timeout, then open in the system fonts', () => {
    const { clock, host } = gate(false);
    expect(host.render()).toBe(false);
    expect(clock.pending()).toBe(1);
    clock.advance(3999);
    expect(host.value).toBe(false);
    clock.advance(1);
    expect(host.value).toBe(true);
    expect(clock.pending()).toBe(0);
  });

  it('fonts that arrive first: open at once, and the timer is cleared', () => {
    const { clock, fonts, host } = gate(false);
    expect(host.render()).toBe(false);
    clock.advance(300);
    fonts.ready = true;
    expect(host.render()).toBe(true);
    expect(clock.pending()).toBe(0);
    const renders = host.renders;
    clock.advance(10_000);
    expect(host.renders).toBe(renders);
    expect(host.value).toBe(true);
  });

  it('fonts already loaded (a warm remount): open on the first frame, no timer at all', () => {
    const { clock, host } = gate(true);
    expect(host.render()).toBe(true);
    expect(clock.pending()).toBe(0);
  });

  it('a layout that goes away while it waits leaves no timer behind', () => {
    const { clock, host } = gate(false);
    host.render();
    expect(clock.pending()).toBe(1);
    host.unmount();
    expect(clock.pending()).toBe(0);
  });
});

// ── The drawer ────────────────────────────────────────────────────────────

describe('drawer layout: every screen registered, the panel on the palette', () => {
  const src = sourceOf(DRAWER_LAYOUT);
  const screen = (name: string) =>
    elements(
      DRAWER_LAYOUT,
      (el, s) => tagOf(el, s) === 'Drawer.Screen' && attrText(el, 'name', s) === name,
    );

  it.each([
    ['(tabs)', 'Home'],
    ['staging', 'Staging'],
    ['exceptions', 'Exceptions'],
    ['bundles', 'Bundles'],
    ['orders', 'Orders'],
    ['returns', 'Returns'],
    ['rentals', 'Rentals'],
    ['categories', 'Categories'],
    ['tags', 'Tags'],
    ['movements', 'Movements'],
    ['procedures', 'Procedures'],
    ['purchase-orders', 'Purchase orders'],
    ['po-imports', 'PO imports'],
    ['recurring-pos', 'Recurring POs'],
    ['customers', 'Accounts'],
    ['locations', 'Locations'],
    ['suppliers', 'Suppliers'],
    ['reports', 'Reports'],
    ['ai', 'AI Assistant'],
    ['schedule', 'Schedule'],
    ['notifications', 'Notifications'],
    ['team', 'Team'],
    ['maintenance', 'Maintenance'],
    ['support', 'Support & feedback'],
    ['settings', 'Settings'],
  ])('registers %s (%s)', (name, label) => {
    const { sf, els } = screen(name);
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'options', sf)).toBe(`{ drawerLabel: '${label}' }`);
  });

  // Hidden, so an unregistered route is never auto-added to the drawer.
  it.each([
    ['settings/integrations', 'Integrations'],
    ['settings/customize-tabs', 'Customize tab bar'],
    ['settings/rejected-work', 'Unsent work'],
    ['settings/change-email', 'Change email'],
    ['admin/index', 'Admin overview'],
    ['admin/charters', 'Charters'],
    ['admin/warehouses', 'Warehouses'],
    ['admin/bins', 'Bins'],
    ['admin/users', 'Users'],
    ['admin/vendor-mappings', 'Vendor mappings'],
    ['admin/uom-conversions', 'UoM conversions'],
    ['admin/audit', 'Audit log'],
  ])('registers %s hidden (%s)', (name, label) => {
    const { sf, els } = screen(name);
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'options', sf)).toBe(
      `{ drawerLabel: '${label}', drawerItemStyle: { display: 'none' } }`,
    );
  });

  it('registers no other screen', () => {
    expect(elements(DRAWER_LAYOUT, (el, s) => tagOf(el, s) === 'Drawer.Screen').els).toHaveLength(
      37,
    );
  });

  it('a front drawer, 320pt wide, swiped open from a 32pt edge, over the same scrims', () => {
    const code = flat(codeOnly(src));
    expect(code).toContain('drawerContent={(props) => <DrawerContent {...props} />}');
    expect(code).toContain("drawerType: 'front',");
    expect(code).toContain('swipeEdgeWidth: 32,');
    expect(code).toContain('width: 320,');
    expect(code).toContain("mode === 'dark' ? 'rgba(0, 0, 0, 0.65)' : 'rgba(14, 15, 13, 0.4)'");
  });

  it('the panel is the page colour with a hairline on its open edge', () => {
    const code = flat(codeOnly(src));
    expect(code).toContain(
      'drawerStyle: { backgroundColor: c.paper, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: c.hair, width: 320, }',
    );
    expect(code).toContain('sceneStyle: { backgroundColor: c.paper }');
  });

  // The navigator's own switch (react-native-drawer-layout 4.2.10) hides the
  // status bar as a swipe starts and shows it again only when the drawer's
  // state changes, so a swipe that never opened the drawer left the bar
  // hidden on every screen (and on an iPhone with a Home button or an iPad
  // each open dropped the screen by the bar's 20-24pt). The drawer content
  // hides it instead, from the drawer's state, only where it misreads.
  it('leaves the status bar to the drawer content: the navigator never hides it', () => {
    const code = flat(codeOnly(src));
    expect(code).not.toContain('drawerHideStatusBarOnOpen');
    expect(code).not.toContain('drawerStatusBarAnimation');
    expect(code).not.toContain('StatusBar');
  });
});

describe('drawer content: the registry, as the reference sidebar', () => {
  const src = sourceOf(DRAWER);
  const code = flat(codeOnly(src));

  it("reads the registry's mobile_drawer surface with the live role, modules and permissions", () => {
    expect(code).toContain(
      "drawerSectionsFor(role ?? 'staff', enabledModules, permissions), [role, enabledModules, permissions],",
    );
    expect(code).toContain(
      'usePermissionsRealtime({ organizationId: activeOrgId, userId: user?.id ?? null, role: role ?? null });',
    );
    // Every label and section header is the registry's: none is typed here.
    expect(code).toContain('{section.label}');
    expect(code).toContain('{item.label}');
    for (const typed of [
      'INVENTORY',
      'FULFILLMENT',
      'PURCHASING',
      'INSIGHTS',
      'WORKSPACE',
      'TOOLS',
      'ADMIN',
      'Purchase orders',
      'Items',
    ]) {
      expect(wordsOf(DRAWER)).not.toContain(typed);
    }
  });

  // Section keys are data (CONFLICTS N2): the drawer keeps the registry's
  // sections and their order, the overview section without a header.
  // OWNER DECISION 2026-10-19: FULFILLMENT, PURCHASING and INSIGHTS split out
  // of INVENTORY and WORKSPACE, as on the web sidebar (this list was
  // INVENTORY, WORKSPACE, TOOLS, ADMIN before).
  it('an owner with every module sees the same sections, in the same order', () => {
    const sections = drawerSectionsFor('owner', ALL_MODULES);
    expect(sections.map((s) => s.label)).toEqual([
      undefined,
      'INVENTORY',
      'FULFILLMENT',
      'PURCHASING',
      'INSIGHTS',
      'WORKSPACE',
      'TOOLS',
      'ADMIN',
    ]);
    expect(sections[0]!.items.map((i) => i.href)).toEqual(['/']);
    expect(
      sections
        .flatMap((s) => s.items)
        .filter((i) => i.inTabs)
        .map((i) => i.href)
        .sort(),
    ).toEqual(['/', '/books', '/inventory', '/receive', '/scan']);
  });

  it('a row is a 44pt button announced as selected when it is the page on screen', () => {
    const { sf, els } = elements(
      DRAWER,
      (el, s) =>
        tagOf(el, s) === 'Pressable' && attrText(el, 'onPress', s) === '() => navigate(item)',
    );
    expect(els).toHaveLength(1);
    const row = els[0]!;
    expect(attrText(row, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(row, 'accessibilityState', sf)).toBe('{ selected: isActive }');
    expect(attrText(row, 'hitSlop', sf)).toBeUndefined();
    expect(styleBlock(DRAWER, 'row')).toContain('minHeight: 44,');
    expect(styleBlock(DRAWER, 'row')).not.toMatch(/\bheight:/);
  });

  it('draws the reference rows: the selected fill, full ink and weight on the page on screen; ink2 words and ink3 icons otherwise', () => {
    expect(code).toContain("backgroundColor: isActive ? c.paper2 : 'transparent',");
    expect(code).toContain(
      '<Icon size={18} color={isActive ? c.ink : c.ink3} strokeWidth={1.6} />',
    );
    expect(code).toContain('color={isActive ? c.ink : c.ink2}');
    expect(code).toContain('fontFamily: isActive ? FONT.display : FONT.displayRegular,');
    // The active match is unchanged: the exact path, Home for / or /index,
    // else a prefix.
    expect(code).toContain(
      "item.href === activeHref || (item.href === '/' && (activeHref === '/' || activeHref.startsWith('/index'))) || (item.href !== '/' && activeHref.startsWith(item.href));",
    );
  });

  it('the section headers are headers; the TAB marker and the email read in the muted ink, the marker capped as chrome', () => {
    expect(code).toContain('<Eyebrow accessibilityRole="header">{section.label}</Eyebrow>');
    expect(code).toMatch(/<Mono size=\{10\.5\} color=\{c\.ink3\}[^>]*> \{profile\.email \?\? ''\}/);
    expect(code).toMatch(
      /<Mono size=\{9\} tracking=\{0\.16\} upper color=\{c\.ink3\} numberOfLines=\{1\} maxFontSizeMultiplier=\{capTo\(9, TYPE_CEILING\.chrome\)\} style=\{\{ flexShrink: 0 \}\} > TAB <\/Mono>/,
    );
  });

  it('Sign out still drains through signOut(), as a 44pt button in the refusal colour, clear of the home indicator', () => {
    const { sf, els } = elements(
      DRAWER,
      (el, s) => tagOf(el, s) === 'Pressable' && textOf(el, s) === 'Sign out',
    );
    expect(els).toHaveLength(1);
    const button = els[0]!;
    expect(attrText(button, 'onPress', sf)).toBe('() => void signOut()');
    expect(attrText(button, 'accessibilityRole', sf)).toBe('button');
    expect(code).toContain('<LogOut size={16} color={c.critText} strokeWidth={1.5} />');
    expect(code).toContain(
      'color={c.critText} style={{ fontFamily: FONT.display, flexShrink: 1 }}> Sign out </Body>',
    );
    const signout = styleBlock(DRAWER, 'signout');
    expect(signout).toContain('minHeight: 44,');
    expect(signout).toContain('borderRadius: BUTTON_RADIUS.sm,');
    expect(code).toContain('borderColor: c.hair2,');
    expect(code).toContain('paddingBottom: Math.max(insets.bottom, 16)');
    expect(code).not.toContain('ACCENT');
  });

  it('keeps the brand, the workspace chip and its sheet, the profile and the force-logout note', () => {
    expect(code).toContain('<BrandLockup size={26} />');
    expect(code).toContain('<WorkspaceHeaderChip onPress={() => setSwitcherOpen(true)} />');
    expect(code).toContain(
      '<WorkspaceSwitcherSheet visible={switcherOpen} onDismiss={() => setSwitcherOpen(false)} />',
    );
    expect(code).toContain("{profile.fullName ?? profile.email ?? 'Account'}");
    expect(code).toContain("{profile.email ?? ''}");
    expect(src).toContain('Force-logout lives in RootGate now');
  });

  // The P3.8 hand-off: in light mode, with the drawer open over the Scan tab,
  // the battery past the 320pt panel sat on the camera bar (dark in both
  // modes, dimmed by the scrim) in the root's dark glyphs, about 1.08:1.
  it('hides the status bar only while it is open over the Scan tab in light mode, where hiding moves nothing', () => {
    const { hidesStatusBar } = compileTopLevel(DRAWER, ['hidesStatusBar'], {}) as {
      hidesStatusBar: (
        open: boolean,
        onTop: boolean,
        mode: 'light' | 'dark',
        activeHref: string,
        sensorHousing: boolean,
      ) => boolean;
    };
    for (const open of [true, false]) {
      for (const onTop of [true, false]) {
        for (const mode of ['light', 'dark'] as const) {
          for (const href of ['/scan', '/', '/inventory', '/books', '/receive', '/orders']) {
            for (const housing of [true, false]) {
              expect(
                hidesStatusBar(open, onTop, mode, href, housing),
                `${open} ${onTop} ${mode} ${href} ${housing}`,
              ).toBe(open && onTop && mode === 'light' && href === '/scan' && housing);
            }
          }
        }
      }
    }
    // The Scan tab (app/(drawer)/(tabs)/scan.tsx) is the page /scan on screen,
    // by the same path the active row uses.
    expect(existsSync(path.join(MOBILE_ROOT, 'app/(drawer)/(tabs)/scan.tsx'))).toBe(true);
    expect(code).toContain(
      "const path = '/' + segments.filter((s) => !s.startsWith('(')).join('/'); return path === '/' || path === '/index' ? '/' : path;",
    );
    // From the drawer's state, never from a gesture: mounted while it applies
    // (a fade out), unmounted as the drawer closes, when the bar shows again.
    // A screen pushed over the open drawer (a notification, a link) takes the
    // drawer group's focus, so the bar shows again there too.
    expect(code).toContain("const drawerOpen = useDrawerStatus() === 'open';");
    expect(code).toContain('const onTop = useIsFocused();');
    expect(code).toContain(
      '{hidesStatusBar(drawerOpen, onTop, mode, activeHref, SENSOR_HOUSING) ? ( <StatusBar hidden animated hideTransitionAnimation="fade" style="dark" /> ) : null}',
    );
    expect((code.match(/<StatusBar\b/g) ?? []).length).toBe(1);
  });

  it('where hiding moves nothing: an iPhone whose top inset at launch is deeper than a status bar alone makes', () => {
    const housing = (os: string, metrics: unknown) =>
      compileTopLevel(DRAWER, ['SENSOR_HOUSING'], {
        Platform: { OS: os },
        initialWindowMetrics: metrics,
      }).SENSOR_HOUSING;
    expect(housing('ios', { insets: { top: 62 } })).toBe(true); // iPhone 17 Pro
    expect(housing('ios', { insets: { top: 59 } })).toBe(true); // Dynamic Island
    expect(housing('ios', { insets: { top: 47 } })).toBe(true); // notch
    expect(housing('ios', { insets: { top: 24 } })).toBe(false); // iPad
    expect(housing('ios', { insets: { top: 20 } })).toBe(false); // Home button
    expect(housing('ios', { insets: { top: 0 } })).toBe(false); // launched in landscape
    expect(housing('ios', null)).toBe(false);
    expect(housing('android', { insets: { top: 48 } })).toBe(false);
  });
});

describe('workspace switcher: the chip and the sheet', () => {
  const src = sourceOf(SWITCHER);
  const code = flat(codeOnly(src));

  it('the chip is a button named "Switch workspace" whose value is the workspace on screen', () => {
    const { sf, els } = elements(
      SWITCHER,
      (el, s) =>
        tagOf(el, s) === 'Pressable' &&
        attrText(el, 'accessibilityLabel', s) === 'Switch workspace',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(els[0]!, 'accessibilityValue', sf)).toBe(
      '{ text: `${orgLabel}, ${warehouseLabel}` }',
    );
    expect(code).toContain("const orgLabel = activeOrgName ?? 'Workspace';");
    expect(code).toContain("const warehouseLabel = activeWarehouseName ?? 'All warehouses';");
    expect(code).toContain('if (loading || orgs.length === 0) return null;');
    expect(code).toContain(
      '{ borderColor: c.hair2, backgroundColor: c.card, opacity: pressed ? 0.85 : 1 },',
    );
  });

  it('every word is the same', () => {
    const words = wordsOf(SWITCHER);
    for (const w of [
      'WORKSPACE',
      'Workspace',
      'All warehouses',
      'SWITCH',
      'Pick a',
      'workspace.',
      'ORGANIZATIONS',
      'WAREHOUSES',
      'No warehouses in this org yet.',
      'Done',
      'Switch workspace',
    ]) {
      expect(words, w).toContain(w);
    }
    expect(src).toMatch(
      /WORKSPACE_SWITCH_OFFLINE_COPY =\s*"Switching organization needs a connection\./,
    );
  });

  it("the sheet is the app's sheet shape: a Close scrim behind the card, VoiceOver kept inside, the escape scrub closes", () => {
    const sf = treeOf(SWITCHER);
    let container: JsxNode | undefined;
    walkJsx(sf, (el) => {
      if (attrText(el, 'accessibilityViewIsModal', sf) === 'true') container = el;
    });
    expect(container).toBeDefined();
    expect(attrText(container!, 'onAccessibilityEscape', sf)).toBe('onDismiss');
    expect(attrText(container!, 'style', sf)).toBe('styles.container');
    expect(styleBlock(SWITCHER, 'container')).toBe(" flex: 1, justifyContent: 'flex-end', ");
    const kids = (ts.isJsxElement(container!) ? container!.children : []).filter(
      (ch): ch is ts.JsxElement | ts.JsxSelfClosingElement =>
        ts.isJsxElement(ch) || ts.isJsxSelfClosingElement(ch),
    );
    expect(kids).toHaveLength(2);
    const [scrim, card] = kids as [JsxNode, JsxNode];
    expect(tagOf(scrim, sf)).toBe('Pressable');
    expect(ts.isJsxSelfClosingElement(scrim)).toBe(true);
    expect(attrText(scrim, 'onPress', sf)).toBe('onDismiss');
    expect(attrText(scrim, 'onAccessibilityTap', sf)).toBe('onDismiss');
    expect(attrText(scrim, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(scrim, 'accessibilityLabel', sf)).toBe('Close');
    expect(flat(attrText(scrim, 'style', sf) ?? '')).toContain(
      "mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)'",
    );
    expect(tagOf(card, sf)).toBe('View');
    expect(attrText(card, 'style', sf)).toBe(
      '[styles.sheet, { backgroundColor: c.card, borderColor: c.hair }]',
    );
    expect(code).toContain('<View style={[styles.grabber, { backgroundColor: c.ink5 }]} />');
    expect(src).not.toContain('#ccc');
  });

  it('each option is a 44pt button that says whether it is chosen; the chosen one is recessed with an ink edge and a tick', () => {
    const { sf, els } = elements(
      SWITCHER,
      (el, s) =>
        tagOf(el, s) === 'Pressable' &&
        /setActive(Org|Warehouse)\(/.test(attrText(el, 'onPress', s) ?? ''),
    );
    expect(els.map((el) => attrText(el, 'accessibilityState', sf))).toEqual([
      '{ selected, disabled: offline }',
      '{ selected: activeWarehouseId === null }',
      '{ selected }',
    ]);
    for (const el of els) expect(attrText(el, 'accessibilityRole', sf)).toBe('button');
    expect(styleBlock(SWITCHER, 'row')).toContain('minHeight: 44,');
    expect(code).toContain(
      "const optionStyle = (selected: boolean) => ({ borderColor: selected ? c.ink : c.hair2, backgroundColor: selected ? c.sunk : 'transparent', });",
    );
    expect(
      (code.match(/<Check size=\{15\} color=\{c\.ink\} strokeWidth=\{2\} \/>/g) ?? []).length,
    ).toBe(3);
  });

  it('the role and the empty list read in the muted ink, and Done is the shared borderless button', () => {
    expect(code).toContain(
      '<Mono size={10.5} tracking={0.06} color={c.ink3} style={{ marginTop: 2 }}> {o.role.toUpperCase()}',
    );
    expect(code).toContain('<Body size={12.5} muted> No warehouses in this org yet. </Body>');
    expect(code).toContain('<Button variant="ghost" block onPress={onDismiss}> Done </Button>');
    expect(code).not.toContain('c.ink4');
  });
});

// ── The tab bar ───────────────────────────────────────────────────────────

describe('tab bar: Home plus 2 to 5 of 16 slots, on a solid bar with the same insets', () => {
  const src = sourceOf(TABS_LAYOUT);
  const code = flat(codeOnly(src));

  it('the slots are the same: Home pinned, 2 to 5 of 16 candidates, Items, Books, POs and Scan by default', () => {
    expect(TAB_SLOT_IDS).toHaveLength(16);
    expect([MIN_TAB_SLOTS, MAX_TAB_SLOTS]).toEqual([2, 5]);
    expect(DEFAULT_TAB_SLOTS).toEqual(['inventory', 'books', 'receive', 'scan']);
    // Every candidate has its route file in the tabs group.
    const routes = listTsx(path.join(MOBILE_ROOT, 'app/(drawer)/(tabs)')).map((f) =>
      path.basename(f),
    );
    for (const id of TAB_SLOT_IDS) expect(routes, id).toContain(`${id}.tsx`);
  });

  it('the bar is built the same way: Home first, the chosen slots in order, every other candidate mounted with href: null', () => {
    expect(code).toContain(
      '<Tabs.Screen name="index" options={{ title: \'Home\', tabBarIcon: ({ color, focused }) => ( <TabIcon icon={HOME_TAB_ICON} color={color} focused={focused} /> ), }} />',
    );
    expect(code).toContain(
      '{visibleSlots.map((id) => ( <Tabs.Screen key={id} name={id} options={slotOptions(id)} /> ))}',
    );
    expect(code).toContain(
      '{hiddenSlots.map((id) => ( <Tabs.Screen key={id} name={id} options={{ href: null }} /> ))}',
    );
    expect(code.indexOf('name="index"')).toBeLessThan(code.indexOf('visibleSlots.map('));
    expect(code.indexOf('visibleSlots.map(')).toBeLessThan(code.indexOf('hiddenSlots.map('));
    expect(code).toContain("allowedTabIds({ enabledModules, role: role ?? 'staff', permissions })");
    expect(code).toContain('resolveTabConfig(storedSlots, allowed)');
    expect(code).toContain('TAB_SLOT_IDS.filter((id) => !visibleSlots.includes(id))');
  });

  it('the active-tab guard still waits for the role and the permissions before it sends anyone Home', () => {
    expect(code).toContain('const gatesLoaded = !roleLoading && permissions !== undefined;');
    expect(code).toContain(
      "if (activeTabShouldRedirect(leaf, chosen, allowed, gatesLoaded)) { router.replace('/'); }",
    );
  });

  // CONFLICTS N11 and DESIGN-SPEC 6.20: no glass. Mutation caught: the
  // BlurView back, or the bar translucent again.
  it('the bar is solid, in the page colour, with the hairline in the line colour (no BlurView)', () => {
    expect(code).not.toContain('BlurView');
    expect(code).not.toContain('expo-blur');
    expect(code).not.toContain('tabBarBackground');
    expect(code).toContain(
      'tabBarStyle: [styles.bar, { backgroundColor: c.paper, borderTopColor: c.hair }],',
    );
    expect(styleBlock(TABS_LAYOUT, 'bar')).not.toContain('transparent');
  });

  // The inset contract: every list pads by useBottomTabBarHeight() + 24,
  // DataListScreen by BottomTabBarHeightContext, the select bar sits at
  // tabBarHeight + 12. All of them measure THIS box.
  it('keeps the inset contract: absolute, 84 / 72pt tall, 24 / 14pt bottom padding, a hairline on top', () => {
    const bar = styleBlock(TABS_LAYOUT, 'bar');
    expect(bar).toContain('borderTopWidth: StyleSheet.hairlineWidth,');
    expect(bar).toContain("height: Platform.OS === 'ios' ? 84 : 72,");
    expect(bar).toContain("paddingBottom: Platform.OS === 'ios' ? 24 : 14,");
    expect(bar).toContain("position: 'absolute',");
    expect(bar).toContain('elevation: 0,');
    expect(code).toContain('tabBarItemStyle: { paddingTop: 6, },');
  });

  it('the active tab in the accent, the rest in the muted ink, the active one heavier too (colour is not the only cue)', () => {
    expect(code).toContain('tabBarActiveTintColor: c.accent,');
    expect(code).toContain('tabBarInactiveTintColor: c.ink3,');
    expect(code).toContain('fontFamily: focused ? FONT.displaySemi : FONT.display');
    expect(code).toContain('strokeWidth={focused ? 1.7 : 1.4}');
  });

  it('labels stay one line and never scale, at the display-face density tiers on both platforms', () => {
    expect(code).toContain('<Text numberOfLines={1} ellipsizeMode="tail" allowFontScaling={false}');
    expect(code).toContain(
      'const labelMetrics = tabLabelStyleForCount(1 + visibleSlots.length, LABEL_FACE_TIERS);',
    );
    expect(code).toContain("const LABEL_FACE_TIERS: TabLabelPlatform = 'android';");
    expect(code).not.toContain('FONT.mono');
  });
});

// ── What's New and the tours ──────────────────────────────────────────────

describe("What's New: the same sheet, the same rules, the reference buttons", () => {
  const src = sourceOf(WHATS_NEW);
  const code = flat(codeOnly(src));

  it('shows once per launch per user, after a beat, never over a tour, and stamps the whole registry on every close', () => {
    expect(code).toContain('if (!uid || shownForUserId === uid) return;');
    expect(code).toContain('}, 1200);');
    expect(code).toContain('if (isAnyTourVisible()) unsub = subscribeTourVisibility(tryOpen);');
    expect(code).toContain('setWhatsNewOpen(open);');
    expect(code).toContain(
      'void recordAnnouncementsSeen( items.map((i) => i.id), outcome, true, );',
    );
  });

  it('offers a CTA only when it opens a native screen, and following it counts as seen', () => {
    expect(code).toContain("const showCta = !!cta && rewriteWebPath(cta.href) !== '/';");
    expect(code).toContain("const native = rewriteWebPath(href); close('seen');");
    expect(code).toContain("if (native !== '/') router.push(native as Href);");
  });

  it('every word is the same', () => {
    expect(code).toContain('What&apos;s new · {item.date}');
    expect(wordsOf(WHATS_NEW)).toEqual(
      expect.arrayContaining(["Dismiss what's new", 'Done', 'Next']),
    );
    expect(code).toContain("{isLast ? 'Done' : 'Next'}");
    expect(code).toContain('{cta.label}');
    expect(code).toContain('{item.title}');
    expect(code).toContain('{item.body}');
  });

  it('Next / Done is the shared ink button and the CTA the outline one, each a 44pt target', () => {
    expect(code).toContain("const primary = buttonTone('primary', c);");
    expect(code).toContain("const outline = buttonTone('outline', c);");
    expect(code).toContain('{ backgroundColor: primary.bg, borderColor: primary.border },');
    expect(code).toContain('{ backgroundColor: outline.bg, borderColor: outline.border },');
    const action = styleBlock(WHATS_NEW, 'action');
    expect(action).toContain('minHeight: 44,');
    expect(action).toContain('borderRadius: BUTTON_RADIUS.sm,');
    expect(code).toContain('const ACTION_CAP = capTo(ACTION_SIZE, TYPE_CEILING.control);');
  });

  it("the app's sheet scrim per mode, the X in the muted ink, the resting dots in ink4, the escape scrub closes", () => {
    expect(code).toContain(
      "{ backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)' },",
    );
    expect(code).toContain('<X size={15} color={c.ink3} />');
    expect(code).toContain('backgroundColor: i === index ? c.ink : c.ink4,');
    expect(code).toContain("onAccessibilityEscape={() => close('dismissed')}");
  });
});

describe('tours: the same targets, the same start rules, the reference buttons', () => {
  const src = sourceOf(TOUR);
  const code = flat(codeOnly(src));

  it('starts from ?tour=<id>, only on the focused screen, never while What’s New is up', () => {
    expect(code).toContain('if (params.tour === tour.id && !autoStarted.current) {');
    expect(code).toContain("visible={isFocused && phase !== 'idle' && !whatsNewOpen}");
    expect(code).toContain("setTourVisible(tour.id, isFocused && phase !== 'idle');");
    expect(code).toContain('setActiveTour(tour.id);');
  });

  it('spotlights each step’s registered target, measured at step time', () => {
    expect(code).toContain('const targetId = tour.steps[step]?.targetId;');
    expect(code).toContain('void measureTarget(targetId).then((r) => {');
    expect(code).toContain('const cardOnTop = hole ? hole.y + hole.h / 2 > winH * 0.5 : false;');
  });

  // The tour refs live on the screens (Home, Items, Orders). Each step's
  // target must still be registered, on a view that keeps its native node
  // (collapsable={false}), or the spotlight silently degrades to a plain card.
  it('every tour target is still registered on a real view, and every tour is still mounted', () => {
    const onboarding = sourceOf('src/lib/onboarding.ts');
    const targets = [...onboarding.matchAll(/targetId: '([^']+)'/g)].map((m) => m[1]!);
    expect(targets.sort()).toEqual([
      'home-scan',
      'inventory-add',
      'inventory-first-row',
      'inventory-search',
      'orders-first-row',
      'orders-place-order',
    ]);
    const files = listTsx(path.join(MOBILE_ROOT, 'app'), path.join(MOBILE_ROOT, 'src'));
    for (const id of targets) {
      const hosts = files.filter((f) => {
        const s = readSource(f);
        const ref = new RegExp(`const (\\w+) = useTourTarget\\('${id}'\\);`).exec(s)?.[1];
        if (!ref) return false;
        // An element that takes the ref and keeps its native node, in any
        // attribute order.
        const sf = parseTsx(s, f);
        let held = false;
        walkJsx(sf, (el) => {
          if (attrText(el, 'ref', sf) === ref && attrText(el, 'collapsable', sf) === 'false') {
            held = true;
          }
        });
        return held;
      });
      expect(hosts.length, id).toBeGreaterThan(0);
    }
    for (const tour of ['MOBILE_HOME_TOUR', 'MOBILE_INVENTORY_TOUR', 'MOBILE_ORDERS_TOUR']) {
      expect(
        files.some((f) => readSource(f).includes(`<MobileTour tour={${tour}} />`)),
        tour,
      ).toBe(true);
    }
  });

  it('every word is the same', () => {
    const words = wordsOf(TOUR);
    for (const w of [
      'Tour',
      'New here? Take a quick tour.',
      'No thanks',
      'Start tour',
      'Back',
      'Exit tour',
      'Done',
      'Next',
    ]) {
      expect(words, w).toContain(w);
    }
    expect(code).toContain('accessibilityLabel={`Start the ${tour.name} tour`}');
    expect(code).toContain(
      '{tour.steps.length} short steps — learn this screen in under a minute.',
    );
  });

  it('a backdrop tap closes without stamping; the X, Android back and the escape scrub dismiss', () => {
    const { sf, els } = elements(
      TOUR,
      (el, s) =>
        tagOf(el, s) === 'Pressable' && attrText(el, 'style', s) === 'StyleSheet.absoluteFill',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'onPress', sf)).toBe('softExit');
    expect(attrText(els[0]!, 'accessibilityLabel', sf)).toBe('Exit tour');
    expect(code).toContain("onRequestClose={() => finish('dismissed')}");
    expect(code).toContain("onAccessibilityEscape={() => finish('dismissed')}");
  });

  it('Start tour / Next / Done is the shared ink button and No thanks / Back the borderless one, each a 44pt target', () => {
    expect(code).toContain("const primary = buttonTone('primary', c);");
    expect(code).toContain("const ghost = buttonTone('ghost', c);");
    expect(
      (code.match(/\{ backgroundColor: primary\.bg, borderColor: primary\.border \}/g) ?? [])
        .length,
    ).toBe(2);
    expect(
      (code.match(/style=\{\[styles\.action, \{ borderColor: ghost\.border \}\]\}/g) ?? []).length,
    ).toBe(2);
    const action = styleBlock(TOUR, 'action');
    expect(action).toContain('minHeight: MIN_TAP,');
    expect(action).toContain('borderRadius: BUTTON_RADIUS.sm,');
    expect(code).toContain('<X size={15} color={c.ink3} />');
    expect(code).toContain('backgroundColor: i === step ? c.ink : c.ink4,');
  });

  // The pill was 26.5pt tall: a frame makes the target 44pt while the
  // screens that place it lay out around the same pill.
  it('the Tour pill sits in a real 44pt frame whose margins hand the extra height back', () => {
    const { sf, els } = elements(
      TOUR,
      (el, s) =>
        TOUCHABLE_TAG.test(tagOf(el, s)) &&
        attrText(el, 'accessibilityLabel', s) === '`Start the ${tour.name} tour`',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'hitSlop', sf)).toBeUndefined();
    expect(flat(attrText(els[0]!, 'style', sf) ?? '')).toContain(
      'styles.pillFrame, { marginVertical: tourPillFrameMargin(fontScale), opacity: pressed ? 0.6 : 1 },',
    );
    expect(code).toContain(
      'const { width: winW, height: winH, fontScale } = useWindowDimensions();',
    );
    expect(code).toContain('<View style={[styles.pill, { borderColor: c.hair2 }]}>');
    const frame = styleBlock(TOUR, 'pillFrame');
    expect(frame).toContain('minHeight: MIN_TAP,');
    expect(frame).toContain('minWidth: MIN_TAP,');
    expect(styleBlock(TOUR, 'pill')).toContain('borderWidth: 1,');

    const { tourPillFrameMargin, MIN_TAP } = compileTopLevel(
      TOUR,
      ['MIN_TAP', 'TOUR_PILL_LABEL', 'tourPillFrameMargin'],
      {},
    ) as { tourPillFrameMargin: (s: number) => number; MIN_TAP: number };
    expect(MIN_TAP).toBe(44);
    const pill = (s: number) => 11 * 1.5 * s + 8 + 2;
    // At the default size the frame is 44pt and gives back 8.75pt each side,
    // so it takes up exactly the 26.5pt pill.
    expect(tourPillFrameMargin(1)).toBe(-8.75);
    for (const s of [0.82, 1, 1.12, 1.4, 1.8]) {
      expect(44 + 2 * tourPillFrameMargin(s)).toBeCloseTo(pill(s), 6);
    }
    // Once the pill is taller than 44pt the frame is the pill: no margin.
    expect(tourPillFrameMargin(2.5)).toBeCloseTo(0, 9);
    expect(tourPillFrameMargin(3.57)).toBeCloseTo(0, 9);
    // A missing or nonsense scale is read as the default size.
    expect(tourPillFrameMargin(Number.NaN)).toBe(-8.75);
    expect(tourPillFrameMargin(0)).toBe(-8.75);
  });
});

// ── The splash, the error boundary, the Zendesk mark ─────────────────────

describe('cold-launch splash: the same sequence and hand-off, in the dark palette', () => {
  const src = sourceOf(SPLASH);
  const code = flat(codeOnly(src));

  it('keeps the timeline, the reduced-motion path and the hand-off', () => {
    for (const line of [
      'const GRID_IN = 200;',
      'const BEAM_START = 120;',
      'const BEAM_SWEEP = 500;',
      'const PULSE_START = 640;',
      'const PULSE_DUR = 260;',
      'const ANIM_DONE = 900;',
      'const REDUCED_DONE = 300;',
      'export const CROSSFADE_MS = 460;',
      'const REDUCED_CROSSFADE_MS = 240;',
    ]) {
      expect(code, line).toContain(line);
    }
    expect(code).toContain('void AccessibilityInfo.isReduceMotionEnabled().then((on) => {');
    expect(code).toContain(
      'if (handedOff.current) return; handedOff.current = true; onHandoffRef.current?.();',
    );
    expect(code).toContain('accessibilityRole="button" accessibilityLabel="Loading StockPilot"');
    expect(code).toContain('onPress={() => handoffRef.current()}');
  });

  it("draws in the dark palette's tokens, whatever the device's mode", () => {
    const tokens = compileTopLevel(
      SPLASH,
      ['withAlpha', 'DARK', 'INK', 'PAPER', 'MINT', 'GRID_LINE', 'BEAM_TAIL'],
      { palette },
    ) as Record<string, string>;
    expect(tokens.INK).toBe(DARK.paper);
    expect(tokens.PAPER).toBe(DARK.ink);
    expect(tokens.MINT).toBe(DARK.accent);
    expect(tokens.GRID_LINE).toBe('rgba(240,239,232,0.045)');
    expect(tokens.BEAM_TAIL).toBe('rgba(240,239,232,0.1)');
    // The root's cold ground is the same colour, so the hand-off is seamless.
    expect(tokens.INK).toBe(SPLASH_GROUND_HEX);
    // Only the mask's black and white are literal (mask luminance, not colour).
    expect(
      [...code.matchAll(/'#[0-9a-f]{3,6}'|"#[0-9a-f]{3,6}"/gi)].map((m) => m[0]).sort(),
    ).toEqual(['"#000"', '"#fff"']);
  });
});

describe('error boundary: still free of the theme layer, now in its tokens', () => {
  const src = sourceOf(BOUNDARY);
  const code = flat(codeOnly(src));

  it('reads no hook and no context: the palette is a constant read at module load', () => {
    expect(code).toContain("const SCREEN = palette('dark');");
    for (const leak of ['useTheme', 'useColorScheme', 'useContext', 'use-theme']) {
      expect(code, leak).not.toContain(leak);
    }
    expect(code).not.toMatch(/'#[0-9a-f]{3,6}'/i);
  });

  it('the same words, an OTA-aware Reload, and the report to Sentry', () => {
    const words = wordsOf(BOUNDARY);
    for (const w of [
      'Something went wrong',
      'The app hit an unexpected error. Reloading usually fixes it.',
      'Reload',
    ]) {
      expect(words, w).toContain(w);
    }
    expect(code).toContain('await Updates.reloadAsync();');
    expect(code).toContain('this.setState({ error: null });');
    expect(code).toContain('Sentry.captureException(error, {');
  });

  it('the title is a header and Reload the reference ink button, 52pt', () => {
    expect(code).toContain('<Text accessibilityRole="header"');
    expect(code).toContain('backgroundColor: SCREEN.ink, minHeight: 52,');
    expect(code).toContain('borderRadius: 14,');
    expect(code).toContain(
      "<Text style={{ color: SCREEN.paper, fontWeight: '700', fontSize: 15 }}>Reload</Text>",
    );
    expect(code).toContain('color: SCREEN.ink3,');
  });
});

it('the Zendesk mark draws in the ink of the mode when no colour is passed (it was a fixed near-black)', () => {
  const code = flat(codeOnly(sourceOf(ZENDESK_LOGO)));
  expect(code).toContain('fill={color ?? c.ink}');
  expect(code).not.toContain('#111');
});

// ── Contrast of every pair this package changed, both modes ──────────────

describe('contrast (WCAG 2.x): every word at 4.5:1, every mark at 3:1, in both modes', () => {
  // [what, fg token, bg token, minimum]
  const PAIRS: [string, keyof Palette, keyof Palette, number][] = [
    ['tab bar: the active tab', 'accent', 'paper', AA_TEXT],
    ['tab bar: the other tabs', 'ink3', 'paper', AA_TEXT],
    ['drawer: the selected row', 'ink', 'paper2', AA_TEXT],
    ['drawer: a row', 'ink2', 'paper', AA_TEXT],
    ['drawer: a row icon', 'ink3', 'paper', AA_UI],
    ['drawer: TAB on a row', 'ink3', 'paper', AA_TEXT],
    ['drawer: TAB on the selected row', 'ink3', 'paper2', AA_TEXT],
    ['drawer: the email', 'ink3', 'paper', AA_TEXT],
    ['drawer: Sign out', 'critText', 'paper', AA_TEXT],
    ['switcher chip: WORKSPACE and the warehouse', 'ink3', 'card', AA_TEXT],
    ['switcher: the chosen row', 'ink', 'sunk', AA_TEXT],
    ['switcher: the chosen row role', 'ink3', 'sunk', AA_TEXT],
    ['switcher: a role, the empty list', 'ink3', 'card', AA_TEXT],
    ['switcher: the chosen edge', 'ink', 'card', AA_UI],
    ["What's New and the tour: the X", 'ink3', 'card', AA_UI],
    ["What's New: the CTA", 'ink', 'card', AA_TEXT],
    ["What's New and the tour: Next / Done / Start tour", 'paper', 'ink', AA_TEXT],
    ['tour: No thanks / Back', 'ink', 'card', AA_TEXT],
    ['tour: the Tour pill', 'ink3', 'paper', AA_TEXT],
    ['carousel: a resting dot', 'ink4', 'card', AA_UI],
  ];

  it.each(MODES)('%s', (_mode, c) => {
    const failing = PAIRS.filter(([, fg, bg, min]) => contrast(c[fg], c[bg]) < min).map(
      ([what, fg, bg]) => `${what}: ${fg} on ${bg} = ${contrast(c[fg], c[bg]).toFixed(2)}`,
    );
    expect(failing).toEqual([]);
  });

  it('the always-dark surfaces: the splash and the error boundary', () => {
    expect(contrast(DARK.ink, DARK.paper)).toBeGreaterThanOrEqual(AA_TEXT); // wordmark, title
    expect(contrast(DARK.ink3, DARK.paper)).toBeGreaterThanOrEqual(AA_TEXT); // the message
    expect(contrast(DARK.paper, DARK.ink)).toBeGreaterThanOrEqual(AA_TEXT); // Reload
    expect(contrast(DARK.accent, DARK.paper)).toBeGreaterThanOrEqual(AA_UI); // the pip
  });

  // What the restyle fixed, measured: ink4 words, the fixed red in dark mode,
  // the hairline dots, the fixed near-black Zendesk mark on the dark page.
  it('the old values that failed', () => {
    expect(contrast(LIGHT.ink4, LIGHT.paper)).toBeLessThan(AA_TEXT);
    expect(contrast('#b03a3a', DARK.paper)).toBeLessThan(AA_TEXT);
    expect(contrast(LIGHT.hair, LIGHT.card)).toBeLessThan(AA_UI);
    expect(contrast('#111111', DARK.paper)).toBeLessThan(AA_UI);
    // The P3.8 hand-off, which the drawer now hides the status bar for: in
    // light mode the root's black status bar glyphs past the drawer sit on
    // the Scan tab's camera bar (#0a0b09) under the light scrim
    // (rgba(14, 15, 13, 0.4)), which composite to #0c0d0b. Over the panel
    // they read at 20:1.
    expect(contrast('#000000', '#0c0d0b')).toBeLessThan(AA_UI);
    expect(contrast('#000000', LIGHT.paper)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});
