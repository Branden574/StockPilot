import { Badge } from '@/components/ui/badge';

import type { Role } from '@stockpilot/core';

const STYLE: Record<Role, { variant: 'default' | 'secondary' | 'outline'; label: string }> = {
  owner: { variant: 'default', label: 'Owner' },
  admin: { variant: 'default', label: 'Admin' },
  manager: { variant: 'secondary', label: 'Manager' },
  staff: { variant: 'secondary', label: 'Staff' },
  viewer: { variant: 'outline', label: 'Viewer' },
};

export function RoleBadge({ role }: { role: Role }) {
  const cfg = STYLE[role];
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
}
