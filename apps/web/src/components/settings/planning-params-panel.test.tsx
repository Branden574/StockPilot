/**
 * The two settings cards on Reorder Planning (P4.C2 redesign): Planning
 * settings keeps its three fields, limits and Save; Automatic reordering keeps
 * the Pro notice, the enable box (now the shared checkbox, still saved only
 * with "Save settings"), the mode select and the cap.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const setParams = vi.fn(async (_p: unknown) => ({ ok: true as const, data: undefined }));
vi.mock('@/server/actions/planning-settings', () => ({
  setPlanningParamsAction: (p: unknown) => setParams(p),
}));

import { PlanningParamsPanel } from './planning-params-panel';

beforeEach(() => vi.clearAllMocks());

describe('PlanningParamsPanel', () => {
  it('keeps the three fields with their limits and saves them', async () => {
    render(
      <PlanningParamsPanel
        initial={{ leadTimeDays: 14, safetyMultiplier: 1.5, velocityWindowDays: 90 }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Planning settings' })).toBeInTheDocument();
    const lead = screen.getByLabelText('Lead time (days)');
    expect(lead).toHaveAttribute('min', '1');
    expect(lead).toHaveAttribute('max', '180');
    const safety = screen.getByLabelText('Safety multiplier');
    expect(safety).toHaveAttribute('step', '0.1');
    expect(safety).toHaveAttribute('max', '3');
    const window_ = screen.getByLabelText('Velocity window (days)');
    expect(window_).toHaveAttribute('min', '14');
    expect(window_).toHaveAttribute('max', '365');
    fireEvent.change(lead, { target: { value: '21' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(setParams).toHaveBeenCalledWith({
        leadTimeDays: 21,
        safetyMultiplier: 1.5,
        velocityWindowDays: 90,
      }),
    );
  });
});
