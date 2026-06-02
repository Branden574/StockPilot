'use server';

import { err, ok, type ActionResult } from '@stockpilot/core';
import { LotsService, type LotTraceResult } from '@/server/services/lots';
import { ServiceError } from '@/server/services/context';

export async function traceLotAction(lotNumber: string): Promise<ActionResult<LotTraceResult>> {
  if (!lotNumber?.trim()) return err('validation_error', 'Enter a lot number.');
  try {
    const svc = await LotsService.forCurrentUser();
    return ok(await svc.traceLot(lotNumber));
  } catch (e) {
    if (e instanceof ServiceError) return err(e.code, e.message);
    return err('internal_error', e instanceof Error ? e.message : 'Unknown error');
  }
}
