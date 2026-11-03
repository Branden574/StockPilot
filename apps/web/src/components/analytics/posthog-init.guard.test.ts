import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * RECURRENCE GUARD (docket S22, owner decision d.4): the app's one PostHog init
 * never records a session, and nothing turns recording back on.
 *
 * What the code leaves unset, the PostHog project decides from its settings
 * page, with no review and no test to see it. A recording is the page itself
 * (its text, its links, a requester's return link among them), which the
 * before_send scrub leaves alone. The SDK records only when the project says
 * yes AND `disable_session_recording` is false, so the provider pins it to
 * true; posthog-provider.sdk.test.tsx proves that through the real SDK. This
 * keeps the pin where it works:
 *
 *   (a) disable_session_recording is named once in the app: the option the
 *       provider passes to posthog.init, the literal true. Any other mention
 *       (a write to posthog.config, a set_config call, a quoted key) could
 *       undo it, and so could a spread in the same options.
 *   (b) Nothing names startSessionRecording, which sets the option back to
 *       false.
 *   (c) posthog-js is initialized once, from the bare package: by the
 *       provider's call that holds the pin. A second init would run without
 *       it, and so would posthog-js/react, whose provider inits from props.
 *
 * Docket S28 adds two more the project can switch on by itself that send the
 * page address without passing before_send: console log capture (PostHog's
 * Logs) stamps each record with it after the logs hook has run, and
 * Conversations (its chat) posts it with a new ticket.
 *
 *   (d) disable_conversations is held as (a) holds the replay switch.
 *   (e) The same options pass logs.beforeSend as a function that returns
 *       null: a record is dropped before it is built, so before it gets the
 *       address. No client option can refuse the project's console capture.
 *   (f) Nothing names set_config, which would replace any of these options
 *       while the page runs (logs among them, hook and all).
 *
 * The S22 review found a third path of S28's kind, and two ways round the
 * rules above:
 *
 *   (g) advanced_disable_feature_flags is held as (a) holds the replay switch.
 *       The SDK keeps the first page a device visited, query and all, and
 *       sends it with every feature-flags request, past before_send; the app
 *       reads no flag.
 *   (h) Only the provider and lib/analytics.ts load posthog-js at runtime,
 *       and neither exports more than its own names, so the instance reaches
 *       no module these rules skip: a re-export would carry it to a second
 *       init that (c) never reads.
 *   (i) Neither names config. A write to posthog.config can replace any
 *       option, and the SDK reads logs from it live, a new object without
 *       the hook and all.
 *
 * It reads the source through the AST, so comments never count.
 */

const WEB_SRC = path.resolve(__dirname, '../..');
const PROVIDER = path.join(WEB_SRC, 'components/analytics/posthog-provider.tsx');
const PACKAGE = 'posthog-js';

/** The only modules that may load posthog-js at runtime, each with every name it exports. */
const LOADERS: ReadonlyMap<string, readonly string[]> = new Map([
  [PROVIDER, ['PostHogProvider']],
  [path.join(WEB_SRC, 'lib/analytics.ts'), ['analyticsEnabled', 'capture', 'identify', 'reset']],
]);

interface ScanFile {
  path: string;
  text: string;
}

/** A node in a file, with what it takes to say where it is. */
interface Found {
  file: ScanFile;
  source: ts.SourceFile;
  node: ts.Node;
}

const parsed = new WeakMap<ScanFile, ts.SourceFile>();

function parse(file: ScanFile): ts.SourceFile {
  let source = parsed.get(file);
  if (!source) {
    source = ts.createSourceFile(
      file.path,
      file.text,
      ts.ScriptTarget.Latest,
      true,
      file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    parsed.set(file, source);
  }
  return source;
}

/** path:line inside src. */
function where({ file, source, node }: Found): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${path.relative(WEB_SRC, file.path)}:${line + 1}`;
}

/** Every node of every file that `match` accepts, in source order. */
function findAll(files: readonly ScanFile[], match: (node: ts.Node) => boolean): Found[] {
  const found: Found[] = [];
  for (const file of files) {
    const source = parse(file);
    const visit = (node: ts.Node) => {
      if (match(node)) found.push({ file, source, node });
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/**
 * Every place the code names `name`: as an identifier (a key, a property
 * access, a binding, a shorthand) or as a string (an element access, a quoted
 * or computed key).
 */
function mentions(files: readonly ScanFile[], name: string): Found[] {
  return findAll(
    files,
    (node) => (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === name,
  );
}

/** The name a property or element access reads: `x.name`, `x?.name`, `x['name']`. */
function accessName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
}

/** The key a destructured binding reads: `{ name }`, `{ name: alias }`, `{ 'name': alias }`. */
function bindingKey(node: ts.Node): string | undefined {
  if (!ts.isBindingElement(node) || !ts.isObjectBindingPattern(node.parent)) return undefined;
  const key = node.propertyName ?? node.name;
  return ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
}

/** The options object of a call to `<x>.init(key, options)` in the provider, if this is one. */
function providerInitOptions(found: Found): ts.ObjectLiteralExpression | undefined {
  const call = found.node;
  if (found.file.path !== PROVIDER || !ts.isCallExpression(call)) return undefined;
  const options = call.arguments[1];
  return accessName(call.expression) === 'init' && options && ts.isObjectLiteralExpression(options)
    ? options
    : undefined;
}

/** The options objects the provider passes to `<x>.init(key, options)`. */
function providerInits(files: readonly ScanFile[]): ts.ObjectLiteralExpression[] {
  return findAll(
    files.filter((file) => file.path === PROVIDER),
    ts.isCallExpression,
  ).flatMap((call) => providerInitOptions(call) ?? []);
}

/** The value of the one property an object literal names `name`, with no spread beside it. */
function propertyValue(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  if (object.properties.some(ts.isSpreadAssignment)) return undefined;
  const matches = object.properties.filter(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
      property.name.text === name,
  );
  return matches.length === 1 ? matches[0]?.initializer : undefined;
}

/**
 * Whether init options pass `logs: { beforeSend }` as a function that returns
 * the literal null and does nothing else: `() => null` or `() => { return null; }`.
 */
function dropsEveryLog(options: ts.ObjectLiteralExpression): boolean {
  const logs = propertyValue(options, 'logs');
  const hook =
    logs && ts.isObjectLiteralExpression(logs) ? propertyValue(logs, 'beforeSend') : undefined;
  if (!hook || !(ts.isArrowFunction(hook) || ts.isFunctionExpression(hook))) return false;
  const { body } = hook;
  if (!ts.isBlock(body)) return body.kind === ts.SyntaxKind.NullKeyword;
  const [only, ...rest] = body.statements;
  return (
    rest.length === 0 &&
    !!only &&
    ts.isReturnStatement(only) &&
    only.expression?.kind === ts.SyntaxKind.NullKeyword
  );
}

/**
 * Whether a mention is a key of the options the provider passes to
 * posthog.init, set to the literal true, in options with no spread that could
 * override it.
 */
function isProviderPin(mention: Found): boolean {
  const property = mention.node.parent;
  if (!property || !ts.isPropertyAssignment(property) || property.name !== mention.node) {
    return false;
  }
  const options = property.parent;
  return (
    property.initializer.kind === ts.SyntaxKind.TrueKeyword &&
    ts.isObjectLiteralExpression(options) &&
    !options.properties.some(ts.isSpreadAssignment) &&
    providerInitOptions({ ...mention, node: options.parent }) === options
  );
}

/** Every mention of a switch, the provider's pin marked as such. */
function pinMentions(files: readonly ScanFile[], name: string): string[] {
  return mentions(files, name).map((m) => (isProviderPin(m) ? `${where(m)} (the pin)` : where(m)));
}

/** Whether an import or export-from declaration brings in a value, not types alone. */
function bringsValue(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return true; // import 'x' runs the module
    if (clause.isTypeOnly) return false;
    if (clause.name) return true; // a default import
    const bindings = clause.namedBindings;
    if (!bindings || ts.isNamespaceImport(bindings)) return true;
    return bindings.elements.length === 0 || bindings.elements.some((e) => !e.isTypeOnly);
  }
  if (node.isTypeOnly) return false;
  const clause = node.exportClause;
  if (!clause || ts.isNamespaceExport(clause)) return true; // export * from 'x'
  return clause.elements.length === 0 || clause.elements.some((e) => !e.isTypeOnly);
}

/** The module a node loads at runtime: an import or export-from of a value, import() or require(). */
function runtimeSpecifier(node: ts.Node): string | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier) &&
    bringsValue(node)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
    node.arguments[0] &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  return undefined;
}

/**
 * Whether a node loads posthog-js, or a subpath of it, at runtime. Type imports
 * and `typeof import('posthog-js')` are types, gone at runtime.
 */
function loadsPosthog(node: ts.Node): boolean {
  const specifier = runtimeSpecifier(node);
  return specifier === PACKAGE || !!specifier?.startsWith(`${PACKAGE}/`);
}

/** Every place the code loads posthog-js at runtime, with the specifier it names. */
function posthogLoads(files: readonly ScanFile[]): string[] {
  return findAll(files, loadsPosthog).map(
    (found) => `${where(found)} ${runtimeSpecifier(found.node)}`,
  );
}

/**
 * In the modules that load posthog-js at runtime, every access named init:
 * `x.init`, `x['init']`, `{ init } = x`.
 */
function initAccesses(files: readonly ScanFile[]): Found[] {
  const loaders = files.filter((file) => findAll([file], loadsPosthog).length > 0);
  return findAll(loaders, (node) => accessName(node) === 'init' || bindingKey(node) === 'init');
}

/** The init accesses, each marked when it is the call whose options hold the replay pin. */
function inits(files: readonly ScanFile[]): string[] {
  return initAccesses(files).map((found) => {
    const call = found.node.parent;
    const options =
      call && ts.isCallExpression(call) && call.expression === found.node
        ? providerInitOptions({ ...found, node: call })
        : undefined;
    const holdsPin =
      !!options &&
      mentions([found.file], 'disable_session_recording').some(
        (m) => isProviderPin(m) && m.node.parent?.parent === options,
      );
    return holdsPin ? `${where(found)} (holds the pin)` : where(found);
  });
}

/**
 * Every load of posthog-js these rules cannot follow: one in a module other
 * than the provider and lib/analytics.ts, or one of a subpath.
 */
function loadsOutside(files: readonly ScanFile[]): string[] {
  return findAll(files, loadsPosthog)
    .filter((found) => !LOADERS.has(found.file.path) || runtimeSpecifier(found.node) !== PACKAGE)
    .map((found) => `${where(found)} ${runtimeSpecifier(found.node)}`);
}

/** Whether a statement carries a modifier such as `export` or `default`. */
function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === kind);
}

/** The names a binding declares: `a`, `{ a, b: c }`, `[a, ...d]`. */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

/**
 * Every name a module exports, types included: `default` for a default
 * export and `*` for `export * from`. An export it cannot name is reported by
 * where it is, so none passes unread.
 */
function exportedNames(file: ScanFile): string[] {
  const source = parse(file);
  return source.statements.flatMap((statement): string[] => {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (!clause) return ['*'];
      return ts.isNamespaceExport(clause)
        ? [clause.name.text]
        : clause.elements.map((element) => element.name.text);
    }
    if (ts.isExportAssignment(statement)) return ['default'];
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return [];
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) return ['default'];
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.flatMap((d) => bindingNames(d.name));
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement)) &&
      statement.name &&
      (ts.isIdentifier(statement.name) || ts.isStringLiteral(statement.name))
    ) {
      return [statement.name.text];
    }
    return [`an export at ${where({ file, source, node: statement })}`];
  });
}

/** Every place the provider or lib/analytics.ts names config. */
function configMentions(files: readonly ScanFile[]): Found[] {
  return mentions(
    files.filter((file) => LOADERS.has(file.path)),
    'config',
  );
}

/** The app's own modules: tests and the test helpers are not the app. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules' && full !== path.join(WEB_SRC, 'test')) sourceFiles(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/* ─────────────────────────────── self-test ─────────────────────────────── */

const file = (relative: string, ...lines: string[]): ScanFile => ({
  path: path.join(WEB_SRC, relative),
  text: lines.join('\n'),
});

/** The switches the provider pins to the literal true. */
const SWITCHES = [
  'disable_session_recording',
  'disable_conversations',
  'advanced_disable_feature_flags',
] as const;

/** The provider's pins, as its init options hold them. */
const PINS = `${SWITCHES.map((name) => `${name}: true`).join(', ')}, logs: { beforeSend: () => null }`;

/** A planted provider whose one init passes these options (line 5). */
const providerWith = (options: string): ScanFile =>
  file(
    'components/analytics/posthog-provider.tsx',
    `'use client';`,
    `export function PostHogProvider({ apiKey }: { apiKey: string }) {`,
    `  void import('posthog-js').then(({ default: posthog }) => {`,
    `    // disable_session_recording: false, startSessionRecording(), set_config({ disable_conversations: false }).`,
    `    posthog.init(apiKey, { api_host: '/ingest', ${options} });`,
    `  });`,
    `  return null;`,
    `}`,
  );

const PROVIDER_OK = providerWith(PINS);

/** A planted lib/analytics.ts in the shape of the real one. */
const ANALYTICS_OK = file(
  'lib/analytics.ts',
  `export const analyticsEnabled = true;`,
  `let loaded: Promise<typeof import('posthog-js').default> | null = null;`,
  `const load = () => (loaded ??= import('posthog-js').then((m) => m.default));`,
  `export function capture(event: string): void {`,
  `  void load().then((posthog) => posthog.capture(event));`,
  `}`,
  `export function identify(id: string): void {`,
  `  void load().then((posthog) => posthog.identify(id));`,
  `}`,
  `export function reset(): void {`,
  `  void load().then((posthog) => posthog.reset());`,
  `}`,
);

describe('the PostHog init scanner (self-test on planted files)', () => {
  it('sees the pins in the provider, and nothing in a comment', () => {
    for (const name of SWITCHES) {
      expect(pinMentions([PROVIDER_OK], name)).toEqual([
        'components/analytics/posthog-provider.tsx:5 (the pin)',
      ]);
    }
    expect(providerInits([PROVIDER_OK]).map(dropsEveryLog)).toEqual([true]);
    expect(mentions([PROVIDER_OK], 'startSessionRecording')).toEqual([]);
    expect(mentions([PROVIDER_OK], 'set_config')).toEqual([]);
    expect(inits([PROVIDER_OK])).toEqual([
      'components/analytics/posthog-provider.tsx:5 (holds the pin)',
    ]);
  });

  it('does not take false, !0, a variable or a spread after it for a pin', () => {
    for (const name of SWITCHES) {
      for (const planted of [
        providerWith(PINS.replace(`${name}: true`, `${name}: false`)),
        providerWith(PINS.replace(`${name}: true`, `${name}: !0`)),
        providerWith(PINS.replace(`${name}: true`, `${name}: switchedOff`)),
        providerWith(`${PINS}, ...overrides`),
      ]) {
        expect(pinMentions([planted], name)).toEqual([
          'components/analytics/posthog-provider.tsx:5',
        ]);
      }
    }
  });

  it('finds every other mention of a switch: set_config, a direct write, a quoted write', () => {
    for (const name of SWITCHES) {
      const planted = file(
        'lib/switch-back.ts',
        `import posthog from 'posthog-js';`,
        `posthog.set_config({ ${name}: false });`,
        `posthog.config.${name} = false;`,
        `posthog.config['${name}'] = false;`,
      );
      expect(pinMentions([PROVIDER_OK, planted], name)).toEqual([
        'components/analytics/posthog-provider.tsx:5 (the pin)',
        'lib/switch-back.ts:2',
        'lib/switch-back.ts:3',
        'lib/switch-back.ts:4',
      ]);
    }
  });

  it('takes only a hook that returns null, alone in its options, for the log drop', () => {
    const others = SWITCHES.map((name) => `${name}: true`).join(', ');
    expect(
      providerInits([providerWith(`${others}, logs: { beforeSend: () => { return null; } }`)]).map(
        dropsEveryLog,
      ),
    ).toEqual([true]);
    for (const logs of [
      '',
      ', logs: {}',
      ', logs: { beforeSend: (record) => record }',
      ', logs: { beforeSend: () => undefined }',
      ', logs: { beforeSend: [() => null] }',
      ', logs: { beforeSend: dropAll }',
      ', logs: { beforeSend: () => { report(); return null; } }',
      ', logs: { beforeSend: () => null, ...more }',
      ', logs: { beforeSend: () => null }, ...overrides',
      ', logs: loggingOptions',
    ]) {
      expect(providerInits([providerWith(`${others}${logs}`)]).map(dropsEveryLog)).toEqual([false]);
    }
  });

  it('finds set_config by call, by element access and by destructuring', () => {
    const planted = file(
      'lib/switch-back.ts',
      `import posthog from 'posthog-js';`,
      `posthog.set_config({ logs: {} });`,
      `posthog['set_config']({ logs: {} });`,
      `const { set_config } = posthog;`,
    );
    expect(mentions([planted], 'set_config').map(where)).toEqual([
      'lib/switch-back.ts:2',
      'lib/switch-back.ts:3',
      'lib/switch-back.ts:4',
    ]);
  });

  it('finds startSessionRecording by call, by element access and by destructuring', () => {
    const planted = file(
      'lib/replay.ts',
      `import posthog from 'posthog-js';`,
      `posthog.startSessionRecording();`,
      `posthog['startSessionRecording']();`,
      `const { startSessionRecording } = posthog;`,
    );
    expect(mentions([planted], 'startSessionRecording').map(where)).toEqual([
      'lib/replay.ts:2',
      'lib/replay.ts:3',
      'lib/replay.ts:4',
    ]);
  });

  it('finds a second init in a module that loads posthog-js by import(), and posthog-js/react', () => {
    const second = file(
      'lib/second-init.ts',
      `export async function start(apiKey: string) {`,
      `  const { default: posthog } = await import('posthog-js');`,
      `  posthog.init(apiKey, {});`,
      `}`,
    );
    const destructured = file(
      'lib/third-init.ts',
      `const { init } = require('posthog-js');`,
      `export default init;`,
    );
    const react = file(
      'app/providers.tsx',
      `import { PostHogProvider } from 'posthog-js/react';`,
      `export const Providers = PostHogProvider;`,
    );
    const planted = [PROVIDER_OK, second, destructured, react];
    expect(inits(planted)).toEqual([
      'components/analytics/posthog-provider.tsx:5 (holds the pin)',
      'lib/second-init.ts:3',
      'lib/third-init.ts:1',
    ]);
    expect(posthogLoads(planted)).toEqual([
      'components/analytics/posthog-provider.tsx:3 posthog-js',
      'lib/second-init.ts:2 posthog-js',
      'lib/third-init.ts:1 posthog-js',
      'app/providers.tsx:1 posthog-js/react',
    ]);
  });

  it('ignores type-only imports, typeof import() types and another library’s init', () => {
    const typesOnly = file(
      'lib/analytics-before-send.ts',
      `import type { CaptureResult } from 'posthog-js';`,
      `import { type PostHogConfig } from 'posthog-js';`,
      `export type { BeforeSendFn } from 'posthog-js';`,
      `import * as Sentry from '@sentry/nextjs';`,
      `Sentry.init({});`,
      `export type Hook = (event: CaptureResult, config: PostHogConfig) => CaptureResult;`,
    );
    const typeQuery = file(
      'lib/analytics.ts',
      `let loaded: Promise<typeof import('posthog-js').default> | null = null;`,
      `export const load = () => (loaded ??= import('posthog-js').then((m) => m.default));`,
    );
    expect(posthogLoads([typesOnly, typeQuery])).toEqual(['lib/analytics.ts:2 posthog-js']);
    expect(inits([typesOnly, typeQuery])).toEqual([]);
  });

  it('finds a load outside the provider and lib/analytics.ts, as a re-export that carries the instance to a second init', () => {
    const reexport = file('lib/ph.ts', `export { default as posthog } from 'posthog-js';`);
    const second = file(
      'lib/second-init.ts',
      `import { posthog } from '@/lib/ph';`,
      `export function start(apiKey: string): void {`,
      `  posthog.init(apiKey, { api_host: '/ingest' }, 'second');`,
      `}`,
    );
    const planted = [PROVIDER_OK, ANALYTICS_OK, reexport, second];
    // The second init's module loads nothing from posthog-js itself, so the
    // init count never reads it: the load outside is what is caught.
    expect(inits(planted)).toEqual(['components/analytics/posthog-provider.tsx:5 (holds the pin)']);
    expect(loadsOutside(planted)).toEqual(['lib/ph.ts:1 posthog-js']);
    expect(loadsOutside([PROVIDER_OK, ANALYTICS_OK])).toEqual([]);
    expect(
      loadsOutside([
        file('lib/analytics.ts', `import { PostHogProvider } from 'posthog-js/react';`),
      ]),
    ).toEqual(['lib/analytics.ts:1 posthog-js/react']);
  });

  it('names every export of a module, so a loader that hands the instance on is caught', () => {
    expect(exportedNames(PROVIDER_OK)).toEqual(['PostHogProvider']);
    expect(exportedNames(ANALYTICS_OK)).toEqual([
      'analyticsEnabled',
      'capture',
      'identify',
      'reset',
    ]);
    const handsOn = file(
      'lib/analytics.ts',
      `import posthog from 'posthog-js';`,
      `export { default as instance } from 'posthog-js';`,
      `export * from 'posthog-js';`,
      `export const { config, init: start } = posthog;`,
      `export default posthog;`,
      `export function load() { return posthog; }`,
      `const same = posthog;`,
      `export { same, same as again };`,
      `export type Instance = typeof posthog;`,
    );
    expect(exportedNames(handsOn)).toEqual([
      'instance',
      '*',
      'config',
      'start',
      'default',
      'load',
      'same',
      'again',
      'Instance',
    ]);
  });

  it('finds config named in a loader: a direct write, a quoted write, destructuring, a key', () => {
    const planted = file(
      'lib/analytics.ts',
      `import posthog from 'posthog-js';`,
      `posthog.config.logs = { captureConsoleLogs: true };`,
      `posthog.config['logs'] = {};`,
      `posthog['config'].logs = {};`,
      `const { config } = posthog;`,
      `Object.assign(posthog, { config: {} });`,
    );
    const elsewhere = file('lib/settings.ts', `export const config = { theme: 'light' };`);
    expect(configMentions([PROVIDER_OK, planted, elsewhere]).map(where)).toEqual([
      'lib/analytics.ts:2',
      'lib/analytics.ts:3',
      'lib/analytics.ts:4',
      'lib/analytics.ts:5',
      'lib/analytics.ts:6',
    ]);
    expect(configMentions([PROVIDER_OK, ANALYTICS_OK])).toEqual([]);
  });
});

/* ───────────────────────────── the app's source ───────────────────────────── */

let appFiles: ScanFile[] | undefined;
function app(): ScanFile[] {
  appFiles ??= sourceFiles(WEB_SRC).map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));
  return appFiles;
}

describe('the one PostHog init never records a session (S22)', () => {
  it('disable_session_recording is named once: the provider’s init option, set to true', () => {
    expect(pinMentions(app(), 'disable_session_recording')).toEqual([
      expect.stringMatching(/^components\/analytics\/posthog-provider\.tsx:\d+ \(the pin\)$/),
    ]);
  });

  it('nothing names startSessionRecording', () => {
    expect(mentions(app(), 'startSessionRecording').map(where)).toEqual([]);
  });

  it('posthog-js is initialized once, from the bare package, by the call that holds the pin', () => {
    expect(posthogLoads(app()).filter((load) => !load.endsWith(` ${PACKAGE}`))).toEqual([]);
    expect(inits(app())).toEqual([
      expect.stringMatching(/^components\/analytics\/posthog-provider\.tsx:\d+ \(holds the pin\)$/),
    ]);
  });
});

describe('the one PostHog init sends nothing that skips before_send (S28)', () => {
  it('disable_conversations is named once: the provider’s init option, set to true', () => {
    expect(pinMentions(app(), 'disable_conversations')).toEqual([
      expect.stringMatching(/^components\/analytics\/posthog-provider\.tsx:\d+ \(the pin\)$/),
    ]);
  });

  it('the provider’s init drops every log record: logs.beforeSend returns null', () => {
    expect(providerInits(app()).map(dropsEveryLog)).toEqual([true]);
  });

  it('nothing names set_config', () => {
    expect(mentions(app(), 'set_config').map(where)).toEqual([]);
  });

  it('advanced_disable_feature_flags is named once: the provider’s init option, set to true (S22 review)', () => {
    expect(pinMentions(app(), 'advanced_disable_feature_flags')).toEqual([
      expect.stringMatching(/^components\/analytics\/posthog-provider\.tsx:\d+ \(the pin\)$/),
    ]);
  });
});

describe('the PostHog instance stays where these rules read it (S22 review)', () => {
  it('only the provider and lib/analytics.ts load posthog-js at runtime, from the bare package', () => {
    expect(loadsOutside(app())).toEqual([]);
  });

  it('neither exports more than its own names, so the instance goes no further', () => {
    for (const [loader, names] of LOADERS) {
      const found = app().find((candidate) => candidate.path === loader);
      if (!found) throw new Error(`${path.relative(WEB_SRC, loader)} is gone: update LOADERS`);
      expect(exportedNames(found)).toEqual(names);
    }
  });

  it('neither names config, so no write to posthog.config can undo an option', () => {
    expect(configMentions(app()).map(where)).toEqual([]);
  });
});
