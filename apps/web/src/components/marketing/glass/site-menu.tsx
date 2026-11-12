'use client';

import { ChevronRight, Menu, X } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { INVITE_ONLY_NOTE, SIGN_IN_PATH, type SiteLink, type SitePage } from './site-links';
import { buttonClass } from './ui';

import { capture } from '@/lib/analytics';

const MENU_ID = 'lgs-site-menu';

interface MenuState {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
}

const MenuContext = React.createContext<MenuState | null>(null);

function useMenu(): MenuState {
  const state = React.useContext(MenuContext);
  if (!state) throw new Error('SiteMenuButton and SiteMenuPanel need a SiteMenuRoot around them');
  return state;
}

/**
 * The phone menu of SiteNav.dc.html (below 900 px), in three parts so the
 * panel can sit where the board draws it: the button inside the nav bar's
 * right-hand row, and the panel as the nav's next sibling inside the
 * navbar (`div.s-navbar > nav.s-nav + div#site-menu`), in flow below the bar.
 * A panel inside the nav would be laid out as a flex item of that row, and
 * the blurred nav would be its backdrop root, so it could not frost the page.
 *
 * SiteMenuRoot renders the navbar element itself and holds the state; the
 * nav between the two parts stays server-rendered.
 *
 * Open menu / Close menu, the five links as 52 px rows, Contact the team,
 * Sign in and the invite-only line. Escape (focus back on the button) and
 * any link close it. The button is hidden until the glass CSS shows it, so
 * without JavaScript the nav's own links stay in view instead of a button
 * that cannot open anything. On the landing, Sign in sends the classic
 * landing menu's analytics event (where: "menu-signin").
 */
export function SiteMenuRoot({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}) {
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

  const value = React.useMemo<MenuState>(() => ({ open, setOpen, buttonRef }), [open]);
  return (
    <MenuContext.Provider value={value}>
      <div className={className}>{children}</div>
    </MenuContext.Provider>
  );
}

/** The Open menu / Close menu button, in the nav bar's right-hand row. */
export function SiteMenuButton() {
  const { open, setOpen, buttonRef } = useMenu();
  return (
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
  );
}

/** The open panel, the nav's next sibling: in flow below the bar, as drawn. */
export function SiteMenuPanel({ links, active }: { links: readonly SiteLink[]; active: SitePage }) {
  const { open, setOpen } = useMenu();
  if (!open) return null;
  const close = () => setOpen(false);
  return (
    <div id={MENU_ID} className="lgs-menu flex flex-col gap-1 p-2.5">
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
  );
}
