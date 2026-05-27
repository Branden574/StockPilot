import { useRouter } from 'expo-router';
import {
  ArrowLeftRight,
  BarChart3,
  Building2,
  FileLock,
  Layers,
  MapPin,
  Network,
  Users,
  Warehouse,
  type LucideIcon,
} from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { DataListScreen } from '@/components/data-list-screen';
import { Body, Mono } from '@/components/ui/text';
import { useRole } from '@/lib/use-role';
import { FONT } from '@/lib/theme';
import { useTheme } from '@/lib/use-theme';

interface AdminLink {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

const LINKS: AdminLink[] = [
  { href: '/admin/charters', label: 'Charters', icon: Building2, description: 'Internal cost centers and reporting buckets.' },
  { href: '/admin/warehouses', label: 'Warehouses', icon: Warehouse, description: 'Physical sites with their own inventory.' },
  { href: '/admin/bins', label: 'Bins', icon: MapPin, description: 'Bin codes used for putaway and pick paths.' },
  { href: '/admin/users', label: 'Users', icon: Users, description: 'Every org member with role and last seen.' },
  { href: '/admin/vendor-mappings', label: 'Vendor mappings', icon: Layers, description: 'Map external supplier codes to our suppliers.' },
  { href: '/admin/uom-conversions', label: 'UoM conversions', icon: ArrowLeftRight, description: 'Cases-to-each, dozens-to-each rules.' },
  { href: '/admin/reconciliation', label: 'Reconciliation', icon: BarChart3, description: 'Variance reports across cycle counts.' },
  { href: '/admin/audit', label: 'Audit log', icon: FileLock, description: 'Every privileged action with actor and time.' },
];

export default function AdminOverview() {
  const router = useRouter();
  const { isAdmin, loading } = useRole();

  if (loading) {
    return (
      <DataListScreen
        eyebrow="ADMIN"
        title="Loading"
        emptyTitle="Checking access…"
        emptyBody=""
        data={[]}
        loading
        keyExtractor={() => ''}
        renderItem={() => <View />}
      />
    );
  }

  if (!isAdmin) {
    return (
      <DataListScreen
        eyebrow="ADMIN"
        title="Restricted"
        italic="access."
        emptyIcon={Network}
        emptyTitle="Admin only."
        emptyBody="The admin surfaces are gated to owners and admins. Ask your org owner to upgrade your role if you need access."
        data={[]}
        loading={false}
        keyExtractor={() => ''}
        renderItem={() => <View />}
      />
    );
  }

  return (
    <DataListScreen
      eyebrow="ADMIN OVERVIEW"
      title="System"
      italic="settings."
      emptyTitle=""
      emptyBody=""
      data={LINKS}
      loading={false}
      keyExtractor={(l) => l.href}
      renderItem={(l) => (
        <Pressable
          onPress={() => router.push(l.href as never)}
          style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
        >
          <Card padding={14}>
            <AdminRow link={l} />
          </Card>
        </Pressable>
      )}
    />
  );
}

function AdminRow({ link }: { link: AdminLink }) {
  const { c } = useTheme();
  const Icon = link.icon;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: c.hair,
          backgroundColor: c.card,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon size={18} color={c.ink} strokeWidth={1.5} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Body size={15} color={c.ink} style={{ fontFamily: FONT.display }}>
          {link.label}
        </Body>
        <Mono size={11} tracking={0.04} color={c.ink4} style={{ marginTop: 3 }}>
          {link.description}
        </Mono>
      </View>
    </View>
  );
}
