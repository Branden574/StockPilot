'use client';

import * as React from 'react';
import * as RechartsPrimitive from 'recharts';
import type { LegendPayload, TooltipContentProps } from 'recharts';

import { cn } from '@/lib/utils';

// Recharts 3 generic param defaults — the public ValueType/NameType aren't
// re-exported under those names from the package root, so alias them here from
// the tooltip content prop generics we actually use. NonNullable strips the
// `undefined` the payload entry types carry, so they satisfy the
// `extends ValueType`/`extends NameType` constraints on TooltipContentProps.
type TooltipValue = NonNullable<
  NonNullable<TooltipContentProps['payload']>[number]['value']
>;
type TooltipName = NonNullable<
  NonNullable<TooltipContentProps['payload']>[number]['name']
>;

// shadcn/ui chart primitive (new-york), adapted for Recharts 3 + React 19.
// Provides a themed ResponsiveContainer wrapper (ChartContainer) that injects
// per-series CSS variables (--color-<key>) from a ChartConfig, plus tooltip
// and legend content renderers wired to that config. Self-contained: widgets
// import these and never touch raw Recharts theming.
//
// NOTE: the upstream shadcn primitive injects a <style> tag via
// dangerouslySetInnerHTML to support per-theme (light/dark) color overrides.
// We deliberately avoid that here (no untrusted HTML, satisfies the repo's
// security lint) and instead set the --color-<key> variables inline on the
// chart root via `style`. Theme-awareness still works because our ChartConfig
// colors reference `hsl(var(--chart-N))` tokens whose values already flip
// between :root and .dark in globals.css. Per-key explicit light/dark color
// pairs (the `theme` field) are therefore not used by our widgets; if a
// future widget needs that, resolve it against the active theme before
// passing a single `color`.

export type ChartConfig = {
  [k in string]: {
    label?: React.ReactNode;
    icon?: React.ComponentType;
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<'light' | 'dark', string> }
  );
};

type ChartContextProps = {
  config: ChartConfig;
};

const ChartContext = React.createContext<ChartContextProps | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);

  if (!context) {
    throw new Error('useChart must be used within a <ChartContainer />');
  }

  return context;
}

/**
 * Resolve the ChartConfig into a flat map of inline CSS custom properties
 * (`--color-<key>`) that Recharts series reference via
 * `fill="var(--color-<key>)"` / `stroke="var(--color-<key>)"`. For configs
 * that supply an explicit light/dark `theme` pair we fall back to the light
 * value (see module note); single-`color` configs are used as-is.
 */
function configToStyleVars(config: ChartConfig): React.CSSProperties {
  const vars: Record<string, string> = {};
  for (const [key, conf] of Object.entries(config)) {
    const color = conf.color ?? conf.theme?.light;
    if (color) vars[`--color-${key}`] = color;
  }
  return vars as React.CSSProperties;
}

function ChartContainer({
  id,
  className,
  children,
  config,
  style,
  chartHeight,
  ...props
}: React.ComponentProps<'div'> & {
  config: ChartConfig;
  /**
   * Pixel height handed straight to ResponsiveContainer. Threading a NUMERIC
   * height makes recharts' first-render dimension calc positive, which silences
   * the "The width(-1) and height(-1) of chart should be greater than 0" warning
   * recharts 3.8.1 logs even in production (its isDev flag is hardcoded true).
   * `minHeight` alone does NOT silence it — minHeight isn't part of the
   * dimension calc — so callers that set a fixed pixel height on the wrapping
   * div should also pass that same number here.
   */
  chartHeight?: number;
  children: React.ComponentProps<
    typeof RechartsPrimitive.ResponsiveContainer
  >['children'];
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${id || uniqueId.replace(/:/g, '')}`;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector]:outline-hidden [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-hidden",
          className,
        )}
        style={{ ...configToStyleVars(config), ...style }}
        {...props}
      >
        <RechartsPrimitive.ResponsiveContainer
          width="100%"
          height={chartHeight ?? '100%'}
          minHeight={chartHeight ?? 120}
        >
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

const ChartTooltip = RechartsPrimitive.Tooltip;

function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = 'dot',
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  color,
  nameKey,
  labelKey,
}: Partial<TooltipContentProps<TooltipValue, TooltipName>> &
  React.ComponentProps<'div'> & {
    hideLabel?: boolean;
    hideIndicator?: boolean;
    indicator?: 'line' | 'dot' | 'dashed';
    nameKey?: string;
    labelKey?: string;
  }) {
  const { config } = useChart();

  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) {
      return null;
    }

    const [item] = payload;
    const key = `${labelKey || item?.dataKey || item?.name || 'value'}`;
    const itemConfig = getPayloadConfigFromPayload(config, item, key);
    const value =
      !labelKey && typeof label === 'string'
        ? config[label as keyof typeof config]?.label || label
        : itemConfig?.label;

    if (labelFormatter) {
      return (
        <div className={cn('font-medium', labelClassName)}>
          {labelFormatter(value, payload)}
        </div>
      );
    }

    if (!value) {
      return null;
    }

    return <div className={cn('font-medium', labelClassName)}>{value}</div>;
  }, [
    label,
    labelFormatter,
    payload,
    hideLabel,
    labelClassName,
    config,
    labelKey,
  ]);

  if (!active || !payload?.length) {
    return null;
  }

  const nestLabel = payload.length === 1 && indicator !== 'dot';

  return (
    <div
      className={cn(
        'border-border/50 bg-background grid min-w-[8rem] items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl',
        className,
      )}
    >
      {!nestLabel ? tooltipLabel : null}
      <div className="grid gap-1.5">
        {payload.map((item, index) => {
          const key = `${nameKey || item.name || item.dataKey || 'value'}`;
          const itemConfig = getPayloadConfigFromPayload(config, item, key);
          const indicatorColor =
            color || (item.payload as { fill?: string })?.fill || item.color;

          return (
            <div
              // `key` is the resolved string above; `item.dataKey` can be a
              // function in Recharts 3, so it's not a valid React key. Suffix
              // with the index to stay unique when keys collide.
              key={`${key}-${index}`}
              className={cn(
                'flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-muted-foreground',
                indicator === 'dot' && 'items-center',
              )}
            >
              {formatter && item?.value !== undefined && item.name ? (
                formatter(item.value, item.name, item, index, item.payload)
              ) : (
                <>
                  {itemConfig?.icon ? (
                    <itemConfig.icon />
                  ) : (
                    !hideIndicator && (
                      <div
                        className={cn(
                          'shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)',
                          {
                            'h-2.5 w-2.5': indicator === 'dot',
                            'w-1': indicator === 'line',
                            'w-0 border-[1.5px] border-dashed bg-transparent':
                              indicator === 'dashed',
                            'my-0.5': nestLabel && indicator === 'dashed',
                          },
                        )}
                        style={
                          {
                            '--color-bg': indicatorColor,
                            '--color-border': indicatorColor,
                          } as React.CSSProperties
                        }
                      />
                    )
                  )}
                  <div
                    className={cn(
                      'flex flex-1 justify-between leading-none',
                      nestLabel ? 'items-end' : 'items-center',
                    )}
                  >
                    <div className="grid gap-1.5">
                      {nestLabel ? tooltipLabel : null}
                      <span className="text-muted-foreground">
                        {itemConfig?.label || item.name}
                      </span>
                    </div>
                    {item.value !== undefined && (
                      <span className="text-foreground font-mono font-medium tabular-nums">
                        {item.value.toLocaleString()}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ChartLegend = RechartsPrimitive.Legend;

function ChartLegendContent({
  className,
  hideIcon = false,
  payload,
  verticalAlign = 'bottom',
  nameKey,
}: React.ComponentProps<'div'> & {
  payload?: readonly LegendPayload[];
  verticalAlign?: 'top' | 'middle' | 'bottom';
  hideIcon?: boolean;
  nameKey?: string;
}) {
  const { config } = useChart();

  if (!payload?.length) {
    return null;
  }

  return (
    <div
      className={cn(
        'flex items-center justify-center gap-4',
        verticalAlign === 'top' ? 'pb-3' : 'pt-3',
        className,
      )}
    >
      {payload.map((item) => {
        const key = `${nameKey || item.dataKey || 'value'}`;
        const itemConfig = getPayloadConfigFromPayload(config, item, key);

        return (
          <div
            key={item.value}
            className={cn(
              'flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-muted-foreground',
            )}
          >
            {itemConfig?.icon && !hideIcon ? (
              <itemConfig.icon />
            ) : (
              <div
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{
                  backgroundColor: item.color,
                }}
              />
            )}
            {itemConfig?.label}
          </div>
        );
      })}
    </div>
  );
}

// Helper to extract item config from a payload.
function getPayloadConfigFromPayload(
  config: ChartConfig,
  payload: unknown,
  key: string,
) {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }

  const payloadPayload =
    'payload' in payload &&
    typeof payload.payload === 'object' &&
    payload.payload !== null
      ? payload.payload
      : undefined;

  let configLabelKey: string = key;

  if (
    key in payload &&
    typeof (payload as Record<string, unknown>)[key] === 'string'
  ) {
    configLabelKey = (payload as Record<string, unknown>)[key] as string;
  } else if (
    payloadPayload &&
    key in payloadPayload &&
    typeof (payloadPayload as Record<string, unknown>)[key] === 'string'
  ) {
    configLabelKey = (payloadPayload as Record<string, unknown>)[key] as string;
  }

  return configLabelKey in config
    ? config[configLabelKey]
    : config[key as keyof typeof config];
}

export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
};
