import * as React from 'react';
import Svg, { Path, type SvgProps } from 'react-native-svg';

import { useTheme } from '@/lib/use-theme';

// Simplified Zendesk-style mark (two angular wedges). Accepts lucide-react-native
// style props (size + color) so it slots into the mobile NAV_ICONS map. Without
// a colour it draws in the ink of the device's mode (it was a fixed near-black,
// invisible on the dark page).
export interface ZendeskLogoProps extends SvgProps {
  size?: number;
  color?: string;
}

export function ZendeskLogo({ size = 24, color, ...rest }: ZendeskLogoProps) {
  const { c } = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color ?? c.ink} {...rest}>
      <Path d="M11 8.5V19H3z" />
      <Path d="M13 15.5V5h8z" />
    </Svg>
  );
}
