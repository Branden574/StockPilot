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
 */
export function MarkdownBody({ body, className }: MarkdownBodyProps) {
  const trimmed = body?.trim() ?? '';
  if (!trimmed) {
    return (
      <p className={cn('text-sm italic text-muted-foreground', className)}>
        No written instructions yet.
      </p>
    );
  }
  return (
    <div
      className={cn(
        // Hand-rolled prose to avoid depending on @tailwindcss/typography
        // (we don't have it installed). Keeps procedures readable on
        // narrow screens while still feeling like an article.
        'max-w-[680px] text-[15px] leading-7 text-foreground',
        '[&_p]:my-3 [&_p]:leading-7',
        '[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold',
        '[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold',
        '[&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold',
        '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-1',
        '[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:space-y-1',
        '[&_li]:marker:text-muted-foreground',
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
        '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[13px]',
        '[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4 [&_pre]:text-[13px]',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_blockquote]:my-3 [&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-muted-foreground',
        '[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm',
        '[&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium',
        '[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2',
        '[&_hr]:my-6 [&_hr]:border-border',
        '[&_input[type=checkbox]]:mr-2',
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
