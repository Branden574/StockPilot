'use client';

import * as React from 'react';

import {
  VENDOR_RISK_OVERRIDE_REASON_MAX,
  VENDOR_RISK_OVERRIDE_REASON_MIN,
  VENDOR_RISK_OVERRIDE_REASON_MIN_DIFFERENT,
  vendorRiskCleanText,
  vendorRiskReasonCount,
} from '@stockpilot/core';

import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * A written reason (an override's, or a risk accepted), with its rules shown
 * as the person types, counted by core's own function (vendorRiskReasonCount:
 * characters as seen, each run of spaces one, at least
 * VENDOR_RISK_OVERRIDE_REASON_MIN of them and
 * VENDOR_RISK_OVERRIDE_REASON_MIN_DIFFERENT different ones). Hidden
 * characters (a phone keyboard's emoji selectors and joiners, pasted text's
 * invisible ones) are taken out with core's list as they arrive, and the
 * field then SHOWS the cleaned reason with a note saying so: the reason is
 * never changed without the person seeing it.
 */
export function ReasonField({
  id,
  label,
  value,
  onChange,
  disabled,
  required = true,
  help,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  required?: boolean;
  help?: string;
}) {
  const [removed, setRemoved] = React.useState(0);
  const count = vendorRiskReasonCount(value);
  const rulesId = `${id}-rules`;
  const cleanedId = `${id}-cleaned`;
  const longEnough = count.seen >= VENDOR_RISK_OVERRIDE_REASON_MIN;
  const differentEnough = count.different >= VENDOR_RISK_OVERRIDE_REASON_MIN_DIFFERENT;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {help ? <p className="text-muted-foreground text-[12.5px]">{help}</p> : null}
      <Textarea
        id={id}
        rows={3}
        value={value}
        disabled={disabled}
        dir="auto"
        aria-required={required || undefined}
        aria-invalid={value.length > 0 && !count.ok ? true : undefined}
        aria-describedby={removed > 0 ? `${rulesId} ${cleanedId}` : rulesId}
        onChange={(e) => {
          const cleaned = vendorRiskCleanText(e.target.value);
          setRemoved(cleaned.removed);
          onChange(cleaned.text);
        }}
      />
      {removed > 0 ? (
        <p id={cleanedId} role="status" className="text-warning text-[12.5px]">
          We took out {removed === 1 ? '1 hidden character' : `${removed} hidden characters`} (a
          phone keyboard or pasted text adds them). The reason above is what will be kept: read it
          again.
        </p>
      ) : null}
      <ul id={rulesId} className="text-[12.5px] leading-5" aria-live="polite">
        <li className={longEnough ? 'text-success' : 'text-muted-foreground'}>
          {longEnough ? 'Met' : 'Not yet'}: at least {VENDOR_RISK_OVERRIDE_REASON_MIN} characters
          (now {count.seen})
        </li>
        <li className={differentEnough ? 'text-success' : 'text-muted-foreground'}>
          {differentEnough ? 'Met' : 'Not yet'}: at least{' '}
          {VENDOR_RISK_OVERRIDE_REASON_MIN_DIFFERENT} different characters (now {count.different})
        </li>
        {count.tooLong ? (
          <li className="text-destructive">
            Too long: at most {VENDOR_RISK_OVERRIDE_REASON_MAX.toLocaleString('en-US')} characters.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
