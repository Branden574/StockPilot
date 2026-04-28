const STATS = [
  ['1,400+', 'operators run on it'],
  ['$48M', 'of inventory tracked'],
  ['99.99%', 'movement reconciliation'],
  ['12 ms', 'avg query latency'],
] as const;

export function StatRow() {
  return (
    <div
      className="grid grid-cols-2 gap-px border-y border-border bg-border md:grid-cols-4"
    >
      {STATS.map(([n, l]) => (
        <div key={l} className="flex flex-col gap-1.5 bg-background px-7 py-9">
          <div className="font-display text-[44px] leading-none tracking-[-0.03em] tabular-nums">{n}</div>
          <div className="text-[12px] text-[var(--ed-ink-3)]">{l}</div>
        </div>
      ))}
    </div>
  );
}
