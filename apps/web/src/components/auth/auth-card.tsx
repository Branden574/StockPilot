import type { ReactNode } from 'react';

interface AuthCardProps {
  /** The small uppercase line above the title ("Sign in", "Two-factor"). */
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  /** The form or the message; a card that is only a title and a sentence
   *  (the MFA factor-list error) passes nothing and draws no empty body. */
  children?: ReactNode;
}

/**
 * The shared panel behind every auth screen, and the card the invite and
 * onboarding pages draw too, so an invitee sees the same product as /signin.
 * Restyling this one component upgrades /signin, /signin/mfa, /signup,
 * /reset, /reset/complete and /account-disabled together, without touching a
 * line of authentication logic.
 *
 * Redesign (P5.1): a flat card (DESIGN-SPEC 6.7: the elevated surface, one
 * hairline, radius 8, no shadow), the reference eyebrow (11 / 500, uppercase,
 * +0.1em) over an Inter Tight 26 / 500 title, and the footer on the sunk
 * surface. Kept from before:
 *  - an opaque surface, never a translucent one: a see-through panel puts the
 *    field edges and placeholders at low contrast under warehouse lighting;
 *  - a LEFT-ALIGNED header, so the eye enters on a left rule and scans
 *    straight down the labels;
 *  - no headline, illustration, testimonial or value proposition: the job of
 *    this screen is to get someone into the app quickly.
 */
export function AuthCard({ eyebrow, title, description, footer, children }: AuthCardProps) {
  return (
    <section
      data-slot="auth-card"
      className="border-border bg-card text-card-foreground rounded-lg border"
    >
      <header className="px-6 pt-6">
        {eyebrow ? (
          <p className="text-muted-foreground mb-1.5 text-[11px] font-medium uppercase leading-[16.5px] tracking-[0.1em]">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="font-display text-foreground text-[26px] font-medium leading-[1.2] tracking-[-0.025em] [overflow-wrap:anywhere]">
          {title}
        </h1>
        {description ? (
          <p className="text-muted-foreground mt-2 text-[13.5px] leading-[20.25px]">
            {description}
          </p>
        ) : null}
      </header>

      {children != null && children !== false ? (
        <div className="space-y-4 px-6 py-6">{children}</div>
      ) : (
        <div className="pb-6" />
      )}

      {footer ? (
        <div className="border-border bg-sunk text-muted-foreground rounded-b-lg border-t px-6 py-4 text-[13px]">
          {footer}
        </div>
      ) : null}
    </section>
  );
}
