import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createRentalSchema } from '@stockpilot/core';

import {
  BORROWER_SEARCH_OFFLINE_NOTE,
  BORROWER_SUGGESTION_A11Y_HINT,
  BORROWER_TYPE_ANYONE_NOTE,
  EMPTY_BORROWER,
  borrowerEmailErrorShown,
  borrowerEmailInvalid,
  borrowerSuggestionA11yLabel,
  borrowerRequestFields,
  borrowerSearchFailure,
  keepPickedMember,
  listRentalBorrowers,
  matchBorrowers,
  pickMember,
  someoneElse,
  typeEmail,
  typeName,
  type RentalBorrowerMember,
} from './rental-borrower';

// ./api reaches for expo-constants, AsyncStorage and the Supabase client at
// import time; the node test environment has none of them. ApiError is the
// real shape (message + status) the screen branches on.
const apiMock = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return { api: vi.fn(async (..._args: unknown[]) => ({}) as unknown), ApiError };
});
vi.mock('./api', () => apiMock);

const ANA: RentalBorrowerMember = { userId: 'u-ana', displayName: 'Ana Ruiz', email: 'ana@school.org' };
const BO: RentalBorrowerMember = { userId: 'u-bo', displayName: 'Bo Diaz', email: null };
const MEMBERS = [ANA, BO];

beforeEach(() => apiMock.api.mockReset());

describe('listRentalBorrowers', () => {
  it('GETs the rentals borrowers route and unwraps the members', async () => {
    apiMock.api.mockResolvedValueOnce({ members: MEMBERS });
    await expect(listRentalBorrowers()).resolves.toEqual(MEMBERS);
    expect(apiMock.api).toHaveBeenCalledWith('/api/v1/rentals/borrowers');
  });

  it('drops malformed rows and survives a missing envelope', async () => {
    apiMock.api.mockResolvedValueOnce({
      members: [ANA, { userId: '', displayName: 'x', email: null }, { displayName: 'no id' }, null],
    });
    await expect(listRentalBorrowers()).resolves.toEqual([ANA]);
    apiMock.api.mockResolvedValueOnce({});
    await expect(listRentalBorrowers()).resolves.toEqual([]);
  });
});

describe('the picker flow', () => {
  it('search, pick a member: their id, name and account email', () => {
    let d = typeName(EMPTY_BORROWER, 'an');
    expect(matchBorrowers(MEMBERS, d).shown).toEqual([ANA]);
    d = pickMember(ANA);
    expect(d).toEqual({ userId: 'u-ana', name: 'Ana Ruiz', email: 'ana@school.org' });
    expect(borrowerRequestFields(d)).toEqual({
      borrowerUserId: 'u-ana',
      borrowerName: 'Ana Ruiz',
      borrowerEmail: 'ana@school.org',
    });
    // No suggestions while a member is picked.
    expect(matchBorrowers(MEMBERS, d).shown).toEqual([]);
  });

  it('a member with no account email: picked with no email (the rental gets none)', () => {
    expect(borrowerRequestFields(pickMember(BO))).toEqual({
      borrowerUserId: 'u-bo',
      borrowerName: 'Bo Diaz',
      borrowerEmail: null,
    });
  });

  it('someone not in StockPilot: typed name and optional email, no user id', () => {
    let d = typeName(EMPTY_BORROWER, 'Pat from Site 4 ');
    d = typeEmail(d, ' pat@site4.org ');
    expect(borrowerRequestFields(d)).toEqual({
      borrowerUserId: null,
      borrowerName: 'Pat from Site 4',
      borrowerEmail: 'pat@site4.org',
    });
    expect(borrowerRequestFields(typeEmail(d, '   ')).borrowerEmail).toBeNull();
  });

  it('typing over a picked member makes it someone else and drops the member email', () => {
    const d = typeName(pickMember(ANA), 'Ana Ruiz (guest)');
    expect(d).toEqual({ userId: null, name: 'Ana Ruiz (guest)', email: '' });
  });

  it('Change ("someone not in StockPilot") after a pick starts fresh, never keeping the member email', () => {
    expect(someoneElse(pickMember(ANA))).toEqual(EMPTY_BORROWER);
    // Already someone else: nothing typed is lost.
    const typed = typeEmail(typeName(EMPTY_BORROWER, 'Pat'), 'pat@site4.org');
    expect(someoneElse(typed)).toBe(typed);
  });

  it('every request the picker can build is one the server schema accepts', () => {
    const base = {
      warehouseId: '00000000-0000-4000-8000-000000000001',
      expectedReturnAt: '2030-01-01T00:00:00.000Z',
      lines: [{ itemId: '00000000-0000-4000-8000-000000000002', quantity: 1 }],
    };
    const member = { ...pickMember(ANA), userId: '00000000-0000-4000-8000-000000000003' };
    for (const d of [member, typeEmail(typeName(EMPTY_BORROWER, 'Pat'), 'pat@site4.org'), typeName(EMPTY_BORROWER, 'Pat')]) {
      expect(createRentalSchema.safeParse({ ...base, ...borrowerRequestFields(d) }).success).toBe(true);
    }
  });
});

describe('matchBorrowers', () => {
  it('matches name or email, any case; nothing before typing', () => {
    expect(matchBorrowers(MEMBERS, typeName(EMPTY_BORROWER, '')).shown).toEqual([]);
    expect(matchBorrowers(MEMBERS, typeName(EMPTY_BORROWER, 'DIAZ')).shown).toEqual([BO]);
    expect(matchBorrowers(MEMBERS, typeName(EMPTY_BORROWER, 'school.org')).shown).toEqual([ANA]);
    expect(matchBorrowers(MEMBERS, typeName(EMPTY_BORROWER, 'zzz')).shown).toEqual([]);
  });

  it('shows at most the limit and counts the rest', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ userId: `u-${i}`, displayName: `Sam ${i}`, email: null }));
    const res = matchBorrowers(many, typeName(EMPTY_BORROWER, 'sam'), 6);
    expect(res.shown).toHaveLength(6);
    expect(res.more).toBe(3);
  });
});

describe('borrowerEmailInvalid (the web form check, shared from core)', () => {
  it('flags a typed non-address, never a blank or a member', () => {
    expect(borrowerEmailInvalid(typeEmail(typeName(EMPTY_BORROWER, 'Pat'), 'pat'))).toBe(true);
    expect(borrowerEmailInvalid(typeEmail(typeName(EMPTY_BORROWER, 'Pat'), 'pat@site4.org'))).toBe(false);
    expect(borrowerEmailInvalid(typeName(EMPTY_BORROWER, 'Pat'))).toBe(false);
    expect(borrowerEmailInvalid(pickMember(ANA))).toBe(false);
  });
});

describe('keepPickedMember', () => {
  it('keeps a picked member who is on the list, drops one who is not', () => {
    const picked = pickMember(ANA);
    expect(keepPickedMember(picked, MEMBERS)).toBe(picked);
    expect(keepPickedMember(picked, [BO])).toEqual(EMPTY_BORROWER);
    const typed = typeName(EMPTY_BORROWER, 'Pat');
    expect(keepPickedMember(typed, [])).toBe(typed);
  });
});

describe('borrowerSearchFailure: typing always still works', () => {
  it('no answer from the server: the search needs a connection', () => {
    expect(borrowerSearchFailure(new TypeError('Network request failed'))).toEqual({
      status: 'failed',
      message: BORROWER_SEARCH_OFFLINE_NOTE,
    });
    expect(BORROWER_SEARCH_OFFLINE_NOTE).toMatch(/needs a connection/);
  });

  it('the server answered: its own sentence, then that typing works', () => {
    const res = borrowerSearchFailure(new apiMock.ApiError('You do not have access to that.', 403));
    expect(res).toEqual({
      status: 'failed',
      message: `You do not have access to that. ${BORROWER_TYPE_ANYONE_NOTE}`,
    });
  });
});

describe('borrowerEmailErrorShown: the web rule, after the field is left', () => {
  // Mutation caught: the error on every render (the old screen), which showed
  // "Enter a full email address..." from the first letter typed.
  it('a half-typed address shows nothing until the field is left', () => {
    const typing = typeEmail(typeName(EMPTY_BORROWER, 'Sam'), 's');
    expect(borrowerEmailInvalid(typing)).toBe(true);
    expect(borrowerEmailErrorShown(typing, false)).toBe(false);
    expect(borrowerEmailErrorShown(typing, true)).toBe(true);
  });

  it('never for a good address, a blank one or a picked member, touched or not', () => {
    const good = typeEmail(typeName(EMPTY_BORROWER, 'Sam'), 'sam@site4.org');
    for (const touched of [false, true]) {
      expect(borrowerEmailErrorShown(good, touched)).toBe(false);
      expect(borrowerEmailErrorShown(EMPTY_BORROWER, touched)).toBe(false);
      expect(borrowerEmailErrorShown(pickMember(ANA), touched)).toBe(false);
    }
  });
});

describe('borrowerSuggestionA11yLabel: what VoiceOver reads for a suggestion', () => {
  // Mutation caught: "Check out to <name>, team member" (the old label). It
  // replaced the email shown in the row, so two members with one name read
  // the same, and it sounded as if the tap checked the rental out.
  it('names the member and carries their email, so two of one name can be told apart', () => {
    const alexA: RentalBorrowerMember = { userId: 'u-a', displayName: 'Alex Kim', email: 'alex.kim@school.org' };
    const alexB: RentalBorrowerMember = { userId: 'u-b', displayName: 'Alex Kim', email: 'akim@site4.org' };
    expect(borrowerSuggestionA11yLabel(alexA)).toBe('Alex Kim, team member, alex.kim@school.org');
    expect(borrowerSuggestionA11yLabel(alexA)).not.toBe(borrowerSuggestionA11yLabel(alexB));
  });

  it('a member with no account email: the name alone', () => {
    expect(borrowerSuggestionA11yLabel(BO)).toBe('Bo Diaz, team member');
  });

  it('never says the tap checks out; the hint says it picks the borrower', () => {
    expect(borrowerSuggestionA11yLabel(ANA)).not.toMatch(/check/i);
    expect(BORROWER_SUGGESTION_A11Y_HINT).toBe('Makes them the borrower');
  });
});
