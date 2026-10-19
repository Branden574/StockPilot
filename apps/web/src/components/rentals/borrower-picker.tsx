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
  // The chosen value, for aria-selected: a picked member, or someone not in
  // StockPilot once a name is in. The highlight is aria-activedescendant.
  const someoneElseChosen = !isMember && value.borrowerName.trim().length > 0;
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
    onChange({
      borrowerUserId: null,
      borrowerName: typed,
      borrowerEmail: value.borrowerEmail ?? null,
    });
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
  const emailInvalid =
    emailTouched && email.trim().length > 0 && !isBorrowerEmailFormat(email.trim());

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
            // A click opens the list too. Focus alone is not enough: after a
            // pick (the list keeps focus in this box) or Escape, the box is
            // still focused, so clicking it fires no focus event.
            onClick={() => setOpen(true)}
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
          <ChevronsUpDown className="text-muted-foreground pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
        </div>

        {open && (
          <div className="border-border bg-popover text-popover-foreground absolute z-50 mt-1 w-full overflow-hidden rounded-md border shadow-lg">
            <ul
              id={listId}
              className="max-h-64 overflow-y-auto py-1 text-sm"
              role="listbox"
              aria-label="Borrower suggestions"
              // Out of the Tab order. Chrome makes a scrolling box with no
              // focusable children a Tab stop, so with a long member list Tab
              // from the name box landed here, inside the picker, and the list
              // stayed open over the email field. The options are reached
              // with the arrow keys from the name box.
              tabIndex={-1}
              // Keep focus in the name box while choosing, so the list does
              // not close under the pointer before the click lands.
              onMouseDown={(e) => e.preventDefault()}
            >
              {/* Someone not in StockPilot: ALWAYS first. */}
              <li
                id={optionId(0)}
                role="option"
                aria-selected={someoneElseChosen}
                onClick={() => selectOption(0)}
                className={cn(
                  'border-border flex cursor-pointer select-none items-start gap-2 border-b px-3 py-2',
                  activeIndex === 0 ? 'bg-muted' : 'hover:bg-muted',
                )}
              >
                <UserPlus className="text-muted-foreground mt-0.5 h-4 w-4 flex-none" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {!isMember && typed ? (
                      <>Someone else: &ldquo;{typed}&rdquo;</>
                    ) : (
                      'Someone not in StockPilot'
                    )}
                  </span>
                  <span className="text-muted-foreground block text-[12px] leading-[18px]">
                    {!isMember && typed
                      ? 'Not in StockPilot. Add their email below.'
                      : 'Type their name here, then add their email below.'}
                  </span>
                </span>
                {someoneElseChosen ? <Check className="mt-0.5 h-3.5 w-3.5 flex-none" /> : null}
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
                      'flex cursor-pointer select-none items-center gap-2 px-3 py-2',
                      isSelected
                        ? // The picked member, highlighted: a ring, since the
                          // picked fill would hide the highlight's.
                          cn(
                            'bg-primary text-primary-foreground',
                            activeIndex === index && 'ring-primary-foreground/70 ring-2 ring-inset',
                          )
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
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{member.displayName}</span>
                      {member.email ? (
                        <span
                          className={cn(
                            'block truncate text-[12px] leading-[18px]',
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
                <li role="presentation" className="text-muted-foreground px-3 py-2 text-[12px]">
                  No team member matches &ldquo;{typed}&rdquo;.
                </li>
              ) : null}
            </ul>
          </div>
        )}
      </div>

      {isMember ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-success text-[12px] leading-[18px]">
            Team member selected.
            {value.borrowerEmail ? ` Rental emails go to ${value.borrowerEmail}.` : ''}
          </p>
          <button
            type="button"
            onClick={selectSomeoneElse}
            disabled={disabled}
            className="text-foreground hover:text-muted-foreground inline-flex items-center text-[12px] font-medium underline underline-offset-2 disabled:opacity-50 max-sm:min-h-11"
          >
            Rent to someone not in StockPilot
          </button>
        </div>
      ) : (
        <>
          <p id={hintId} className="text-muted-foreground text-[12px] leading-[18px]">
            Not in StockPilot? Type their name above and add their email below.
          </p>
          <div className="space-y-1">
            <label
              htmlFor={emailId}
              className="text-foreground text-[13px] font-medium leading-none"
            >
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
              <p id={emailErrorId} className="text-destructive text-[12px] leading-[18px]">
                Enter a full email address, like name@example.com, or leave it blank.
              </p>
            ) : null}
            <p id={emailHelpId} className="text-muted-foreground text-[12px] leading-[18px]">
              {RENTAL_BORROWER_EMAIL_HELP}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
