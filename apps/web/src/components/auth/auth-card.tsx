import type { ReactNode } from 'react';

interface AuthCardProps {
  /** Mono, uppercase, tracked — the device that ties auth to the landing page. */
  eyebrow?: string;
  title: string;
  description?: string;
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * The shared panel behind every auth screen. Restyling this one component
 * upgrades /signin, /signin/mfa, /signup, /reset, /reset/complete and
 * /account-disabled together — which is why the whole flow can be made
 * consistent without touching a line of authentication logic.
 *
 * Changes from the previous version, and why:
 *  - `shadow-xl` + `backdrop-blur` + `bg-card/80` are gone. A translucent panel
 *    puts the field boundary and the placeholder at low contrast, which is
 *    exactly wrong under warehouse lighting. Opaque surface, one hairline
 *    border, one restrained shadow.
 *  - The header is LEFT-ALIGNED rather than centred, so the eye has a left rule
 *    to enter on and scan straight down the labels. Centred header text over a
 *    left-aligned form is the thing that makes an auth screen feel unresolved.
 *  - A mono eyebrow sits above the title. This is the continuity device shared
 *    with the landing page, which uses the same mono/uppercase/tracked treatment
 *    over a display-font heading. It is what makes the two surfaces read as one
 *    product rather than a marketing site bolted to a login form.
 *
 * Deliberately NOT here: any headline, illustration, testimonial or value prop.
 * The job of this screen is to get someone into the app quickly.
 */
export function AuthCard({ eyebrow, title, description, footer, children }: AuthCardProps) {
  return (
    <section className="rounded-xl border border-border bg-card shadow-[0_1px_2px_hsl(var(--foreground)/0.04),0_8px_24px_-12px_hsl(var(--foreground)/0.10)]">
      <header className="space-y-1.5 px-6 pt-6">
        {eyebrow ? (
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent-foreground/80">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="font-display text-[1.625rem] font-semibold leading-tight tracking-tight">
          {title}
        </h1>
        {description ? (
          <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </header>

      <div className="space-y-4 px-6 py-6">{children}</div>

      {footer ? (
        <div className="border-t border-border bg-muted/30 px-6 py-4 text-sm text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </section>
  );
}
