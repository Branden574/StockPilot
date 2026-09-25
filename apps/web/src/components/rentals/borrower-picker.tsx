'use client';

import { Check, ChevronsUpDown, UserCircle, UserPlus } from 'lucide-react';
import * as React from 'react';

import { isBorrowerEmailFormat, RENTAL_BORROWER_EMAIL_HELP } from '@stockpilot/core';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface BorrowerValue {
  borrowerUserId?: string | null;
  borrowerName: string;
  borrowerEmail?: string | null;
}

interface Member {
  userId: string;
  displayName: string;
  email: string | null;
}

interface BorrowerPickerProps {
  members: Member[];
  value: BorrowerValue;
  onChange: (v: BorrowerValue) => void;
  disabled?: boolean;
  /** The name input's id, so the form's `<Label htmlFor>` names it. */
  inputId?: string;
}

/**
 * Who is borrowing: a team member, or ANYONE ELSE.
 *
 * L4L, 2026-09-25: "no way for someone to enter a email thats not in the
 * system". There was a way, but it was hidden: the email field appeared only
 * after a name was typed, under the open member list that covered it, and the
 * only non-member choice was a "Use as typed" row at the BOTTOM of that list.
 * Now, for anyone who is not a picked team member, the email field is always
 * on screen, the list opens with "Someone not in StockPilot" at the TOP, and
 * the line under the name says so.
 *
 * The value is what the rental stores: a picked member carries their user id
 * and their account email; anyone else carries the typed name and, if given,
 * the typed email. Typing after picking a member drops the member AND their
 * email, so a member's address never rides along on someone else's rental.
 */
export function BorrowerPicker({
  members,
  value,
  onChange,
  disabled = false,
  inputId,
}: BorrowerPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [inputValue, setInputValue] = React.useState(value.borrowerName);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [emailTouched, setEmailTouched] = React.useState(false);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const emailRef = React.useRef<HTMLInputElement>(null);
  // Set when the picker moves focus to the name box itself ("Rent to someone
  // not in StockPilot"), so that focus does not pop the member list open.
  const skipOpenOnFocus = React.useRef(false);

  const uid = React.useId();
  const nameId = inputId ?? `${uid}-name`;
  const listId = `${uid}-list`;
  const hintId = `${uid}-hint`;
  const emailId = `${uid}-email`;
  const emailHelpId = `${uid}-email-help`;
  const emailErrorId = `${uid}-email-error`;
  const optionId = (i: number) => `${uid}-option-${i}`;

  // Sync external value changes (e.g. warehouse switch resets form)
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync external prop into local input mirror
    setInputValue(value.borrowerName);
  }, [value.borrowerName]);

  const isMember = Boolean(value.borrowerUserId);
  const typed = inputValue.trim();
  // With a member picked, the box shows their name: list everyone, so the
  // operator can switch, rather than only the member already chosen.
  const query = isMember && inputValue === value.borrowerName ? '' : typed.toLowerCase();
  const filteredMembers = query
    ? members.filter(
        (m) =>
          m.displayName.toLowerCase().includes(query) ||
          (m.email?.toLowerCase().includes(query) ?? false),
      )
    : members;

  // Option 0 is always "someone not in StockPilot"; members follow.
  const optionCount = 1 + filteredMembers.length;

  // Keep the highlighted option in view while arrowing through a long list.
  React.useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${uid}-option-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex, uid]);

  function close() {
    setOpen(false);
    setActiveIndex(-1);
  }

  function selectMember(member: Member) {
    onChange({
      borrowerUserId: member.userId,
      borrowerName: member.displayName,
      borrowerEmail: member.email,
    });
    setInputValue(member.displayName);
    setEmailTouched(false);
    close();
  }

  /** The borrower is not a team member. */
  function selectSomeoneElse() {
    close();
    if (isMember || !typed) {
      // Start a fresh non-member borrower: no name yet, and never the
      // member's email.
      if (isMember) {
        onChange({ borrowerUserId: null, borrowerName: '', borrowerEmail: null });
        setInputValue('');
        setEmailTouched(false);
      }
      if (nameRef.current && document.activeElement !== nameRef.current) {
        skipOpenOnFocus.current = true;
        nameRef.current.focus();
      }
      return;
    }
    onChange({ borrowerUserId: null, borrowerName: typed, borrowerEmail: value.borrowerEmail ?? null });
    setInputValue(typed);
    // The name is in: the email is the next thing to fill.
    emailRef.current?.focus();
  }

  function selectOption(index: number) {
    if (index === 0) selectSomeoneElse();
    else {
      const member = filteredMembers[index - 1];
      if (member) selectMember(member);
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setInputValue(v);
    // Typing over a picked member makes this someone else: drop the member
    // and their email.
    if (value.borrowerUserId) {
      onChange({
        borrowerUserId: null,
        borrowerName: v,
        borrowerEmail: null,
      });
    } else {
      onChange({ ...value, borrowerName: v });
    }
    setOpen(true);
    setActiveIndex(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i + 1) % optionCount);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i <= 0 ? optionCount - 1 : i - 1));
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      if (activeIndex >= 0) selectOption(activeIndex);
      // Nothing highlighted: a typed name is kept as typed (someone else); a
      // picked member stays picked.
      else if (!isMember && typed) selectSomeoneElse();
      else close();
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      close();
    }
  }

  const email = value.borrowerEmail ?? '';
  const emailInvalid = emailTouched && email.trim().length > 0 && !isBorrowerEmailFormat(email.trim());

  return (
    <div className="space-y-2">
      <div
        className="relative"
        // Close when focus leaves the name box and its list (Tab to the email
        // field used to leave the list open on top of it).
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close();
        }}
      >
        <div className="relative">
          <Input
            ref={nameRef}
            id={nameId}
            value={inputValue}
            onChange={handleInputChange}
            onFocus={() => {
              if (skipOpenOnFocus.current) {
                skipOpenOnFocus.current = false;
                return;
              }
              setOpen(true);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search members, or type anyone's name"
            disabled={disabled}
            className="pr-8"
            autoComplete="off"
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-describedby={isMember ? undefined : hintId}
          />
          <ChevronsUpDown className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        </div>

        {open && (
          <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-lg overflow-hidden">
            <ul
              id={listId}
              className="max-h-64 overflow-y-auto py-1 text-sm"
              role="listbox"
              aria-label="Borrower suggestions"
              // Keep focus in the name box while choosing, so the list does
              // not close under the pointer before the click lands.
              onMouseDown={(e) => e.preventDefault()}
            >
              {/* Someone not in StockPilot: ALWAYS first. */}
              <li
                id={optionId(0)}
                role="option"
                aria-selected={activeIndex === 0}
                onClick={() => selectOption(0)}
                className={cn(
                  'flex items-start gap-2 px-3 py-2 cursor-pointer select-none border-b border-border/50',
                  activeIndex === 0 ? 'bg-muted' : 'hover:bg-muted',
                )}
              >
                <UserPlus className="mt-0.5 h-4 w-4 flex-none text-muted-foreground" />
                <span className="flex-1 min-w-0">
                  <span className="font-medium truncate block">
                    {!isMember && typed ? (
                      <>Someone else: &ldquo;{typed}&rdquo;</>
                    ) : (
                      'Someone not in StockPilot'
                    )}
                  </span>
                  <span className="text-[11px] text-muted-foreground block">
                    {!isMember && typed
                      ? 'Not in StockPilot. Add their email below.'
                      : 'Type their name here, then add their email below.'}
                  </span>
                </span>
              </li>

              {filteredMembers.map((member, i) => {
                const index = i + 1;
                const isSelected = value.borrowerUserId === member.userId;
                return (
                  <li
                    key={member.userId}
                    id={optionId(index)}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => selectOption(index)}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2 cursor-pointer select-none',
                      isSelected
                        ? 'bg-primary text-primary-foreground'
                        : activeIndex === index
                          ? 'bg-muted'
                          : 'hover:bg-muted',
                    )}
                  >
                    <UserCircle
                      className={cn(
                        'h-4 w-4 flex-none',
                        isSelected ? 'text-primary-foreground' : 'text-muted-foreground',
                      )}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="font-medium truncate block">{member.displayName}</span>
                      {member.email ? (
                        <span
                          className={cn(
                            'text-[11px] truncate block',
                            isSelected ? 'text-primary-foreground/80' : 'text-muted-foreground',
                          )}
                        >
                          {member.email}
                        </span>
                      ) : null}
                    </span>
                    {isSelected ? <Check className="h-3.5 w-3.5 flex-none" /> : null}
                  </li>
                );
              })}

              {filteredMembers.length === 0 && query ? (
                <li role="presentation" className="px-3 py-2 text-[12px] text-muted-foreground">
                  No team member matches &ldquo;{typed}&rdquo;.
                </li>
              ) : null}
            </ul>
          </div>
        )}
      </div>

      {isMember ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-[11px] text-emerald-700 dark:text-emerald-400">
            Team member selected.
            {value.borrowerEmail ? ` Rental emails go to ${value.borrowerEmail}.` : ''}
          </p>
          <button
            type="button"
            onClick={selectSomeoneElse}
            disabled={disabled}
            className="text-[11px] font-medium text-foreground underline underline-offset-2 hover:text-muted-foreground disabled:opacity-50"
          >
            Rent to someone not in StockPilot
          </button>
        </div>
      ) : (
        <>
          <p id={hintId} className="text-[11px] text-muted-foreground">
            Not in StockPilot? Type their name above and add their email below.
          </p>
          <div className="space-y-1">
            <label htmlFor={emailId} className="text-[12px] font-medium text-foreground">
              Borrower email (optional)
            </label>
            <Input
              ref={emailRef}
              id={emailId}
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) =>
                onChange({
                  ...value,
                  borrowerUserId: null,
                  borrowerEmail: e.target.value.length > 0 ? e.target.value : null,
                })
              }
              onBlur={() => setEmailTouched(true)}
              placeholder="name@example.com"
              disabled={disabled}
              autoComplete="off"
              className={emailInvalid ? 'border-destructive' : undefined}
              aria-invalid={emailInvalid || undefined}
              aria-describedby={emailInvalid ? `${emailErrorId} ${emailHelpId}` : emailHelpId}
            />
            {emailInvalid ? (
              <p id={emailErrorId} className="text-[11px] text-destructive">
                Enter a full email address, like name@example.com, or leave it blank.
              </p>
            ) : null}
            <p id={emailHelpId} className="text-[11px] text-muted-foreground">
              {RENTAL_BORROWER_EMAIL_HELP}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
