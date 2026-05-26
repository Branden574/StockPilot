export function MarketingFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-[1280px] items-center justify-between px-8 py-9 text-[12px] text-[var(--ed-ink-4)]">
        <div>&copy; {new Date().getFullYear()} StockPilot &mdash; Inventory + order operations</div>
      </div>
    </footer>
  );
}
