'use client';

import { BookOpen, LifeBuoy, LogOut, Settings, ShieldAlert, User } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';

import type { Density } from '@/components/dashboard/sidebar-pref';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
  /**
   * The viewer's table density and its setter. The shell passes both; the
   * Density choice is shown only when it can be changed.
   */
  density?: Density;
  onDensityChange?: (density: Density) => void;
}

/** Group labels inside the menu: the same quiet uppercase as the sidebar's. */
const GROUP_LABEL =
  'text-muted-foreground px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.06em]';

export function UserMenu({
  email,
  fullName,
  avatarUrl,
  organizationName,
  isPlatformAdmin,
  density,
  onDensityChange,
}: UserMenuProps) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
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
          className="ring-offset-background hover:ring-border focus-visible:ring-ring ml-1 size-8 shrink-0 rounded-full p-0 hover:bg-transparent hover:ring-2 focus-visible:ring-2 [@media(pointer:coarse)]:size-11"
        >
          <Avatar className="size-7">
            {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
            <AvatarFallback className="bg-sunk text-foreground border border-[var(--ed-line-strong)] text-[11px] font-semibold">
              {initials}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      {/* Never taller than the room below the button (Radix measures it), and
          scrolls inside: held sideways a phone has about 330-370px of page,
          less than this menu, and the page behind it is locked while it is
          open, so without this Sign out could not be reached. */}
      <DropdownMenuContent
        align="end"
        className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-64 overflow-y-auto p-0"
      >
        <DropdownMenuLabel className="border-border bg-sunk flex items-center gap-3 border-b px-3 py-3 text-[13px] font-normal normal-case tracking-normal">
          <Avatar className="size-10 shrink-0">
            {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
            <AvatarFallback className="bg-card text-foreground border border-[var(--ed-line-strong)] text-[13px] font-semibold">
              {initials}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="text-foreground truncate text-[13.5px] font-medium">
              {fullName ?? email}
            </div>
            <div className="text-muted-foreground truncate text-[12px]">{email}</div>
            <div className="text-muted-foreground mt-0.5 truncate text-[12px]">
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
          <DropdownMenuLabel className={GROUP_LABEL}>Theme</DropdownMenuLabel>
          {/* One choice of three: the one in use is marked with a dot in the
              icon column (announced as checked); pl-10 lines the names up
              with the items above (icon 16 + its margin + the item's gap). */}
          <DropdownMenuRadioGroup aria-label="Theme" value={theme} onValueChange={setTheme}>
            <DropdownMenuRadioItem value="light" className="pl-10">
              Light
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark" className="pl-10">
              Dark
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system" className="pl-10">
              System
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          {density && onDensityChange ? (
            <>
              <DropdownMenuLabel className={GROUP_LABEL}>Density</DropdownMenuLabel>
              {/* Table rows only: Compact trims their padding, never text,
                  checkboxes or touch targets, and phones keep Comfortable. */}
              <DropdownMenuRadioGroup
                aria-label="Density"
                value={density}
                onValueChange={(value) =>
                  onDensityChange(value === 'compact' ? 'compact' : 'comfortable')
                }
              >
                <DropdownMenuRadioItem value="comfortable" className="pl-10">
                  Comfortable
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="compact" className="pl-10">
                  Compact
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </>
          ) : null}
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
