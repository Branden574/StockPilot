import { useFocusEffect } from 'expo-router';
import * as React from 'react';

import { holdAppearanceAdoption } from './adoption-holds';

/**
 * While this screen is focused, a Design adopted from the account waits
 * (item 32): for the Scan tab and the cycle-count entry screens, where a
 * switch of the whole look in the middle of a scan or a count would cost the
 * person their place. The hold ends when the screen loses focus or unmounts.
 */
export function useHoldAppearanceAdoptionWhileFocused(reason: 'scan' | 'count'): void {
  useFocusEffect(React.useCallback(() => holdAppearanceAdoption(reason), [reason]));
}
