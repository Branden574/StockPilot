import * as React from 'react';
import { Modal as NativeModal } from 'react-native';

import { useHoldUpdatePrompt } from '@/lib/update-prompt-holds';

/**
 * React Native's Modal, plus one thing: while it is visible, the phone update
 * pop-up waits (update-prompt-holds.ts, B44), so "Update ready" never comes up
 * over an open sheet and Restart now is never one tap away from a half-filled
 * one. The route cannot see a Modal: a sheet open over a list (the workspace
 * switcher, a filter, a notification's detail, a tour) otherwise reads as
 * nobody working.
 *
 * Every Modal in app/ and src/ imports this one, never react-native's;
 * update-prompt-wiring.test.ts pins that. React Native's `visible` defaults to
 * true, so an omitted prop is treated as visible here too.
 */
export function Modal(props: React.ComponentProps<typeof NativeModal>) {
  useHoldUpdatePrompt(props.visible ?? true, 'sheet');
  return <NativeModal {...props} />;
}
