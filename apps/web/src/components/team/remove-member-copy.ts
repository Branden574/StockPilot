import type { MemberOpenWork } from '@/server/services/team';

/**
 * Words for Team's Remove dialog (B94). Removing a member releases their open
 * work in this workspace in the same step (migration 0429), so the dialog says
 * how much before the press, from TeamService.openWork: the cycle counts in
 * progress, orders being picked and open deliveries always (a 0 included),
 * and one more line only when they are the local owner of a maintenance
 * request or the manager of a warehouse. Escalation claims (two-minute
 * leases) and schedule events (they follow the deliveries) are released too
 * and never named. Pure, so the words are tested here (pattern #8).
 */
export const REMOVE_MEMBER_COPY = {
  description: (name: string): string =>
    `${name} will lose access to this workspace immediately. Their activity history stays on the record. You can re-invite them later. Work released now stays released.`,
  checking: 'Checking their open work...',
  failed: 'Could not check their open work. Removing them still releases it.',
  /** The read was refused; the removal answers the same (TeamService.removeMember). */
  forbidden: 'Only an owner or admin can remove a member.',
} as const;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The dialog's open-work lines: the counts sentence, then the extra line when there is one. */
export function openWorkLines(counts: MemberOpenWork, warehouseSingular: string): string[] {
  const lines: string[] = [];
  if (counts.cycleCounts + counts.picks + counts.deliveries === 0) {
    lines.push(
      'They have no cycle counts in progress, orders being picked or open deliveries to release.',
    );
  } else {
    lines.push(
      `Removing them releases ${plural(counts.cycleCounts, 'cycle count in progress', 'cycle counts in progress')}, ${plural(
        counts.picks,
        'order being picked',
        'orders being picked',
      )} and ${plural(counts.deliveries, 'open delivery', 'open deliveries')}, so others can take them over.`,
    );
  }
  const warehouse = warehouseSingular.toLowerCase();
  const also: string[] = [];
  if (counts.maintenanceRequests > 0) {
    also.push(
      `as the local owner of ${plural(counts.maintenanceRequests, 'maintenance request', 'maintenance requests')}`,
    );
  }
  if (counts.warehouses > 0) {
    also.push(`as the manager of ${plural(counts.warehouses, warehouse, `${warehouse}s`)}`);
  }
  if (also.length > 0) lines.push(`It also clears them ${also.join(' and ')}.`);
  return lines;
}
