'use client';

import { ArrowRight, Check, Circle, Sparkles, X, type LucideIcon } from 'lucide-react';
import * as React from 'react';
import Link from 'next/link';

import { touchTargetClass } from '@/components/patterns/touch-target';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { dismissOnboardingAction } from '@/server/actions/onboarding';

interface ChecklistStep {
  id: string;
  done: boolean;
  title: string;
  description: string;
  href: string;
  cta: string;
}

interface GetStartedChecklistProps {
  steps: ChecklistStep[];
  /** Optional title override; defaults to "Get started". */
  title?: string;
  /** Greeting name for the animated first-run header. */
  firstName?: string | null;
  /** When true the panel offers a dismiss X that persists via mig 0257. */
  dismissible?: boolean;
}

const AI_PROMPTS = [
  'How do I receive a purchase order?',
  'Walk me through picking an order',
  'What does the Schedule do?',
];

/**
 * Day-zero / fresh-org guidance. Shows a numbered checklist of the four
 * actions a new operator needs to take to make the dashboard meaningful:
 * confirm warehouse, invite team, add the first item, set up MFA. Each
 * step has a CTA button; completed steps render with a strike + check.
 *
 * Hides itself entirely when every step is done — call sites only mount
 * this when at least one step is still incomplete.
 *
 * Drawn as an Overview card (DESIGN-SPEC 6.7): the 49 px header with the title,
 * the "n / 4" count and the dismiss button, then the steps as hairline rows.
 * The steps' links are secondary buttons (the page keeps its one ink button,
 * Receive stock). The section keeps `aria-labelledby="get-started-heading"`
 * and its h2 keeps that id: the dashboard tour spotlights it.
 */
export function GetStartedChecklist({
  steps,
  title = 'Get started',
  firstName,
  dismissible = true,
}: GetStartedChecklistProps) {
  const [dismissed, setDismissed] = React.useState(false);
  const completed = steps.filter((s) => s.done).length;
  const total = steps.length;
  const progressPct = Math.round((completed / total) * 100);
  if (dismissed) return null;

  return (
    <section
      aria-labelledby="get-started-heading"
      className="gs-panel border-border bg-card text-card-foreground min-w-0 overflow-hidden rounded-lg border"
    >
      <div className="border-border flex min-h-[49px] items-center justify-between gap-3 border-b py-2.5 pl-[18px] pr-2.5">
        <h2
          id="get-started-heading"
          className="text-foreground min-w-0 text-[13.5px] font-medium leading-5"
        >
          {firstName ? `Welcome, ${firstName}` : title}
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-muted-foreground font-mono text-[12px] tabular-nums">
            {completed} / {total}
          </span>
          {dismissible && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Dismiss getting started"
              onClick={() => {
                setDismissed(true);
                void dismissOnboardingAction();
              }}
              className="text-muted-foreground size-7"
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div className="p-[18px]">
        <p className="text-muted-foreground text-[12.5px] leading-[18.75px]">
          Four quick steps and your team is up and running.
        </p>

        {/* The reference's progress bar (DESIGN-SPEC 6.11): 4 px, the
            stronger hairline as the track, the accent as the fill. */}
        <div className="bg-line-strong mt-3 h-1 w-full overflow-hidden rounded-[2px]">
          <div
            data-slot="get-started-progress"
            className="bg-accent h-full rounded-[2px] transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        <ol className="mt-4 space-y-2">
          {steps.map((step, idx) => {
            const Icon: LucideIcon = step.done ? Check : Circle;
            return (
              <li
                key={step.id}
                style={{ animationDelay: `${100 + idx * 90}ms` }}
                className={cn(
                  'gs-item border-border flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2.5',
                  step.done && 'bg-sunk',
                )}
              >
                <div
                  className={cn(
                    'grid size-6 shrink-0 place-items-center rounded-full',
                    step.done
                      ? 'bg-success-wash text-accent'
                      : 'border-line-strong text-muted-foreground border',
                  )}
                >
                  {step.done ? (
                    <Icon aria-hidden className="size-3.5" strokeWidth={2.5} />
                  ) : (
                    <span className="font-mono text-[11px] font-medium">{idx + 1}</span>
                  )}
                </div>
                <div className="min-w-0 flex-1 basis-48">
                  <p
                    className={cn(
                      'text-[13.5px] font-medium leading-5',
                      step.done && 'text-muted-foreground line-through',
                    )}
                  >
                    {step.title}
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-[12.5px] leading-[18.75px]">
                    {step.description}
                  </p>
                </div>
                {!step.done && (
                  <Button asChild variant="outline" size="sm" className="shrink-0">
                    <Link href={step.href}>
                      {step.cta}
                      <ArrowRight aria-hidden className="size-3.5" />
                    </Link>
                  </Button>
                )}
              </li>
            );
          })}
        </ol>

        <div
          className="gs-item mt-4 flex flex-wrap items-center gap-2"
          style={{ animationDelay: `${100 + steps.length * 90 + 80}ms` }}
        >
          <span className="text-muted-foreground mr-1 inline-flex items-center gap-1 text-[12.5px]">
            <Sparkles aria-hidden className="size-3.5" /> Or ask the AI:
          </span>
          {AI_PROMPTS.map((p) => (
            <Link
              key={p}
              href={`/dashboard/ai?q=${encodeURIComponent(p)}`}
              data-slot="ai-prompt-chip"
              className={cn(
                'border-line-strong text-ink-2 hover:bg-muted hover:text-foreground inline-flex h-7 items-center rounded-full border px-2.5 text-[12.5px] transition-colors',
                touchTargetClass,
              )}
            >
              {p}
            </Link>
          ))}
        </div>
      </div>

      <style>{`
        .gs-panel { animation: gs-rise 480ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        .gs-item { animation: gs-rise 420ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        @keyframes gs-rise {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .gs-panel, .gs-item { animation: none; }
        }
      `}</style>
    </section>
  );
}
