'use client';

import { Check, ChevronsUpDown, UserCircle } from 'lucide-react';
import * as React from 'react';

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
}

export function BorrowerPicker({
  members,
  value,
  onChange,
  disabled = false,
}: BorrowerPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [inputValue, setInputValue] = React.useState(value.borrowerName);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Sync external value changes (e.g. warehouse switch resets form)
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync external prop into local input mirror
    setInputValue(value.borrowerName);
  }, [value.borrowerName]);

  // Close dropdown when clicking outside
  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const query = inputValue.trim().toLowerCase();

  const filteredMembers = query
    ? members.filter(
        (m) =>
          m.displayName.toLowerCase().includes(query) ||
          (m.email?.toLowerCase().includes(query) ?? false),
      )
    : members;

  const hasTyped = inputValue.trim().length > 0;
  // Only show free-text option when input doesn't exactly match a selected member
  const showFreeText = hasTyped && !value.borrowerUserId;

  function selectMember(member: Member) {
    onChange({
      borrowerUserId: member.userId,
      borrowerName: member.displayName,
      borrowerEmail: member.email,
    });
    setInputValue(member.displayName);
    setOpen(false);
  }

  function selectFreeText() {
    const name = inputValue.trim();
    if (!name) return;
    onChange({
      borrowerUserId: null,
      borrowerName: name,
      borrowerEmail: null,
    });
    setOpen(false);
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setInputValue(v);
    // If user is typing freely, clear member selection
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
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Input
          value={inputValue}
          onChange={handleInputChange}
          onFocus={() => setOpen(true)}
          placeholder="Search members or type a name…"
          disabled={disabled}
          className="pr-8"
          autoComplete="off"
        />
        <ChevronsUpDown className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg overflow-hidden">
          <ul
            className="max-h-56 overflow-y-auto py-1 text-sm"
            role="listbox"
            aria-label="Borrower suggestions"
          >
            {filteredMembers.map((member) => {
              const isSelected = value.borrowerUserId === member.userId;
              return (
                <li
                  key={member.userId}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => selectMember(member)}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 cursor-pointer select-none',
                    isSelected
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-muted',
                  )}
                >
                  <UserCircle className="h-4 w-4 flex-none text-muted-foreground" />
                  <span className="flex-1 min-w-0">
                    <span className="font-medium truncate block">{member.displayName}</span>
                    {member.email ? (
                      <span className="text-[11px] text-muted-foreground truncate block">
                        {member.email}
                      </span>
                    ) : null}
                  </span>
                  {isSelected ? <Check className="h-3.5 w-3.5 flex-none" /> : null}
                </li>
              );
            })}

            {filteredMembers.length === 0 && !showFreeText && (
              <li className="px-3 py-2 text-muted-foreground text-sm">
                No members found.
              </li>
            )}

            {/* Free-text option — always at bottom when there's a typed value */}
            {hasTyped && (
              <li
                role="option"
                aria-selected={false}
                onClick={selectFreeText}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 cursor-pointer select-none border-t border-border/50 text-muted-foreground',
                  !value.borrowerUserId && value.borrowerName === inputValue.trim()
                    ? 'bg-muted'
                    : 'hover:bg-muted',
                )}
              >
                <span className="italic truncate">
                  Use as typed: &ldquo;{inputValue.trim()}&rdquo;
                </span>
              </li>
            )}
          </ul>
        </div>
      )}

      {/* Member indicator */}
      {value.borrowerUserId && (
        <p className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">
          Team member selected — name auto-filled.
        </p>
      )}
    </div>
  );
}
