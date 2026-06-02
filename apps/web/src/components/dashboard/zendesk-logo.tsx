import * as React from 'react';
import type { LucideProps } from 'lucide-react';

// Simplified Zendesk-style mark (two angular wedges) in currentColor so it
// inherits the nav's color states. Lucide-shaped props so it drops into NAV_ICONS.
// `size`/`color`/`strokeWidth`/`absoluteStrokeWidth` are lucide-only props and
// are destructured out so only valid SVG attrs spread onto the element.
export const ZendeskLogo = React.forwardRef<SVGSVGElement, LucideProps>(
  ({ size = 24, className, color, strokeWidth, absoluteStrokeWidth, ...rest }, ref) => (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      <path d="M11 8.5V19H3z" />
      <path d="M13 15.5V5h8z" />
    </svg>
  ),
);
ZendeskLogo.displayName = 'ZendeskLogo';
