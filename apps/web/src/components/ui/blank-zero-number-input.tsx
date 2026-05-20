'use client';

import * as React from 'react';

import { Input } from '@/components/ui/input';

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  /** Numeric value. `0` (or `null`/`undefined`) renders as a blank field
   *  so the user doesn't have to backspace the placeholder zero before
   *  typing. Real non-zero values render normally. */
  value: number | null | undefined;
  /** Called with the parsed numeric value. Empty string → 0. */
  onValueChange: (n: number) => void;
  placeholder?: string;
};

/**
 * Number input that DOESN'T show a leading "0" when the underlying
 * value is zero. Background:
 *   • Default qty fields render "0" → user types "30" → cursor is at
 *     the head of the existing zero, so the browser fills "030".
 *   • Users hate having to delete the placeholder zero before every
 *     entry — common enough across the app that we centralized the
 *     fix here.
 *
 * Usage:
 *   <BlankZeroNumberInput value={qty} onValueChange={setQty} min={0} step={1} />
 *
 * For react-hook-form fields, wrap with <Controller> and forward field.value
 * / field.onChange to the component.
 */
export function BlankZeroNumberInput({
  value,
  onValueChange,
  placeholder = '0',
  ...rest
}: Props) {
  const displayValue =
    value === 0 || value === null || value === undefined ? '' : String(value);
  return (
    <Input
      {...rest}
      type="number"
      inputMode="numeric"
      value={displayValue}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') {
          onValueChange(0);
          return;
        }
        const n = Number(raw);
        if (Number.isFinite(n)) onValueChange(n);
      }}
    />
  );
}
