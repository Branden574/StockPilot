'use client';

import { ChevronRight, Menu, X } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { INVITE_ONLY_NOTE, SIGN_IN_PATH, type SiteLink, type SitePage } from './site-links';
import { buttonClass } from './ui';

import { capture } from '@/lib/analytics';

const MENU_ID = 'lgs-site-menu';

/**
 * The phone menu of SiteNav.dc.html (below 900 px): Open menu / Close menu,
 * the five links as 52 px rows, Contact the team, Sign in, and the
 * invite-only line. Escape (focus back on the button) and any link close it.
 * The button is hidden until the glass CSS shows it, so without JavaScript
 * the nav's own links stay in view instead of a button that cannot open
 * anything. On the landing, Sign in sends the classic landing menu's
 * analytics event (where: "menu-signin").
 */
export function SiteMenu({ links, active }: { links: readonly SiteLink[]; active: SitePage }) {
  const [open, setOpen] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      // Focus returns to the button that opened the menu.
      buttonRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="lgs-menu-btn hidden size-9 items-center justify-center rounded-full"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls={MENU_ID}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <X className="size-[18px]" aria-hidden="true" />
        ) : (
          <Menu className="size-[18px]" aria-hidden="true" />
        )}
      </button>
      {open ? (
        <div
          id={MENU_ID}
          className="lgs-menu absolute inset-x-3 top-full mt-2 flex flex-col gap-1 p-2.5"
        >
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={link.page === active ? 'page' : undefined}
              onClick={close}
              className="lgs-menu-row flex min-h-[52px] items-center justify-between rounded-[14px] px-3.5 text-[17px] font-semibold"
            >
              {link.label}
              <ChevronRight className="size-5" aria-hidden="true" />
            </Link>
          ))}
          <div className="lgs-hr mx-2 my-1.5 h-px" aria-hidden="true" />
          <Link
            href="/contact"
            onClick={close}
            className={`${buttonClass('secondary', 'lg', false)} w-full`}
          >
            Contact the team
          </Link>
          <a
            href={SIGN_IN_PATH}
            className={`${buttonClass('primary', 'lg', false)} w-full`}
            onClick={
              active === 'home'
                ? () => capture('landing_app_entry_clicked', { where: 'menu-signin' })
                : undefined
            }
          >
            Sign in
          </a>
          <p className="lgs-menu-note px-0 pb-0.5 pt-1.5 text-center text-xs">{INVITE_ONLY_NOTE}</p>
        </div>
      ) : null}
    </>
  );
}
