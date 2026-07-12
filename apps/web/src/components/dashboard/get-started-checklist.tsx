'use client';

import { ArrowRight, Check, Circle, Sparkles, X, type LucideIcon } from 'lucide-react';
import * as React from 'react';
import Link from 'next/link';

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
      className="gs-panel border-border bg-card relative rounded-lg border p-5 shadow-[0_14px_44px_rgba(14,15,13,0.06)]"
    >
      {dismissible && (
        <button
          type="button"
          aria-label="Dismiss getting started"
          onClick={() => {
            setDismissed(true);
            void dismissOnboardingAction();
          }}
          className="text-muted-foreground hover:text-foreground absolute top-3 right-3 rounded-md p-1 transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2
            id="get-started-heading"
            className="font-display text-[15px] font-medium tracking-[-0.01em]"
          >
            {firstName ? `Welcome, ${firstName}` : title}
          </h2>
          <p className="text-muted-foreground mt-0.5 text-[12px]">
            Four quick steps and your team is up and running.
          </p>
        </div>
        <span className="text-muted-foreground tabular-nums text-[11px]">
          {completed} / {total}
        </span>
      </div>

      <div className="bg-muted mt-3 h-1 w-full overflow-hidden rounded-full">
        <div
          className="bg-foreground h-full rounded-full transition-all"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <ol className="mt-4 space-y-2.5">
        {steps.map((step, idx) => {
          const Icon: LucideIcon = step.done ? Check : Circle;
          return (
            <li
              key={step.id}
              style={{ animationDelay: `${100 + idx * 90}ms` }}
              className={cn(
                'gs-item border-border flex items-start gap-3 rounded-md border p-3 transition-colors',
                step.done ? 'bg-muted/30' : 'bg-background',
              )}
            >
              <div
                className={cn(
                  'mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border',
                  step.done
                    ? 'border-success/40 bg-success/10 text-success'
                    : 'border-border bg-card text-muted-foreground',
                )}
              >
                {step.done ? (
                  <Icon className="h-3.5 w-3.5" strokeWidth={2.5} />
                ) : (
                  <span className="font-mono text-[11px] font-semibold">{idx + 1}</span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'text-sm font-medium',
                    step.done && 'text-muted-foreground line-through',
                  )}
                >
                  {step.title}
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {step.description}
                </p>
              </div>
              {!step.done && (
                <Link
                  href={step.href}
                  className="bg-foreground text-background hover:bg-foreground/90 inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11.5px] font-medium"
                >
                  {step.cta}
                  <ArrowRight className="h-3 w-3" />
                </Link>
              )}
            </li>
          );
        })}
      </ol>

      <div
        className="gs-item mt-4 flex flex-wrap items-center gap-1.5"
        style={{ animationDelay: `${100 + steps.length * 90 + 80}ms` }}
      >
        <span className="text-muted-foreground mr-1 inline-flex items-center gap-1 text-[11.5px]">
          <Sparkles className="h-3.5 w-3.5" /> Or ask the AI:
        </span>
        {AI_PROMPTS.map((p) => (
          <Link
            key={p}
            href={`/dashboard/ai?q=${encodeURIComponent(p)}`}
            className="border-border hover:border-foreground/30 hover:bg-accent/40 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors"
          >
            {p}
          </Link>
        ))}
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
