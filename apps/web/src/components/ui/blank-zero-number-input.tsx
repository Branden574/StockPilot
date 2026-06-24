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
  // Hold the RAW text the user is typing. Deriving the displayed value purely
  // from Number(value) silently strips the decimal point and trailing/leading
  // zeros — String(Number("16.50")) === "16.5", String(Number("10.")) === "10"
  // — which makes "0", "0.50", a decimal point, and trailing zeros impossible
  // to type (the characters vanish as you enter them). We keep the text as the
  // source of truth for the field and only emit the parsed number upward.
  const toText = React.useCallback(
    (v: number | null | undefined) =>
      v === 0 || v === null || v === undefined ? '' : String(v),
    [],
  );
  const [text, setText] = React.useState<string>(() => toText(value));

  // Resync when the external value changes to something the current text
  // doesn't already represent (form reset, prefill, programmatic set). Never
  // clobber an in-progress entry that already parses to the same number — e.g.
  // typing "16.50" emits 16.5, which round-trips back as a value of 16.5; we
  // must keep showing "16.50", not snap it to "16.5".
  React.useEffect(() => {
    const currentNum = text.trim() === '' ? 0 : Number(text);
    const sameNumber = Number.isFinite(currentNum) && currentNum === (value ?? 0);
    if (!sameNumber) setText(toText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resync on the external value only
  }, [value]);

  return (
    <Input
      {...rest}
      type="number"
      // Fractional step ⇒ a decimal entry is expected, so offer the decimal
      // keypad (which includes "."); whole-number fields keep the numeric pad.
      inputMode={Number(rest.step) > 0 && Number(rest.step) < 1 ? 'decimal' : 'numeric'}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw); // keep the raw text so partial entries like "0.", "10." survive
        const n = raw.trim() === '' ? 0 : Number(raw);
        onValueChange(Number.isFinite(n) ? n : 0);
      }}
    />
  );
}
