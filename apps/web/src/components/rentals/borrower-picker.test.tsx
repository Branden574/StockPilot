import { act, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RENTAL_BORROWER_EMAIL_HELP } from '@stockpilot/core';

import { BorrowerPicker, type BorrowerValue } from './borrower-picker';

// ═══ A BORROWER WHO IS NOT IN STOCKPILOT IS EASY TO ENTER ═══
//
// L4L, 2026-09-25: "no way for someone to enter a email thats not in the
// system what if we have someone else from a site who needs to rent
// something". The rental has always stored a non-member borrower's name and
// email; the picker hid the email field until a name was typed, under the open
// member list, behind a "Use as typed" row at the bottom of it.

const MEMBERS = [
  { userId: 'u-jane', displayName: 'Jane Doe', email: 'jane@l4l.org' },
  { userId: 'u-ravi', displayName: 'Ravi Patel', email: 'ravi@l4l.org' },
];

const EMPTY: BorrowerValue = { borrowerUserId: null, borrowerName: '', borrowerEmail: null };

function renderPicker(initial: BorrowerValue = EMPTY) {
  const changes: BorrowerValue[] = [];
  function Harness() {
    const [value, setValue] = React.useState<BorrowerValue>(initial);
    return (
      <>
        <label htmlFor="rental-borrower">Borrower</label>
        <BorrowerPicker
          inputId="rental-borrower"
          members={MEMBERS}
          value={value}
          onChange={(v) => {
            changes.push(v);
            setValue(v);
          }}
        />
        <button type="button">Elsewhere</button>
      </>
    );
  }
  render(<Harness />);
  return { changes, last: () => changes.at(-1) };
}

const nameBox = () => screen.getByRole('combobox', { name: 'Borrower' });
const emailBox = () => screen.queryByLabelText('Borrower email (optional)') as HTMLInputElement | null;
const list = () => screen.queryByRole('listbox', { name: 'Borrower suggestions' });
const options = () => within(list()!).getAllByRole('option');

describe('BorrowerPicker', () => {
  it('shows the email field and what it is for before anything is typed', () => {
    renderPicker();
    expect((nameBox() as HTMLInputElement).placeholder).toBe(
      "Search members, or type anyone's name",
    );
    expect(emailBox()).not.toBeNull();
    expect(emailBox()!.type).toBe('email');
    expect(
      screen.getByText('Not in StockPilot? Type their name above and add their email below.'),
    ).toBeTruthy();
    expect(screen.getByText(RENTAL_BORROWER_EMAIL_HELP)).toBeTruthy();
    // The help is the field's description, for screen readers too.
    const describedBy = emailBox()!.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(RENTAL_BORROWER_EMAIL_HELP);
  });

  it('opens with "Someone not in StockPilot" at the top, then the members', () => {
    renderPicker();
    fireEvent.focus(nameBox());
    expect(nameBox().getAttribute('aria-expanded')).toBe('true');
    const [first, ...rest] = options();
    expect(first!.textContent).toContain('Someone not in StockPilot');
    expect(rest.map((o) => o.textContent)).toEqual([
      'Jane Doejane@l4l.org',
      'Ravi Patelravi@l4l.org',
    ]);
  });

  it('member pick: the member, their account email, and no email field', () => {
    const { last } = renderPicker();
    fireEvent.focus(nameBox());
    fireEvent.click(screen.getByRole('option', { name: /Jane Doe/ }));

    expect(last()).toEqual({
      borrowerUserId: 'u-jane',
      borrowerName: 'Jane Doe',
      borrowerEmail: 'jane@l4l.org',
    });
    expect(list()).toBeNull();
    expect(emailBox()).toBeNull();
    expect(screen.getByText(/Team member selected\. Rental emails go to jane@l4l\.org\./)).toBeTruthy();
  });

  it('typed name: kept as typed, offered first as "Someone else", then the email is next', () => {
    const { last } = renderPicker();
    fireEvent.focus(nameBox());
    fireEvent.change(nameBox(), { target: { value: 'Pat Visitor' } });

    // The typed name is already the borrower; nothing else to click.
    expect(last()).toEqual({ borrowerUserId: null, borrowerName: 'Pat Visitor', borrowerEmail: null });
    expect(options()[0]!.textContent).toContain('Someone else: “Pat Visitor”');
    expect(screen.getByText('No team member matches “Pat Visitor”.')).toBeTruthy();

    fireEvent.click(options()[0]!);
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(emailBox());
    expect(last()).toEqual({ borrowerUserId: null, borrowerName: 'Pat Visitor', borrowerEmail: null });
  });

  it('email: stored as typed, format-checked when the field is left, optional', () => {
    const { last } = renderPicker();
    fireEvent.change(nameBox(), { target: { value: 'Pat Visitor' } });
    fireEvent.change(emailBox()!, { target: { value: 'pat@site' } });
    expect(last()).toEqual({
      borrowerUserId: null,
      borrowerName: 'Pat Visitor',
      borrowerEmail: 'pat@site',
    });
    // No complaint while typing.
    expect(screen.queryByText(/Enter a full email address/)).toBeNull();

    fireEvent.blur(emailBox()!);
    expect(screen.getByText('Enter a full email address, like name@example.com, or leave it blank.')).toBeTruthy();
    expect(emailBox()!.getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(emailBox()!, { target: { value: 'pat@site.org' } });
    expect(screen.queryByText(/Enter a full email address/)).toBeNull();
    expect(emailBox()!.getAttribute('aria-invalid')).toBeNull();
    expect(last()?.borrowerEmail).toBe('pat@site.org');

    // Blank is fine: the email is optional.
    fireEvent.change(emailBox()!, { target: { value: '' } });
    expect(last()?.borrowerEmail).toBeNull();
    expect(screen.queryByText(/Enter a full email address/)).toBeNull();
  });

  it('switching back to a member drops the typed email; switching away starts clean', () => {
    const { last } = renderPicker();
    fireEvent.change(nameBox(), { target: { value: 'Pat Visitor' } });
    fireEvent.change(emailBox()!, { target: { value: 'pat@site.org' } });

    fireEvent.change(nameBox(), { target: { value: 'Rav' } });
    fireEvent.click(screen.getByRole('option', { name: /Ravi Patel/ }));
    expect(last()).toEqual({
      borrowerUserId: 'u-ravi',
      borrowerName: 'Ravi Patel',
      borrowerEmail: 'ravi@l4l.org',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Rent to someone not in StockPilot' }));
    expect(last()).toEqual({ borrowerUserId: null, borrowerName: '', borrowerEmail: null });
    expect(emailBox()!.value).toBe('');
    expect((nameBox() as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(nameBox());
    // Focus moved there by the button: the member list stays shut.
    expect(list()).toBeNull();
  });

  it("typing over a picked member makes it someone else, without the member's email", () => {
    const { last } = renderPicker({
      borrowerUserId: 'u-jane',
      borrowerName: 'Jane Doe',
      borrowerEmail: 'jane@l4l.org',
    });
    fireEvent.change(nameBox(), { target: { value: 'Jane Doe (site lead)' } });
    expect(last()).toEqual({
      borrowerUserId: null,
      borrowerName: 'Jane Doe (site lead)',
      borrowerEmail: null,
    });
    expect(emailBox()!.value).toBe('');
  });

  it('with a member picked, the list shows every member to switch to', () => {
    renderPicker({ borrowerUserId: 'u-jane', borrowerName: 'Jane Doe', borrowerEmail: 'jane@l4l.org' });
    fireEvent.focus(nameBox());
    expect(options()).toHaveLength(3);
    expect(screen.getByRole('option', { name: /Jane Doe/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('keyboard: arrows move through the options, Enter picks, Escape closes', () => {
    const { last } = renderPicker();
    fireEvent.focus(nameBox());
    fireEvent.keyDown(nameBox(), { key: 'ArrowDown' });
    fireEvent.keyDown(nameBox(), { key: 'ArrowDown' });
    const active = nameBox().getAttribute('aria-activedescendant');
    expect(document.getElementById(active!)?.textContent).toContain('Jane Doe');
    fireEvent.keyDown(nameBox(), { key: 'Enter' });
    expect(last()?.borrowerUserId).toBe('u-jane');
    expect(list()).toBeNull();

    // Enter with nothing highlighted keeps a picked member.
    fireEvent.focus(nameBox());
    fireEvent.keyDown(nameBox(), { key: 'Enter' });
    expect(last()?.borrowerUserId).toBe('u-jane');

    fireEvent.focus(nameBox());
    fireEvent.keyDown(nameBox(), { key: 'Escape' });
    expect(list()).toBeNull();
  });

  it('keyboard: Enter on a typed name keeps it as someone else and moves to the email', () => {
    const { last } = renderPicker();
    fireEvent.focus(nameBox());
    fireEvent.change(nameBox(), { target: { value: 'Pat Visitor' } });
    fireEvent.keyDown(nameBox(), { key: 'Enter' });
    expect(last()).toEqual({ borrowerUserId: null, borrowerName: 'Pat Visitor', borrowerEmail: null });
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(emailBox());
  });

  it('the list closes when focus leaves it (Tab to the email no longer leaves it on top)', () => {
    renderPicker();
    act(() => nameBox().focus());
    fireEvent.change(nameBox(), { target: { value: 'Pat' } });
    expect(list()).not.toBeNull();
    fireEvent.blur(nameBox(), { relatedTarget: emailBox() });
    expect(list()).toBeNull();
  });

  it('the list is not a Tab stop (Tab goes from the name box to the email)', () => {
    // Chrome makes an overflowing scroll box with no focusable children a Tab
    // stop. With a long member list, Tab from the name box landed on the
    // list, inside the picker, so the list stayed open over the email field.
    // jsdom has no such scroll boxes, so the attribute is what is pinned.
    renderPicker();
    fireEvent.focus(nameBox());
    expect(list()!.getAttribute('tabindex')).toBe('-1');
  });

  it('clicking the box reopens the list after a pick, and after Escape', () => {
    // A pick keeps focus in the name box (the list's mousedown is cancelled),
    // so a second click on the box fires no focus event. It used to leave the
    // list shut, with no visible way to switch to another member.
    const { last } = renderPicker();
    act(() => nameBox().focus());
    fireEvent.click(screen.getByRole('option', { name: /Jane Doe/ }));
    expect(last()?.borrowerUserId).toBe('u-jane');
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(nameBox());

    fireEvent.click(nameBox());
    expect(list()).not.toBeNull();
    expect(nameBox().getAttribute('aria-expanded')).toBe('true');
    expect(options()).toHaveLength(3);

    fireEvent.keyDown(nameBox(), { key: 'Escape' });
    expect(list()).toBeNull();
    fireEvent.click(nameBox());
    expect(list()).not.toBeNull();
  });

  it('only the chosen borrower is announced as selected, not the highlighted option', () => {
    renderPicker({ borrowerUserId: 'u-jane', borrowerName: 'Jane Doe', borrowerEmail: 'jane@l4l.org' });
    fireEvent.focus(nameBox());
    // Highlight "Someone not in StockPilot": highlighted, not selected.
    fireEvent.keyDown(nameBox(), { key: 'ArrowDown' });
    expect(nameBox().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
    const selected = () =>
      options()
        .filter((o) => o.getAttribute('aria-selected') === 'true')
        .map((o) => o.textContent);
    expect(options()[0]!.getAttribute('aria-selected')).toBe('false');
    expect(selected()).toEqual(['Jane Doejane@l4l.org']);

    // The picked member, highlighted, shows it (a ring over the picked fill).
    fireEvent.keyDown(nameBox(), { key: 'ArrowDown' });
    const jane = screen.getByRole('option', { name: /Jane Doe/ });
    expect(nameBox().getAttribute('aria-activedescendant')).toBe(jane.id);
    expect(jane.className).toMatch(/\bring-2\b/);
    fireEvent.keyDown(nameBox(), { key: 'ArrowDown' });
    expect(jane.className).not.toMatch(/\bring-2\b/);
  });

  it('a typed name is the chosen borrower: "Someone else" is the selected option', () => {
    renderPicker();
    fireEvent.focus(nameBox());
    expect(options()[0]!.getAttribute('aria-selected')).toBe('false');
    fireEvent.change(nameBox(), { target: { value: 'Pat' } });
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(
      options().filter((o) => o.getAttribute('aria-selected') === 'true'),
    ).toHaveLength(1);
  });

  it('choosing from the list keeps focus in the name box (mousedown does not blur it)', () => {
    renderPicker();
    fireEvent.focus(nameBox());
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    options()[1]!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('disabled while the checkout is saving', () => {
    const onChange = vi.fn();
    render(<BorrowerPicker members={MEMBERS} value={EMPTY} onChange={onChange} disabled />);
    expect((screen.getByRole('combobox') as HTMLInputElement).disabled).toBe(true);
    expect(emailBox()!.disabled).toBe(true);
  });
});
