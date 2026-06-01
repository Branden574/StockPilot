'use client';

import { cn } from '@/lib/utils';

/**
 * Tiny segmented toggle shared by the analytics chart widgets. Local to the
 * charts dir so the widgets stay self-contained (the repo has no shared
 * toggle/tabs primitive yet). Keyboard + a11y friendly via real <button>s.
 * Renders nothing when there are fewer than two options.
 */
export function ToggleGroup({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
}: {
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
  'aria-label': string;
}) {
  if (options.length < 2) return null;
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="border-border bg-background inline-flex items-center rounded-md border p-0.5"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              'rounded-[5px] px-2 py-0.5 text-[11.5px] font-medium transition-colors',
              active
                ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(14,15,13,0.08)]'
                : 'text-[var(--ed-ink-3)] hover:text-foreground',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
