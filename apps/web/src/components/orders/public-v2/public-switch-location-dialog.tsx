'use client';

import { X } from 'lucide-react';
import * as React from 'react';

/**
 * "Switch location?": the confirm before a warehouse switch empties the cart
 * on the public order page (/r/<token>). A styled dialog on the storefront's
 * sf-modal, not window.confirm(), which iOS webviews block. The switch itself
 * is the caller's (a hard reload with ?w=<warehouse>).
 *
 * Redesign P5.1 step B, defect fixed: the dialog declared role="dialog" and
 * aria-modal="true" but did neither thing that promises. Focus stayed behind
 * it (the warehouse option that opened it had already closed with its
 * popover, so focus fell to the page), Tab walked out into the page and
 * Escape did nothing. Now Cancel takes focus when it opens, Tab and Shift+Tab
 * stay inside, Escape is Cancel, and the caller hands focus back to the
 * Location cell after a cancel (onCancel).
 */
export function PublicSwitchLocationDialog({
  onCancel,
  onConfirm,
}: {
  /** Keep the cart and this location (Cancel, Close, Escape, the backdrop). */
  onCancel: () => void;
  /** Switch and clear the cart. */
  onConfirm: () => void;
}) {
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled])'));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="sf-modal-bk" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="sf-modal"
        style={{ width: 'min(420px, 100%)' }}
        role="dialog"
        aria-modal="true"
        aria-label="Switch location?"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sf-modal-head">
          <h3>Switch location?</h3>
          <button type="button" className="sf-icon-btn x" onClick={onCancel} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="sf-modal-body">
          <p className="sfp-modal-copy">
            Your cart has items in it. Switching locations will clear them so the new
            location&apos;s catalog can load.
          </p>
        </div>
        <div className="sf-modal-foot">
          <span className="grow2" />
          <button ref={cancelRef} type="button" className="sf-btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="sf-btn-go" onClick={onConfirm}>
            Switch and clear cart
          </button>
        </div>
      </div>
    </div>
  );
}
