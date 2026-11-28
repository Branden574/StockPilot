'use client';

import * as React from 'react';

import { vendorRiskCleanText } from '@stockpilot/core';

import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { supplierRiskTextProblem, supplierRiskTextProblemWords } from '@/lib/supplier-risk/words';

/**
 * A text the database stores (a note, a finding, an action). Hidden
 * characters are taken out with core's own list (vendorRiskCleanText) as they
 * arrive, and the field shows the cleaned text with a note saying so, so an
 * honest paste is never refused for something nobody can see. What is still
 * wrong (too long, nothing but spaces) is said under the field.
 */
export function CleanTextField({
  id,
  label,
  value,
  onChange,
  max,
  optional = false,
  disabled,
  rows = 2,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  max: number;
  optional?: boolean;
  disabled?: boolean;
  rows?: number;
}) {
  const [removed, setRemoved] = React.useState(0);
  const problem = value.length === 0 ? null : supplierRiskTextProblem(value, max);
  const problemWords = supplierRiskTextProblemWords(problem, max);
  const noteId = `${id}-note`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {optional ? (
          <span className="text-muted-foreground ml-1 font-normal">(optional)</span>
        ) : null}
      </Label>
      <Textarea
        id={id}
        rows={rows}
        value={value}
        disabled={disabled}
        dir="auto"
        aria-invalid={problem ? true : undefined}
        aria-describedby={removed > 0 || problemWords ? noteId : undefined}
        onChange={(e) => {
          const cleaned = vendorRiskCleanText(e.target.value);
          setRemoved(cleaned.removed);
          onChange(cleaned.text);
        }}
      />
      {removed > 0 || problemWords ? (
        <div id={noteId} className="space-y-0.5 text-[12.5px]">
          {removed > 0 ? (
            <p role="status" className="text-warning">
              We took out {removed === 1 ? '1 hidden character' : `${removed} hidden characters`} (a
              phone keyboard or pasted text adds them). The text above is what will be saved.
            </p>
          ) : null}
          {problemWords ? <p className="text-destructive">{problemWords}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
