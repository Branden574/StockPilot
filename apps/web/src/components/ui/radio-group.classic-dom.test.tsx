import { cleanup, render } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { classicDom, classicStructure, glassOnlyCount } from '@/test/classic-dom';

import { RadioGroup, RadioGroupItem } from './radio-group';

/**
 * CLASSIC IS SACRED (Liquid Glass stage 4, admin lane). The shared radio
 * group is used across the whole app (the MFA policy and Order items access
 * pickers in this lane, Team, the customer portal's pricing mode, the
 * appearance menus), so its Classic DOM is pinned here in both looks, from
 * the code BEFORE Liquid Glass adds a hook to it: the row look with
 * descriptions, the radio-card look with a chosen card, a disabled group and
 * one disabled option. Normalised as the classic proof normalises a page
 * (src/test/classic-dom.ts): Liquid Glass may add only inert hook attributes;
 * with them stripped every state must render exactly the pinned DOM under the
 * `off` rollout and under `default`, with no Classic element moved among its
 * siblings. Fix the change, never the snapshot.
 */

const OPTIONS = [
  { value: 'role', label: 'Follow role default', description: 'What the role allows.' },
  { value: 'allow', label: 'Allow', description: 'Always, whatever the role.' },
  { value: 'deny', label: 'Deny' },
] as const;

function Group({
  variant,
  value,
  disabled,
  disabledItem,
}: {
  variant?: 'default' | 'card';
  value: string;
  disabled?: boolean;
  disabledItem?: string;
}) {
  return (
    <RadioGroup
      aria-label="Access"
      name="access"
      value={value}
      variant={variant}
      disabled={disabled}
      onValueChange={() => undefined}
      className="mt-2"
    >
      {OPTIONS.map((o) => (
        <RadioGroupItem
          key={o.value}
          value={o.value}
          label={o.label}
          description={'description' in o ? o.description : undefined}
          disabled={disabledItem === o.value}
          data-testid={`access-${o.value}`}
        />
      ))}
    </RadioGroup>
  );
}

const STATES: Array<{ name: string; ui: () => React.ReactElement }> = [
  { name: 'row', ui: () => <Group value="role" /> },
  { name: 'row-disabled-option', ui: () => <Group value="allow" disabledItem="deny" /> },
  { name: 'card', ui: () => <Group variant="card" value="allow" /> },
  { name: 'card-disabled-group', ui: () => <Group variant="card" value="deny" disabled /> },
];

afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

function renderUnder(rollout: 'off' | 'default', state: (typeof STATES)[number]) {
  cleanup();
  vi.stubEnv('NEXT_PUBLIC_LIQUID_GLASS', rollout);
  const { container } = render(state.ui());
  return {
    dom: classicDom(container),
    structure: classicStructure(container),
    glassOnly: glassOnlyCount(container),
  };
}

describe('RadioGroup: Classic DOM', () => {
  for (const state of STATES) {
    it(`${state.name}: the pinned Classic DOM under off and under default`, async () => {
      const off = renderUnder('off', state);
      expect(off.glassOnly).toBe(0);
      const glass = renderUnder('default', state);
      expect(glass.dom).toBe(off.dom);
      expect(glass.structure).toBe(off.structure);
      await expect(off.dom).toMatchFileSnapshot(`./__classic__/radio-group.${state.name}.txt`);
    });
  }
});
