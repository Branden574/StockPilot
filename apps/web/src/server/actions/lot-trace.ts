'use server';

import { err, ok, type ActionResult } from '@stockpilot/core';
import { LotsService, type LotTraceResult } from '@/server/services/lots';
import { actionErrorResult } from '@/server/lib/action-error-result';

export async function traceLotAction(lotNumber: string): Promise<ActionResult<LotTraceResult>> {
  if (!lotNumber?.trim()) return err('validation_error', 'Enter a lot number.');
  try {
    const svc = await LotsService.forCurrentUser();
    return ok(await svc.traceLot(lotNumber));
  } catch (e) {
    return actionErrorResult(e, 'actions.lot_trace.trace_lot');
  }
}
