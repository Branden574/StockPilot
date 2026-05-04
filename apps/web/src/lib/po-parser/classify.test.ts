import { describe, expect, it } from 'vitest';
import { classifyLine } from './classify';

describe('classifyLine', () => {
  it('classifies plain TAX line as tax', () => {
    expect(classifyLine('TAX')).toBe('tax');
  });

  it('classifies sales-tax description as tax', () => {
    expect(classifyLine('Sales Tax 8.25%')).toBe('tax');
  });

  it('classifies freight as freight', () => {
    expect(classifyLine('Freight charge')).toBe('freight');
    expect(classifyLine('Shipping')).toBe('freight');
  });

  it('classifies handling/processing fees as fee', () => {
    expect(classifyLine('Handling fee')).toBe('fee');
    expect(classifyLine('Processing surcharge')).toBe('fee');
  });

  it('classifies service / installation / warranty as service', () => {
    expect(classifyLine('Installation labor')).toBe('service');
    expect(classifyLine('Extended warranty')).toBe('service');
  });

  it('classifies discount/credit as discount', () => {
    expect(classifyLine('-50.00 discount')).toBe('discount');
    expect(classifyLine('Volume credit')).toBe('discount');
  });

  it('classifies a real product description as inventory', () => {
    expect(classifyLine('Duracell Coppertop AA Alkaline Batteries, 24/Pack')).toBe(
      'inventory',
    );
    expect(classifyLine('Logitech M330 Silent Plus Wireless Mouse')).toBe('inventory');
  });

  it('classifies empty / null / unknown garbage as unknown', () => {
    expect(classifyLine('')).toBe('unknown');
    expect(classifyLine(null)).toBe('unknown');
    expect(classifyLine('???')).toBe('unknown');
  });

  it('treats negative amounts with no other signal as discount', () => {
    expect(classifyLine('Adjustment', { signedAmount: -10 })).toBe('discount');
  });
});
