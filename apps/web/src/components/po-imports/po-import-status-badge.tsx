import type { PoImportStatus } from '@stockpilot/core';

const COLORS: Record<PoImportStatus, string> = {
  uploaded: 'bg-muted text-muted-foreground',
  parsing: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  parsed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  needs_review:
    'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  approved:
    'bg-emerald-200 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  failed: 'bg-destructive/15 text-destructive',
  duplicate: 'bg-muted text-muted-foreground',
  canceled: 'bg-muted text-muted-foreground',
};

export function PoImportStatusBadge({ status }: { status: PoImportStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] ${COLORS[status]}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}
