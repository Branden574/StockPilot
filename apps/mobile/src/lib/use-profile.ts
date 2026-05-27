import { type User } from '@supabase/supabase-js';
import * as React from 'react';

import { useAuth } from './auth-context';
import { supabase } from './supabase';

export interface Profile {
  fullName: string | null;
  avatarUrl: string | null;
  email: string | null;
  /** Two-letter initials derived from full name or email. Always uppercase. */
  initials: string;
}

function initialsFor(name: string | null | undefined, email: string | null | undefined): string {
  const source = (name && name.trim()) || (email ? email.split('@')[0] : '');
  if (!source) return '··';
  return source
    .split(/[\s._-]+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

const cache = new Map<string, Profile>();

/**
 * Fetches the user's profile (full name + avatar URL) from
 * `user_profiles` and keeps it in a small in-memory cache keyed by user
 * id. Used by Home's top-left chip, the drawer's profile footer, the
 * Settings identity card, and the biometric lock screen — so a single
 * fetch on first mount serves every consumer for the session.
 *
 * Avatar URLs come from the `user-avatars` public storage bucket and
 * already resolve to a CDN-cached image; no signing needed.
 */
export function useProfile(): Profile {
  const { user } = useAuth();
  const [profile, setProfile] = React.useState<Profile>(() => ({
    fullName: (user?.user_metadata?.full_name as string | undefined) ?? null,
    avatarUrl: null,
    email: user?.email ?? null,
    initials: initialsFor(
      (user?.user_metadata?.full_name as string | undefined) ?? null,
      user?.email ?? null,
    ),
  }));

  React.useEffect(() => {
    if (!user) {
      setProfile({ fullName: null, avatarUrl: null, email: null, initials: '··' });
      return;
    }
    const cached = cache.get(user.id);
    if (cached) {
      setProfile(cached);
      return;
    }
    let cancelled = false;
    void (async () => {
      // user_profiles.id IS the auth.users.id (one-to-one mirror table).
      // The web app's profile loader uses the same .eq('id', userId) shape
      // — keep them in sync so avatars uploaded on web show up here.
      const { data } = await supabase
        .from('user_profiles')
        .select('full_name, avatar_url, email')
        .eq('id', user.id)
        .maybeSingle();
      if (cancelled) return;
      const fullName =
        (data?.full_name as string | undefined)
          ?? (user.user_metadata?.full_name as string | undefined)
          ?? null;
      const avatarUrl = (data?.avatar_url as string | undefined) ?? null;
      const email = (data?.email as string | undefined) ?? user.email ?? null;
      const next: Profile = {
        fullName,
        avatarUrl,
        email,
        initials: initialsFor(fullName, email),
      };
      cache.set(user.id, next);
      setProfile(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  return profile;
}

/**
 * Force-refresh the cached profile after a user updates their avatar
 * in Settings. Components consuming useProfile will pick up the new
 * value on their next render.
 */
export function invalidateProfile(user: User | null): void {
  if (user) cache.delete(user.id);
}
