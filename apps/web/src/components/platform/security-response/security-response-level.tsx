import {
  SECURITY_RESPONSE_LEVEL_WORDS,
  SECURITY_RESPONSE_WORDS,
  type SecurityResponseLevel,
} from '@stockpilot/core';

/**
 * A card's urgency as a badge: its words, a shape of its own and a weight of
 * its own, so the level is never told by colour alone. Act now is a filled
 * triangle in semibold with a solid edge; Look today a ring in medium with a
 * hairline edge; Stopped a check mark in plain text with no edge.
 */

const LOOK: Record<
  SecurityResponseLevel,
  { page: string; stage: string; weight: string; edge: string }
> = {
  act_now: {
    page: 'text-destructive border-destructive/60 bg-destructive/10',
    stage: 'text-[#ffc2c2] border-[#ff8f8f] bg-[#ff8f8f]/15',
    weight: 'font-semibold',
    edge: 'border-[1.5px]',
  },
  look_today: {
    page: 'text-foreground border-[var(--ed-line-strong)] bg-card',
    stage: 'text-[#fbd38d] border-[#f5b041]/70 bg-transparent',
    weight: 'font-medium',
    edge: 'border',
  },
  stopped: {
    page: 'text-muted-foreground border-transparent',
    stage: 'text-[#a3b3cb] border-transparent',
    weight: 'font-normal',
    edge: 'border',
  },
};

function LevelMark({ level }: { level: SecurityResponseLevel }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width={12}
      height={12}
      aria-hidden="true"
      focusable="false"
      data-part="level-mark"
      className="shrink-0"
    >
      {level === 'act_now' ? (
        <path d="M6 1.2 11 10.4H1z" fill="currentColor" />
      ) : level === 'look_today' ? (
        <circle cx={6} cy={6} r={4} fill="none" stroke="currentColor" strokeWidth={1.6} />
      ) : (
        <path
          d="M2.2 6.4 4.9 9 9.8 3.2"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export function SecurityResponseLevelBadge({
  level,
  tone = 'page',
}: {
  level: SecurityResponseLevel;
  tone?: 'page' | 'stage';
}) {
  const look = LOOK[level];
  return (
    <span
      data-level={level}
      data-testid="security-response-level"
      title={SECURITY_RESPONSE_WORDS.levelLabel}
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[11.5px] leading-none ${look.edge} ${look.weight} ${
        tone === 'stage' ? look.stage : look.page
      }`}
    >
      <LevelMark level={level} />
      {SECURITY_RESPONSE_LEVEL_WORDS[level]}
    </span>
  );
}
