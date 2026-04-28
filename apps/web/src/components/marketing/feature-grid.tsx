import {
  ArrowLeftRight,
  BarChart3,
  Boxes,
  ClipboardList,
  type LucideIcon,
  Users,
  Zap,
} from 'lucide-react';

interface Feature {
  icon: LucideIcon;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    icon: Boxes,
    title: 'Items that mean something',
    body: 'Not just SKUs. Origins, lots, par levels, sell prices, costs — all first-class. Cycle counts that survive an audit.',
  },
  {
    icon: ArrowLeftRight,
    title: 'Movements you can trust',
    body: 'Receive, sell, transfer, adjust. Every quantity change is a row you can stand behind. Bulk reverse with a keyboard shortcut.',
  },
  {
    icon: ClipboardList,
    title: 'Purchase orders, end to end',
    body: 'Draft → approve → in transit → received. Three-way match against your receiving counts. No mystery variance.',
  },
  {
    icon: BarChart3,
    title: 'Sparklines on everything',
    body: 'Trend, coverage, and weekly draw on every row of every table. The chart is the table.',
  },
  {
    icon: Zap,
    title: 'Cmd-K, everywhere',
    body: 'Jump to any item, run any action, kick off a count — without lifting your hands. Built for operators who already know what they want.',
  },
  {
    icon: Users,
    title: 'Multi-tenant by default',
    body: 'Workspaces, roles, RLS at the database level. One login, every site you run. No spreadsheets-in-WhatsApp.',
  },
];

export function FeatureGrid() {
  return (
    <section id="product" className="mx-auto max-w-[1280px] px-8 py-[72px]">
      <p className="mb-4 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--ed-ink-4)]">
        — Built for operations
      </p>
      <h2 className="max-w-3xl font-display text-[clamp(32px,4vw,48px)] font-medium leading-[1.05] tracking-[-0.03em] text-balance">
        A counter, a calendar, and a calm place to{' '}
        <span className="font-serif-italic text-[var(--ed-ink-3)]">think about stock.</span>
      </h2>

      <div className="mt-9 grid grid-cols-1 gap-px overflow-hidden rounded-[10px] border border-border bg-border md:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <article
            key={f.title}
            className="flex min-h-[220px] flex-col gap-3 bg-card p-7"
          >
            <f.icon className="h-[22px] w-[22px] text-foreground" strokeWidth={1.4} />
            <h3 className="font-display text-[16px] font-medium tracking-[-0.01em]">{f.title}</h3>
            <p className="text-[13.5px] leading-[1.55] text-[var(--ed-ink-3)]">{f.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
