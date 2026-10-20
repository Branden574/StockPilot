'use client';

import { SegmentedTabs } from '@/components/patterns/segmented-tabs';

/**
 * Tiny segmented toggle shared by the analytics chart widgets, drawn by the
 * shared SegmentedTabs at the range toggle's size (`xs`, DESIGN-SPEC 4 and
 * 6.5: a 28 px track with no fill, 22 px chips, the chosen one on the hover
 * fill with no ring; FX7). Same semantics as before: a named `role="group"`
 * of real `<button>`s that carry `aria-pressed`, every one in the Tab order.
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
    <SegmentedTabs
      semantics="nav"
      size="xs"
      aria-label={ariaLabel}
      activeId={value}
      onSelect={(id) => onChange(id)}
      items={options.map((opt) => ({ id: opt.value, label: opt.label }))}
    />
  );
}
