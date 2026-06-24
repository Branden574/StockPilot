import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { BlankZeroNumberInput } from './blank-zero-number-input';

/** Controlled harness mirroring how the item form drives the input. */
function Harness({
  initial = 0,
  step,
  onNum,
}: {
  initial?: number;
  step?: number;
  onNum?: (n: number) => void;
}) {
  const [v, setV] = React.useState<number>(initial);
  return (
    <BlankZeroNumberInput
      value={v}
      step={step}
      onValueChange={(n) => {
        setV(n);
        onNum?.(n);
      }}
    />
  );
}

describe('BlankZeroNumberInput', () => {
  it('renders blank (not "0") when the value is zero', () => {
    render(<Harness initial={0} />);
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('');
  });

  it('shows a real non-zero value', () => {
    render(<Harness initial={16.5} />);
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('16.5');
  });

  it('keeps a trailing-zero decimal the user typed (regression: "16.50" was snapping to "16.5")', () => {
    const onNum = vi.fn();
    render(<Harness initial={16.5} onNum={onNum} step={0.01} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '16.50' } });
    expect(input.value).toBe('16.50'); // the trailing zero survives
    expect(onNum).toHaveBeenLastCalledWith(16.5); // and the parsed number is emitted
  });

  it('lets you enter a leading-zero decimal like "0.50"', () => {
    const onNum = vi.fn();
    render(<Harness initial={0} onNum={onNum} step={0.01} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.50' } });
    expect(input.value).toBe('0.50');
    expect(onNum).toHaveBeenLastCalledWith(0.5);
  });

  it('preserves interior/trailing zeros in whole numbers ("10.05", "100")', () => {
    const onNum = vi.fn();
    render(<Harness initial={0} onNum={onNum} step={0.01} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '10.05' } });
    expect(input.value).toBe('10.05');
    expect(onNum).toHaveBeenLastCalledWith(10.05);
  });

  it('clearing the field emits 0 and shows blank', () => {
    const onNum = vi.fn();
    render(<Harness initial={5} onNum={onNum} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(onNum).toHaveBeenLastCalledWith(0);
    expect(input.value).toBe('');
  });

  it('uses the decimal keypad for fractional-step (price) fields', () => {
    render(<Harness step={0.01} />);
    expect(screen.getByRole('spinbutton')).toHaveAttribute('inputmode', 'decimal');
  });

  it('uses the numeric keypad for whole-number (qty) fields', () => {
    render(<Harness step={1} />);
    expect(screen.getByRole('spinbutton')).toHaveAttribute('inputmode', 'numeric');
  });
});
