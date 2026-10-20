import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/utils';

interface MarkdownBodyProps {
  body: string;
  className?: string;
}

/**
 * Sanitized markdown renderer for procedure bodies.
 *
 * Uses react-markdown with `remark-gfm` for tables / task-lists /
 * autolinks. We deliberately do NOT pass `rehype-raw`, which is what
 * would let users inject raw HTML — without it, react-markdown's
 * default behaviour is to escape HTML on input so a body containing
 * `<script>` renders as text. No external schemas/sanitizers needed.
 *
 * The component is a Server Component (no `use client`) because the
 * markdown body is always available on the server and rendering it
 * server-side gives us free SSR caching + zero client JS for the body.
 *
 * NOTE(deferred — bug-hunt M4): we do NOT allow-list `![alt](url)`
 * image hosts. A manager can author a procedure that includes an image
 * from any third-party domain, and end users will fetch it directly.
 * For an invite-only internal tool the risk is limited, but if the
 * product ever opens up we should pipe images through a known-good
 * image proxy (Vercel `next/image` w/ remotePatterns) or restrict the
 * `<img>` rendering to a small allow-list of hosts (e.g. our own
 * Supabase storage CDN).
 */
export function MarkdownBody({ body, className }: MarkdownBodyProps) {
  const trimmed = body?.trim() ?? '';
  if (!trimmed) {
    return (
      <p className={cn('text-muted-foreground text-[13.5px] italic', className)}>
        No written instructions yet.
      </p>
    );
  }
  return (
    <div
      data-slot="procedure-markdown"
      className={cn(
        // Hand-rolled prose to avoid depending on @tailwindcss/typography
        // (we don't have it installed). Keeps procedures readable on
        // narrow screens while still feeling like an article. Every rule is
        // scoped to this element ([&_x]), so global changes never restyle
        // it, and every colour is a theme token, so both modes read.
        'text-foreground max-w-[680px] text-[15px] leading-7 [overflow-wrap:anywhere]',
        '[&_p]:my-3 [&_p]:leading-7',
        '[&_h1]:mb-3 [&_h1]:mt-7 [&_h1]:font-display [&_h1]:text-[24px] [&_h1]:font-medium [&_h1]:leading-[1.3] [&_h1]:tracking-[-0.02em]',
        '[&_h2]:mb-2 [&_h2]:mt-6 [&_h2]:font-display [&_h2]:text-[20px] [&_h2]:font-medium [&_h2]:leading-[1.35] [&_h2]:tracking-[-0.015em]',
        '[&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:font-display [&_h3]:text-[17px] [&_h3]:font-medium [&_h3]:leading-[1.4]',
        '[&_h1:first-child]:mt-0 [&_h2:first-child]:mt-0 [&_h3:first-child]:mt-0',
        '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-6',
        '[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-6',
        '[&_li]:marker:text-muted-foreground',
        '[&_strong]:text-foreground [&_strong]:font-semibold',
        '[&_a]:text-accent [&_a:hover]:text-foreground [&_a]:underline [&_a]:underline-offset-2',
        '[&_code]:bg-sunk [&_code]:border-border [&_code]:rounded [&_code]:border [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px]',
        '[&_pre]:bg-sunk [&_pre]:border-border [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:p-4 [&_pre]:text-[13px] [&_pre]:[overflow-wrap:normal]',
        '[&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_blockquote]:border-line-strong [&_blockquote]:text-ink-2 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:italic',
        '[&_table]:my-4 [&_table]:block [&_table]:w-full [&_table]:border-collapse [&_table]:overflow-x-auto [&_table]:text-[13.5px] [&_table]:[overflow-wrap:normal]',
        '[&_th]:border-border [&_th]:bg-sunk [&_th]:text-muted-foreground [&_th]:border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-[12px] [&_th]:font-medium',
        '[&_td]:border-border [&_td]:border [&_td]:px-3 [&_td]:py-2',
        '[&_hr]:border-border [&_hr]:my-6',
        '[&_input[type=checkbox]]:accent-foreground [&_input[type=checkbox]]:mr-2',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Explicitly disable raw HTML (the default). With no rehype-raw
        // plugin, react-markdown escapes any HTML tags it encounters.
        skipHtml
      >
        {trimmed}
      </ReactMarkdown>
    </div>
  );
}
