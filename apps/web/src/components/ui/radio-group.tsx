'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * The shared single choice: native radio inputs under one name, so the browser
 * gives the group its keyboard behaviour (Tab reaches the chosen option, the
 * arrow keys move and choose) and a form posts the value, with no ARIA to keep
 * in step. The wrapper is role="radiogroup" and takes the group's name through
 * aria-label or aria-labelledby.
 *
 * Two looks:
 * - `default`: a row with the dot, the label and an optional description.
 * - `card`: each option is a bordered card (the export format and MFA policy
 *   pickers); the chosen card takes an ink edge, and the card shows the
 *   keyboard focus ring.
 *
 * Each option's name is its `label`; the `description` is announced as its
 * description, not as part of the name.
 */
type Variant = 'default' | 'card';

interface RadioGroupContextValue {
  name: string;
  value: string | undefined;
  select: (value: string) => void;
  disabled: boolean;
  variant: Variant;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(null);

export interface RadioGroupProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'onChange' | 'defaultValue' | 'role'
> {
  /** The chosen value (controlled). */
  value?: string;
  /** The first chosen value when the group keeps its own state. */
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** The inputs' shared name (a form posts it). Defaults to a unique id. */
  name?: string;
  disabled?: boolean;
  variant?: Variant;
}

export const RadioGroup = React.forwardRef<HTMLDivElement, RadioGroupProps>(function RadioGroup(
  {
    value: valueProp,
    defaultValue,
    onValueChange,
    name: nameProp,
    disabled = false,
    variant = 'default',
    className,
    children,
    ...props
  },
  ref,
) {
  const autoName = React.useId();
  const [own, setOwn] = React.useState(defaultValue);
  const controlled = valueProp !== undefined;
  const value = controlled ? valueProp : own;
  const select = React.useCallback(
    (next: string) => {
      if (!controlled) setOwn(next);
      onValueChange?.(next);
    },
    [controlled, onValueChange],
  );
  const context = React.useMemo<RadioGroupContextValue>(
    () => ({ name: nameProp ?? autoName, value, select, disabled, variant }),
    [nameProp, autoName, value, select, disabled, variant],
  );

  return (
    <RadioGroupContext.Provider value={context}>
      <div
        {...props}
        ref={ref}
        role="radiogroup"
        aria-disabled={disabled || undefined}
        className={cn(variant === 'card' ? 'grid gap-2' : 'grid gap-1', className)}
      >
        {children}
      </div>
    </RadioGroupContext.Provider>
  );
});
RadioGroup.displayName = 'RadioGroup';

export interface RadioGroupItemProps {
  value: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  /** Hook for tests and tours, put on the input. */
  'data-testid'?: string;
}

export const RadioGroupItem = React.forwardRef<HTMLInputElement, RadioGroupItemProps>(
  function RadioGroupItem(
    { value, label, description, disabled: itemDisabled = false, className, 'data-testid': testId },
    ref,
  ) {
    const group = React.useContext(RadioGroupContext);
    const id = React.useId();
    if (!group) throw new Error('RadioGroupItem must be inside a RadioGroup');
    const labelId = `${id}-label`;
    const descriptionId = `${id}-description`;
    const checked = group.value === value;
    const disabled = group.disabled || itemDisabled;
    const card = group.variant === 'card';

    return (
      <label
        className={cn(
          'flex items-start gap-2.5',
          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
          card &&
            'bg-card has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-background rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-offset-2',
          card &&
            (checked
              ? 'border-foreground shadow-[0_0_0_1px_hsl(var(--foreground))]'
              : 'border-border hover:border-[var(--ed-line-strong)]'),
          !card && 'py-1',
          className,
        )}
      >
        <input
          ref={ref}
          type="radio"
          name={group.name}
          value={value}
          checked={checked}
          disabled={disabled}
          onChange={() => group.select(value)}
          aria-labelledby={labelId}
          aria-describedby={description ? descriptionId : undefined}
          data-testid={testId}
          className={cn(
            // The dot: a ring that fills with an ink centre when chosen.
            // The empty ring is the faint ink (3:1 against the card in both
            // themes), like the empty checkbox.
            'bg-card mt-px size-4 shrink-0 appearance-none rounded-full border border-[var(--ed-ink-4)] transition-colors',
            'checked:border-foreground checked:bg-foreground checked:shadow-[inset_0_0_0_3px_hsl(var(--card))]',
            'disabled:cursor-not-allowed',
            card
              ? 'focus-visible:outline-none'
              : 'focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
          )}
        />
        <span className="min-w-0">
          <span id={labelId} className="block text-[13px] font-medium leading-[18px]">
            {label}
          </span>
          {description ? (
            <span
              id={descriptionId}
              className="text-muted-foreground mt-0.5 block text-[12.5px] leading-[18px]"
            >
              {description}
            </span>
          ) : null}
        </span>
      </label>
    );
  },
);
RadioGroupItem.displayName = 'RadioGroupItem';
