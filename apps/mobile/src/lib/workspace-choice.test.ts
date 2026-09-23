import { describe, expect, it } from 'vitest';

import { chooseActiveOrg } from './workspace-choice';

const A = 'org-a';
const B = 'org-b';
const GONE = 'org-left';

describe('chooseActiveOrg', () => {
  it('keeps a stored workspace the user still belongs to, changing nothing', () => {
    expect(chooseActiveOrg({ orgIds: [A, B], stored: B, profileDefault: A })).toEqual({
      activeOrgId: B,
      persist: false,
      resetCache: false,
    });
  });

  it('after sign-out (nothing stored) opens the default organization, like the server, and saves it', () => {
    expect(chooseActiveOrg({ orgIds: [B, A], stored: null, profileDefault: A })).toEqual({
      activeOrgId: A,
      persist: true,
      // The API was already answering for the default, so the cache matches.
      resetCache: false,
    });
  });

  it('a single-organization member keeps their cache and just saves the choice', () => {
    expect(chooseActiveOrg({ orgIds: [A], stored: null, profileDefault: A })).toEqual({
      activeOrgId: A,
      persist: true,
      resetCache: false,
    });
  });

  it('a stored workspace the user has left is replaced, and its stale cache is reset', () => {
    expect(chooseActiveOrg({ orgIds: [A, B], stored: GONE, profileDefault: B })).toEqual({
      activeOrgId: B,
      persist: true,
      resetCache: true,
    });
  });

  it('with no usable default, falls back to the first membership and resets the cache', () => {
    expect(chooseActiveOrg({ orgIds: [B, A], stored: null, profileDefault: null })).toEqual({
      activeOrgId: B,
      persist: true,
      resetCache: true,
    });
    expect(chooseActiveOrg({ orgIds: [B, A], stored: null, profileDefault: GONE })).toEqual({
      activeOrgId: B,
      persist: true,
      resetCache: true,
    });
  });

  it('no memberships (or an unreadable list) chooses nothing and touches nothing', () => {
    expect(chooseActiveOrg({ orgIds: [], stored: A, profileDefault: A })).toEqual({
      activeOrgId: null,
      persist: false,
      resetCache: false,
    });
  });
});
