import { GetStartedChecklist } from '@/components/dashboard/get-started-checklist';

import type { DashboardWidgetProps } from './types';

/**
 * Day-zero guidance. Only rendered while the checklist is incomplete — once
 * every step is done it returns null so the dashboard reads as "established"
 * (matches the prior `{!checklistComplete && ...}` gate, kept INSIDE the
 * widget so resolved-order rendering doesn't change behavior).
 */
export function GetStartedWidget({ checklistSteps, checklistComplete }: DashboardWidgetProps) {
  if (checklistComplete) return null;
  return (
    <div className="mb-5">
      <GetStartedChecklist steps={checklistSteps} />
    </div>
  );
}
