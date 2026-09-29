'use client';

import { BookOpen, LifeBuoy, LogOut, Monitor, Moon, Settings, ShieldAlert, Sun, User } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { reset as resetAnalytics } from '@/lib/analytics';
import { forgetTourState } from '@/lib/onboarding/tour-state-cache';
import { signOutAction } from '@/server/actions/auth';

interface UserMenuProps {
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  organizationName: string;
  /** True only for platform super-admins — gates the Platform console link. */
  isPlatformAdmin?: boolean;
}

export function UserMenu({
  email,
  fullName,
  avatarUrl,
  organizationName,
  isPlatformAdmin,
}: UserMenuProps) {
  const router = useRouter();
  const { setTheme } = useTheme();
  const initials = (fullName || email || 'U')
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          id="user-menu-trigger"
          variant="ghost"
          size="icon"
          aria-label={`Account menu for ${fullName ?? email}`}
          className="shrink-0 rounded-full ring-offset-background hover:ring-2 hover:ring-border focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Avatar className="h-8 w-8">
            {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 p-0">
        <DropdownMenuLabel className="border-border bg-muted/40 flex items-center gap-3 border-b px-3 py-3">
          <Avatar className="h-10 w-10 shrink-0">
            {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">
              {fullName ?? email}
            </div>
            <div className="text-muted-foreground truncate text-[11px]">
              {email}
            </div>
            <div className="text-muted-foreground mt-0.5 truncate text-[11px]">
              {organizationName}
            </div>
          </div>
        </DropdownMenuLabel>
        <div className="p-1">
          <DropdownMenuItem asChild>
            <Link href="/dashboard/settings/profile">
              <User className="mr-2 h-4 w-4" />
              Profile
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/settings">
              <Settings className="mr-2 h-4 w-4" />
              Settings
            </Link>
          </DropdownMenuItem>
          {/* Help, Support and the theme are also top-bar buttons, but a
              narrow top bar leaves those out (topbar.tsx), so they are here
              at every width. */}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/dashboard/help">
              <BookOpen className="mr-2 h-4 w-4" />
              Help & Learning
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/support">
              <LifeBuoy className="mr-2 h-4 w-4" />
              Support & feedback
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setTheme('light')}>
            <Sun className="mr-2 h-4 w-4" />
            Light
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setTheme('dark')}>
            <Moon className="mr-2 h-4 w-4" />
            Dark
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setTheme('system')}>
            <Monitor className="mr-2 h-4 w-4" />
            System
          </DropdownMenuItem>
          {isPlatformAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/platform">
                  <ShieldAlert className="mr-2 h-4 w-4" />
                  Platform admin
                </Link>
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={async () => {
              // Clear the PostHog identity before tearing down the session.
              // No-op when analytics is unconfigured.
              resetAnalytics();
              // And this person's tour state, kept for the browser session
              // (sign-out is a soft navigation, so module state survives it).
              forgetTourState();
              await signOutAction();
              router.refresh();
            }}
          >
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
