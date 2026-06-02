import * as React from 'react';
import Svg, { Path, type SvgProps } from 'react-native-svg';

// Simplified Zendesk-style mark (two angular wedges). Accepts lucide-react-native
// style props (size + color) so it slots into the mobile NAV_ICONS map.
export interface ZendeskLogoProps extends SvgProps {
  size?: number;
  color?: string;
}

export function ZendeskLogo({ size = 24, color = '#111', ...rest }: ZendeskLogoProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color} {...rest}>
      <Path d="M11 8.5V19H3z" />
      <Path d="M13 15.5V5h8z" />
    </Svg>
  );
}
