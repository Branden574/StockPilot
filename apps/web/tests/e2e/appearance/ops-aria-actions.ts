/**
 * The actions in an ARIA snapshot, for the operations lane's action
 * inventory (plan 8.5, ops-actions.spec.ts). The snapshot is Playwright's
 * YAML of the accessibility tree (locator.ariaSnapshot()); each action in it
 * (a link, button, field, tab, menu item or option) becomes one entry,
 * `role "name"`, and a link adds its target, ` -> /path`. States
 * ([checked], [selected], [disabled], [expanded]) and values (a field's
 * text) are left out: they are state, which the transitions spec keeps
 * across a switch. Sorted, with repeats kept, so a doubled or a dropped
 * action shows.
 *
 * How Playwright writes a node (playwright-core 1.64,
 * renderAriaSnapshotAsYaml): `- role "name" [state]`, the name as a JSON
 * string, then `: text`, or `:` and its children on the lines below, two
 * spaces deeper. A key YAML cannot hold bare (one with ": " or " #" in it)
 * is wrapped in single quotes, a quote inside doubled. A link's first child
 * is its target, `- /url: value`, the value in double quotes with JSON-style
 * escapes when YAML needs them.
 *
 * No Playwright import, so a script can check it against a real snapshot
 * without the test runner.
 */

/** The roles that act: links and the ARIA widget roles. */
const ACTION_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'switch',
  'radio',
  'tab',
  'menuitem',
  'menuitemradio',
  'menuitemcheckbox',
  'spinbutton',
  'slider',
]);

const NODE_LINE = /^( *)- (.*)$/u;
const KEY = /^([a-z]+)(?: ("(?:[^"\\]|\\.)*"))?/u;

/** A key as written, without YAML's single quotes when it has them. */
function unquotedKey(written: string): string {
  if (!written.startsWith("'")) return written;
  let key = '';
  for (let i = 1; i < written.length; i += 1) {
    if (written[i] === "'") {
      if (written[i + 1] !== "'") break;
      i += 1;
    }
    key += written[i];
  }
  return key;
}

/** A YAML scalar as written: bare, or in double quotes with JSON escapes. */
function scalar(written: string): string {
  const value = written.trim();
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value;
  }
}

export function actionsOf(snapshot: string): string[] {
  const lines = snapshot.split('\n');
  const actions: string[] = [];
  lines.forEach((line, at) => {
    const node = NODE_LINE.exec(line);
    if (!node) return;
    const key = KEY.exec(unquotedKey(node[2]!));
    if (!key || !ACTION_ROLES.has(key[1]!)) return;
    const name = key[2] ? (JSON.parse(key[2]) as string) : '';
    let action = `${key[1]} ${JSON.stringify(name)}`;
    if (key[1] === 'link') {
      const depth = node[1]!.length;
      for (const below of lines.slice(at + 1)) {
        const child = NODE_LINE.exec(below);
        if (!child || child[1]!.length <= depth) break;
        if (child[1]!.length === depth + 2 && child[2]!.startsWith('/url: ')) {
          action += ` -> ${scalar(child[2]!.slice('/url: '.length))}`;
          break;
        }
      }
    }
    actions.push(action);
  });
  return actions.sort();
}
