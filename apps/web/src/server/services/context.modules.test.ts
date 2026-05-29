import { describe, expect, it } from 'vitest';
import { assertModuleEnabled, serviceErrorStatus, ServiceError, type ServiceContext } from './context';

const ctx = (mods: string[]): ServiceContext => ({
  organizationId: 'o', userId: 'u', role: 'admin',
  supabase: {} as never, mfaRequired: false, mfaSatisfied: true,
  enabledModules: new Set(mods as never),
});

describe('assertModuleEnabled', () => {
  it('passes when the module is enabled', () => {
    expect(() => assertModuleEnabled(ctx(['orders']), 'orders')).not.toThrow();
  });
  it('throws module_disabled when an optional module is off', () => {
    try { assertModuleEnabled(ctx([]), 'orders'); throw new Error('should have thrown'); }
    catch (e) { expect(e).toBeInstanceOf(ServiceError); expect((e as ServiceError).code).toBe('module_disabled'); }
  });
  it('treats a core module as enabled even if absent from the set', () => {
    expect(() => assertModuleEnabled(ctx([]), 'inventory')).not.toThrow();
  });
  it('serviceErrorStatus maps codes to HTTP', () => {
    expect(serviceErrorStatus('module_disabled')).toBe(403);
    expect(serviceErrorStatus('forbidden')).toBe(403);
    expect(serviceErrorStatus('not_found')).toBe(404);
    expect(serviceErrorStatus('validation_error')).toBe(400);
    expect(serviceErrorStatus('conflict')).toBe(409);
    expect(serviceErrorStatus('unauthenticated')).toBe(401);
    expect(serviceErrorStatus('internal_error')).toBe(500);
  });
});
