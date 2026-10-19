import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * The one frame for StockPilot pages that people outside the app open from a
 * link, a QR code or an email: the signature page, request confirm and track,
 * the return request, the shared maintenance request, the public item page,
 * the portal's sign-in prompt, invite and onboarding (CONFLICTS E1, PLAN P5.1).
 *
 * Rules it keeps for every one of those pages:
 * - Server components only. Nothing here reads a session, a cookie, the
 *   database or analytics, so an anonymous page pays for no auth call and a
 *   token page logs nothing (lib/share-paths.ts).
 * - It never draws the app's sidebar, top bar, search or org switcher.
 * - It only arranges what the page hands it: every word, link and form stays
 *   the page's own.
 * - Comfortable sizes (CONFLICTS E6): these pages are used one-handed at a
 *   dock, by principals and by requesters on a phone.
 */

const WIDTH = {
  /** One form or one card: sign, confirm, track, item, invite. */
  md: 'max-w-md',
  /** A form with two-column rows: onboarding. */
  lg: 'max-w-lg',
  /** A longer record: the return request, the maintenance request. */
  xl: 'max-w-2xl',
} as const;

export type ExternalWidth = keyof typeof WIDTH;

export interface ExternalShellProps {
  children: React.ReactNode;
  width?: ExternalWidth;
  /**
   * An optional bar above the column, for the pages that already show the
   * brand link and the theme menu (invite, onboarding). It is drawn as the
   * page's banner (a <header> outside the main column). Most external pages
   * show neither and follow the device theme.
   */
  topBar?: React.ReactNode;
  /** The "Powered by StockPilot" line, on the pages that print it today. */
  poweredBy?: boolean;
  /**
   * `page` (default) draws the whole page: ground, column and footer.
   * `column` draws only the column, for a page whose layout already draws the
   * ground and the footer (/r/track and /r/confirm sit in app/r/layout.tsx).
   */
  frame?: 'page' | 'column';
  /** The column's element: `main` by default; a page inside a layout that
   *  already has a `main` passes `div`. */
  as?: 'main' | 'div';
  className?: string;
}

export function ExternalShell({
  children,
  width = 'md',
  topBar,
  poweredBy = false,
  frame = 'page',
  as = 'main',
  className,
}: ExternalShellProps) {
  const Column = as;
  const column = (
    <Column
      data-slot="external-column"
      className={cn(
        'mx-auto w-full min-w-0',
        WIDTH[width],
        frame === 'page' ? 'flex-1 px-4 py-8 sm:px-6 sm:py-12' : 'py-6',
        className,
      )}
    >
      {children}
    </Column>
  );
  if (frame === 'column') return column;
  return (
    <div
      data-slot="external-shell"
      className="bg-background text-foreground flex min-h-screen flex-col"
    >
      {/* A <header> outside the column's <main>: the page's banner landmark,
          as the invite and onboarding pages had before the shared frame. */}
      {topBar ? (
        <header
          data-slot="external-top-bar"
          className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-4 sm:px-6"
        >
          {topBar}
        </header>
      ) : null}
      {column}
      {poweredBy ? <ExternalFooter className={WIDTH[width]} /> : null}
    </div>
  );
}

/** "Powered by StockPilot", the footer line of the token pages. */
export function ExternalFooter({ className }: { className?: string }) {
  return (
    <footer
      data-slot="external-footer"
      className={cn(
        'text-muted-foreground mx-auto w-full px-4 pb-10 text-center text-[11px] sm:px-6',
        className,
      )}
    >
      Powered by StockPilot
    </footer>
  );
}

/** The small uppercase line above a title ("StockPilot", "Return request"). */
export function ExternalEyebrow({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="external-eyebrow"
      className={cn(
        'text-muted-foreground text-[11px] font-medium uppercase leading-[16.5px] tracking-[0.1em]',
        className,
      )}
      {...props}
    />
  );
}

export interface ExternalHeaderProps {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** `center` (default) for the one-card pages; `start` for a longer record. */
  align?: 'center' | 'start';
  /** A rule under the header (the return request's look). */
  divided?: boolean;
  /** Anything else under the description. */
  children?: React.ReactNode;
  className?: string;
}

/**
 * The page's title block: eyebrow, the page's only h1 (Inter Tight 26 / 500,
 * the reference's record heading) and the line under it.
 */
export function ExternalHeader({
  eyebrow,
  title,
  description,
  align = 'center',
  divided = false,
  children,
  className,
}: ExternalHeaderProps) {
  return (
    <header
      data-slot="external-header"
      className={cn(
        align === 'center' ? 'text-center' : 'text-left',
        divided && 'border-border border-b pb-6',
        className,
      )}
    >
      {eyebrow ? <ExternalEyebrow className="mb-1.5">{eyebrow}</ExternalEyebrow> : null}
      <h1 className="text-foreground font-display text-[26px] font-medium leading-[1.2] tracking-[-0.025em] [overflow-wrap:anywhere]">
        {title}
      </h1>
      {description ? (
        <div
          className={cn(
            'text-muted-foreground mt-2 text-[13.5px] leading-[20.25px]',
            align === 'center' ? 'mx-auto max-w-[52ch]' : 'max-w-[56ch]',
          )}
        >
          {description}
        </div>
      ) : null}
      {children}
    </header>
  );
}

export interface ExternalCardProps extends Omit<React.ComponentProps<'section'>, 'title'> {
  /** An optional header line (13.5 / 500) over a hairline. */
  title?: React.ReactNode;
  headingLevel?: 2 | 3;
  /** Body padding: `md` 18 px (default), `lg` 24 px for a lone status card. */
  padding?: 'md' | 'lg';
}

/** A flat card (DESIGN-SPEC 6.7): the elevated surface, a hairline, radius 8. */
export function ExternalCard({
  title,
  headingLevel = 2,
  padding = 'md',
  className,
  children,
  ...props
}: ExternalCardProps) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3';
  return (
    <section
      data-slot="external-card"
      className={cn(
        'border-border bg-card text-card-foreground min-w-0 rounded-lg border',
        className,
      )}
      {...props}
    >
      {title != null ? (
        <div className="border-border border-b px-[18px] py-3.5">
          <Heading className="text-foreground text-[13.5px] font-medium leading-5">{title}</Heading>
        </div>
      ) : null}
      <div className={padding === 'lg' ? 'p-6' : 'p-[18px]'}>{children}</div>
    </section>
  );
}

export interface ExternalStatusCardProps {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  /** The page's one way out: a link button, a sign-in link. */
  action?: React.ReactNode;
  /** Extra content between the body and the action (a Request ID card). */
  children?: React.ReactNode;
  /** 1 (default) when the card IS the page; 2 under another heading. */
  headingLevel?: 1 | 2;
  className?: string;
}

/**
 * A page that only says where things stand: an invalid or used link, a
 * confirmed request, a busy page, the portal's sign-in prompt. Eyebrow,
 * title, the page's own sentence and at most one action, centred in a card.
 */
export function ExternalStatusCard({
  eyebrow,
  title,
  body,
  action,
  children,
  headingLevel = 1,
  className,
}: ExternalStatusCardProps) {
  const Heading = `h${headingLevel}` as 'h1' | 'h2';
  return (
    <section
      data-slot="external-status-card"
      className={cn(
        'border-border bg-card text-card-foreground rounded-lg border px-6 py-8 text-center',
        className,
      )}
    >
      {eyebrow ? <ExternalEyebrow className="mb-1.5">{eyebrow}</ExternalEyebrow> : null}
      <Heading className="text-foreground font-display text-[22px] font-medium leading-[1.25] tracking-[-0.02em] [overflow-wrap:anywhere]">
        {title}
      </Heading>
      {body ? (
        <div className="text-muted-foreground mx-auto mt-2 max-w-[52ch] text-[13.5px] leading-[20.25px]">
          {body}
        </div>
      ) : null}
      {children != null ? <div className="mt-5 text-left">{children}</div> : null}
      {action ? <div className="mt-6 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </section>
  );
}
