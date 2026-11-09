'use client';

import { RefreshCw } from 'lucide-react';
import * as React from 'react';

import type { AppearanceStyle } from '@stockpilot/core';

import {
  appearanceStatusText,
  DESIGN_OPTIONS,
  THEME_OPTIONS,
  useAppearanceChoice,
} from '@/components/theme/appearance-select';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Settings > Profile > Appearance (plans/REVISION-DEFAULT.md R1, R13; brief
 * section 4): the same two choices as the menus
 * (components/theme/appearance-select.tsx), Design first.
 *
 *   Design  two preview tiles: Liquid Glass, Classic;
 *   Theme   three radios: Light, Dark, System.
 *
 * Native radio inputs in two fieldsets, each with its legend: Tab reaches a
 * group, the arrow keys move and choose, and each is announced as a radio with
 * its word (and, for a Design, its one-line description), checked or not.
 * Choosing applies at once, on this page, with no reload and no remount;
 * switching the Design never changes the Theme. Personal and ungated.
 *
 * The line below says where the choice is saved, and never claims the account
 * holds it unless the server said so; a failed save offers Try again (plan 3.4
 * rule 2). It says nothing until the session is known (the provider's status
 * is null on the server and while the page loads; L4 triage BF2), so a
 * signed-in person is never told "Saved on this device.", the line for a
 * person with no account. The profile page renders this only when the build
 * has Liquid Glass.
 *
 * Under Liquid Glass (Routes-Gallery-2's Appearance panel, sp.css .choice,
 * .rb and .seg) the chosen Design takes the accent border, the selection wash
 * and the accent radio, and Theme is a three-part segmented control. That is
 * glass CSS on the inert hooks below (data-glass appearance-choice,
 * appearance-seg, appearance-seg-item, radio-dot, with data-glass-state
 * on/off; styles/liquid-glass/primitives.css): Classic draws exactly what it
 * drew before.
 */

/** Decorative miniatures of each Design (aria-hidden): plain colours, no image request. */
const PREVIEW: Record<
  AppearanceStyle,
  { ground: string; side: string; card: string; line: string; accent: string; radius: number }
> = {
  'liquid-glass': {
    ground: 'linear-gradient(150deg, #dfe8e3 0%, #cfdcd5 45%, #e9dfd1 100%)',
    side: 'rgba(255,255,255,.58)',
    card: 'rgba(255,255,255,.46)',
    line: 'rgba(255,255,255,.78)',
    accent: '#0B7A5C',
    radius: 8,
  },
  classic: {
    ground: 'linear-gradient(135deg, #fafaf7 0 50%, #0c0d0a 50% 100%)',
    side: 'rgba(127,127,127,.18)',
    card: 'rgba(127,127,127,.22)',
    line: 'rgba(127,127,127,.4)',
    accent: 'hsl(165 42% 45%)',
    radius: 3,
  },
};

function DesignPreview({ style }: { style: AppearanceStyle }) {
  const p = PREVIEW[style];
  return (
    <div
      aria-hidden="true"
      className="relative flex h-[72px] w-full gap-1.5 overflow-hidden p-1.5"
      style={{ background: p.ground, borderRadius: p.radius + 4 }}
    >
      <div
        className="w-[22%] shrink-0"
        style={{
          background: p.side,
          borderRadius: p.radius,
          boxShadow: `inset 0 0 0 1px ${p.line}`,
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="h-1.5 w-1/2 rounded-full" style={{ background: p.accent }} />
        <div
          className="flex-1"
          style={{
            background: p.card,
            borderRadius: p.radius,
            boxShadow: `inset 0 0 0 1px ${p.line}`,
          }}
        />
      </div>
    </div>
  );
}

/** The dot of a radio drawn beside its word (the input itself is visually hidden). */
function RadioDot({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-glass="radio-dot"
      data-glass-state={checked ? 'on' : 'off'}
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-full border',
        checked ? 'border-foreground' : 'border-[var(--ed-line-strong)]',
      )}
    >
      {checked ? <span className="bg-foreground size-2 rounded-full" /> : null}
    </span>
  );
}

const OPTION =
  'bg-card relative flex min-h-11 cursor-pointer rounded-md border transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background';
const LEGEND = 'text-foreground mb-2 text-[12.5px] font-medium';

export function AppearancePanel() {
  const { style, theme, chooseStyle, chooseTheme, status, retry } = useAppearanceChoice();
  const name = React.useId();
  const statusText = appearanceStatusText(status);

  return (
    <div className="flex flex-col gap-4">
      <fieldset>
        <legend className={LEGEND}>Design</legend>
        <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2">
          {DESIGN_OPTIONS.map((option) => {
            const checked = style === option.value;
            const labelId = `${name}-design-${option.value}-label`;
            const descriptionId = `${name}-design-${option.value}-description`;
            return (
              <label
                key={option.value}
                data-glass="appearance-choice"
                data-glass-state={checked ? 'on' : 'off'}
                className={cn(
                  OPTION,
                  'flex-col gap-2 p-2',
                  checked
                    ? 'border-foreground'
                    : 'border-border hover:border-[var(--ed-line-strong)]',
                )}
              >
                <input
                  type="radio"
                  name={`${name}-design`}
                  value={option.value}
                  checked={checked}
                  onChange={() => chooseStyle(option.value)}
                  // The word alone is the name; the one line is the description.
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                  className="sr-only"
                />
                <DesignPreview style={option.value} />
                <span className="flex items-center gap-2 px-0.5">
                  <RadioDot checked={checked} />
                  <span id={labelId} className="text-foreground text-[13.5px] font-medium">
                    {option.label}
                  </span>
                </span>
                <span
                  id={descriptionId}
                  className="text-muted-foreground px-0.5 text-[12.5px] leading-[18px]"
                >
                  {option.description}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <fieldset>
        <legend className={LEGEND}>Theme</legend>
        <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-3" data-glass="appearance-seg">
          {THEME_OPTIONS.map((option) => {
            const checked = theme === option.value;
            return (
              <label
                key={option.value}
                data-glass="appearance-seg-item"
                data-glass-state={checked ? 'on' : 'off'}
                className={cn(
                  OPTION,
                  'items-center gap-2 px-3 py-2',
                  checked
                    ? 'border-foreground'
                    : 'border-border hover:border-[var(--ed-line-strong)]',
                )}
              >
                <input
                  type="radio"
                  name={`${name}-theme`}
                  value={option.value}
                  checked={checked}
                  onChange={() => chooseTheme(option.value)}
                  className="sr-only"
                />
                <RadioDot checked={checked} />
                <span className="text-foreground text-[13.5px] font-medium">{option.label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div
        aria-live="polite"
        className="text-muted-foreground flex min-h-8 flex-wrap items-center gap-2 text-[12.5px]"
      >
        {statusText ? <span>{statusText}</span> : null}
        {status === 'failed' && retry ? (
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            <RefreshCw aria-hidden /> Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}
