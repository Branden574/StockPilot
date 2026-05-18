'use client';

import { Volume2, VolumeX } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  isNotificationSoundMuted,
  setNotificationSoundMuted,
} from '@/lib/notifications/live-toast';

/**
 * Per-device toggle for the synthesized "ding" that plays whenever a
 * sonner toast fires for a realtime notification. Defaults to ON;
 * mute state persists in localStorage so a refresh keeps the choice.
 *
 * Test button plays the sound on demand — useful both as a "preview
 * the sound" affordance and as a way to satisfy the browser's
 * user-gesture requirement, which kicks the AudioContext out of its
 * suspended state for subsequent autoplay attempts.
 */
export function NotificationSoundToggle() {
  const [muted, setMuted] = React.useState<boolean>(false);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open/close
    setMuted(isNotificationSoundMuted());
  }, []);

  function toggle() {
    const next = !muted;
    setNotificationSoundMuted(next);
    setMuted(next);
    if (next) {
      toast.success('Notification sound muted on this device.');
    } else {
      toast.success('Notification sound on.');
      // Synthesize a test tone after a tick so the toast's own
      // user-gesture handler unlocks the AudioContext first.
      window.setTimeout(playTestTone, 80);
    }
  }

  function playTestTone() {
    // Import via window to avoid pulling Web Audio into the SSR
    // bundle; the function is local to live-toast and we don't want
    // a public surface for it. Easiest: just re-create here.
    try {
      const w = window as typeof window & {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      if (ctx.state === 'suspended') void ctx.resume();
      const now = ctx.currentTime;
      const tones = [
        { freq: 659.25, start: 0, dur: 0.18 },
        { freq: 880.0, start: 0.12, dur: 0.28 },
      ];
      for (const t of tones) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = t.freq;
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.0001, now + t.start);
        gain.gain.exponentialRampToValueAtTime(0.18, now + t.start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + t.start + t.dur);
        osc.start(now + t.start);
        osc.stop(now + t.start + t.dur + 0.02);
      }
    } catch {
      /* audio unavailable — silently no-op */
    }
  }

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="text-sm">
        <p className="font-medium">{muted ? 'Muted on this device' : 'Sound on'}</p>
        <p className="text-muted-foreground text-xs">
          Plays a short chime when a notification toast appears in the
          focused tab. Operating-system notifications (when the tab is
          backgrounded) keep using your OS&apos;s default sound regardless of
          this setting.
        </p>
      </div>
      <div className="flex gap-2">
        {!muted ? (
          <Button variant="outline" size="sm" onClick={playTestTone} type="button">
            Test
          </Button>
        ) : null}
        <Button variant={muted ? 'default' : 'outline'} size="sm" onClick={toggle} type="button">
          {muted ? (
            <>
              <Volume2 className="mr-1 h-3.5 w-3.5" /> Unmute
            </>
          ) : (
            <>
              <VolumeX className="mr-1 h-3.5 w-3.5" /> Mute
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
