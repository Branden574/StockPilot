'use client';

import { RefreshCw } from 'lucide-react';
import * as React from 'react';

import type { AppearanceMode } from '@stockpilot/core';

import { appearanceStatusText, useAppearanceChoice } from '@/components/theme/appearance-select';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Settings > Profile > Appearance (Liquid Glass plan 3.4 and 5.4's web twin;
 * brief section 4): the same choices as the account menu and the header menu
 * (components/theme/appearance-select.tsx), as preview tiles so the
 * difference is obvious before choosing.
 *
 * Native radio inputs, one group: Tab reaches the group, the arrow keys move
 * and choose, and each is announced as a radio with its word and its one-line
 * description (never an icon alone), checked or not. Choosing applies at once,
 * on this page, with no reload and no remount. Personal and ungated: every
 * signed-in person can change their own, and it changes nobody else's.
 *
 * The line below the tiles says where the choice is saved, and never claims
 * the account holds it unless the server said so; a failed save offers Try
 * again (plan 3.4 rule 2).
 */

/** Decorative miniatures of each look (aria-hidden): plain colours, no image request. */
const PREVIEW: Record<
  AppearanceMode,
  { ground: string; side: string; card: string; line: string; accent: string }
> = {
  dark: {
    ground: '#0c0d0a',
    side: '#131410',
    card: '#131410',
    line: '#2a2b25',
    accent: 'hsl(165 45% 64%)',
  },
  light: {
    ground: '#fafaf7',
    side: '#ffffff',
    card: '#ffffff',
    line: '#e7e5dd',
    accent: 'hsl(165 42% 32%)',
  },
  'liquid-glass': {
    ground: 'linear-gradient(150deg, #dfe8e3 0%, #cfdcd5 45%, #e9dfd1 100%)',
    side: 'rgba(255,255,255,.58)',
    card: 'rgba(255,255,255,.46)',
    line: 'rgba(255,255,255,.78)',
    accent: '#0B7A5C',
  },
  system: {
    ground: 'linear-gradient(135deg, #fafaf7 0 50%, #0c0d0a 50% 100%)',
    side: 'rgba(127,127,127,.18)',
    card: 'rgba(127,127,127,.22)',
    line: 'rgba(127,127,127,.4)',
    accent: 'hsl(165 42% 45%)',
  },
};

function AppearancePreview({ mode }: { mode: AppearanceMode }) {
  const p = PREVIEW[mode];
  const glass = mode === 'liquid-glass';
  return (
    <div
      aria-hidden="true"
      className="relative flex h-[72px] w-full gap-1.5 overflow-hidden p-1.5"
      style={{ background: p.ground, borderRadius: glass ? 12 : 6 }}
    >
      <div
        className="w-[22%] shrink-0"
        style={{
          background: p.side,
          borderRadius: glass ? 8 : 3,
          boxShadow: `inset 0 0 0 1px ${p.line}`,
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="h-1.5 w-1/2 rounded-full" style={{ background: p.accent }} />
        <div
          className="flex-1"
          style={{
            background: p.card,
            borderRadius: glass ? 8 : 3,
            boxShadow: `inset 0 0 0 1px ${p.line}`,
          }}
        />
      </div>
    </div>
  );
}

export function AppearancePanel({ labelledBy }: { labelledBy: string }) {
  const { value, options, choose, status, retry } = useAppearanceChoice();
  const name = React.useId();
  const statusText = appearanceStatusText(status);

  return (
    <div className="flex flex-col gap-3">
      <div
        role="radiogroup"
        aria-labelledby={labelledBy}
        className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 lg:grid-cols-4"
      >
        {options.map((option) => {
          const checked = value === option.mode;
          const labelId = `${name}-${option.mode}-label`;
          const descriptionId = `${name}-${option.mode}-description`;
          return (
            <label
              key={option.mode}
              className={cn(
                'bg-card relative flex min-h-11 cursor-pointer flex-col gap-2 rounded-md border p-2 transition-colors',
                'has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-background has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-offset-2',
                checked
                  ? 'border-foreground'
                  : 'border-border hover:border-[var(--ed-line-strong)]',
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.mode}
                checked={checked}
                onChange={() => choose(option.mode)}
                // The word alone is the name; the one line is the description
                // (the whole label would read both as the name).
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                className="sr-only"
              />
              <AppearancePreview mode={option.mode} />
              <span className="flex items-center gap-2 px-0.5">
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded-full border',
                    checked ? 'border-foreground' : 'border-[var(--ed-line-strong)]',
                  )}
                >
                  {checked ? <span className="bg-foreground size-2 rounded-full" /> : null}
                </span>
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
