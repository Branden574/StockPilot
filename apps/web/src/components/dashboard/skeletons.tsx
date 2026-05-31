import { cn } from '@/lib/utils';

export function PageSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('mx-auto w-full max-w-[1480px] px-8 pb-20 pt-7', className)}>
      <div className="mb-5 flex items-end justify-between gap-6 border-b border-border pb-4">
        <div className="space-y-2">
          <Bar w={120} h={11} />
          <Bar w={280} h={28} />
          <Bar w={420} h={13} />
        </div>
        <div className="flex gap-2">
          <Bar w={88} h={28} radius={6} />
          <Bar w={92} h={28} radius={6} />
          <Bar w={120} h={28} radius={6} />
        </div>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-[10px] border border-border bg-card p-4 space-y-2.5">
            <Bar w={110} h={11} />
            <div className="flex items-end justify-between">
              <Bar w={120} h={30} />
              <Bar w={84} h={26} />
            </div>
            <Bar w="100%" h={11} />
          </div>
        ))}
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3.5 lg:grid-cols-12">
        <div className="rounded-[10px] border border-border bg-card lg:col-span-8">
          <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <div className="space-y-1.5">
              <Bar w={180} h={14} />
              <Bar w={220} h={11} />
            </div>
          </div>
          <div className="p-5">
            <Bar w="100%" h={240} radius={8} />
          </div>
        </div>
        <div className="rounded-[10px] border border-border bg-card lg:col-span-4">
          <div className="border-b border-border px-5 py-3.5 space-y-1.5">
            <Bar w={150} h={14} />
            <Bar w={180} h={11} />
          </div>
          <div className="space-y-3 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between gap-3">
                <Bar w={70} h={12} />
                <Bar w={90} h={6} radius={999} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function TablePageSkeleton({ rows = 8, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('mx-auto w-full max-w-[1480px] px-8 pb-20 pt-7', className)}>
      <div className="mb-5 flex items-end justify-between gap-6 border-b border-border pb-4">
        <div className="space-y-2">
          <Bar w={180} h={28} />
          <Bar w={320} h={13} />
        </div>
        <div className="flex gap-2">
          <Bar w={100} h={28} radius={6} />
          <Bar w={92} h={28} radius={6} />
        </div>
      </div>
      <div className="mb-3 flex gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Bar key={i} w={92} h={24} radius={999} />
        ))}
      </div>
      <TableBodySkeleton rows={rows} />
    </div>
  );
}

/**
 * Just the table-body chunk of TablePageSkeleton (no h1/toolbar). Used as the
 * <Suspense fallback> for the streamed data table on the list pages so the
 * page chrome (heading, filter toolbar, New/Import buttons, view toggles)
 * paints immediately while only the rows stream in. Rows + column grid mirror
 * TablePageSkeleton so the in-page fallback matches the full-page loading.tsx.
 */
export function TableBodySkeleton({ rows = 8, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-[10px] border border-border bg-card', className)}>
      <div className="border-b border-border bg-card px-3 py-2.5">
        <Bar w={220} h={12} />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="grid items-center gap-3 border-b border-border px-3 py-3 last:border-0"
          style={{ gridTemplateColumns: '32px 1.4fr 1fr 1fr 1fr 90px 70px 80px 70px' }}
        >
          <Bar w={14} h={14} radius={3} />
          <div className="flex items-center gap-2.5">
            <Bar w={28} h={28} radius={5} />
            <Bar w={140} h={12} />
          </div>
          <Bar w={100} h={11} />
          <Bar w={80} h={11} />
          <Bar w={80} h={11} />
          <Bar w={48} h={11} />
          <Bar w={70} h={6} radius={999} />
          <Bar w={56} h={18} />
          <Bar w={50} h={11} />
        </div>
      ))}
    </div>
  );
}

function Bar({
  w,
  h,
  radius = 4,
}: {
  w: number | string;
  h: number;
  radius?: number;
}) {
  return (
    <div
      className="animate-pulse bg-muted"
      style={{
        width: typeof w === 'number' ? `${w}px` : w,
        height: h,
        borderRadius: radius,
      }}
    />
  );
}
