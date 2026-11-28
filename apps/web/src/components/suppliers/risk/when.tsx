import { ZonedTime } from '@/components/platform/zoned-time';
import { supplierRiskMoment, supplierRiskWhen } from '@/lib/supplier-risk/words';

/**
 * A time on the vendor risk pages, in the organization's zone: its day
 * ("November 27, 2026"), or with `clock` its day, clock and zone ("November
 * 27, 2026, 5:30 PM PST"). The exact instant in UTC is in the title and read
 * after it by a screen reader (the platform security pages' ZonedTime). No
 * hooks and no runtime zone: the server and the browser draw the same text.
 */
export function SupplierRiskTime({
  at,
  timeZone,
  clock = false,
}: {
  at: string | null | undefined;
  timeZone: string;
  clock?: boolean;
}) {
  if (!at || !Number.isFinite(Date.parse(at))) return <>—</>;
  return (
    <ZonedTime
      at={at}
      shown={clock ? supplierRiskMoment(at, timeZone) : supplierRiskWhen(at, timeZone)}
    />
  );
}
