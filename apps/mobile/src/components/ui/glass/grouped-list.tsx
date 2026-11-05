import * as React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../../../lib/use-theme';

import { GlassSurface } from './glass-surface';
import { GLASS_METRICS } from './metrics';

/**
 * The iOS grouped list (.ios-group, radius 24) on glass: one content surface
 * (the card fill over the scene, no live blur) with the rows inside, a .5pt
 * --line-2 separator between rows inset 16pt (the artifact's
 * `.ios-row + .ios-row::before`). The rows are the caller's own pressables,
 * each keeping its 44pt (56pt drawn) target.
 */
export function GroupedList({
  children,
  separatorInset = GLASS_METRICS.row.separatorInset,
  style,
}: {
  children: React.ReactNode;
  separatorInset?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { g, c } = useTheme();
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <GlassSurface
      variant="content"
      radius={GLASS_METRICS.group.radius}
      style={[styles.clip, style]}
    >
      {rows.map((row, i) => (
        <React.Fragment key={i}>
          {i > 0 ? (
            <View
              style={[
                styles.separator,
                { marginLeft: separatorInset, backgroundColor: g?.line2 ?? c.hair },
              ]}
            />
          ) : null}
          {row}
        </React.Fragment>
      ))}
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth },
});
