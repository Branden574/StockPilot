import { describe, expect, it } from 'vitest';

import {
  toExportRequest,
  initialExportBuilderState,
} from '@/components/inventory/export-builder/export-builder-state';

import { resolveExportFields } from './export-request';
import {
  droppedFieldsNote,
  parseSharedPresetConfig,
  type SharedExportPresetConfig,
} from './preset-config';

describe('parseSharedPresetConfig — registry validation on load', () => {
  it('keeps known fields in stored order and DROPS unknown ids, reporting them', () => {
    const res = parseSharedPresetConfig({
      itemTypeKind: 'book',
      fieldKeys: ['name', 'lexile_level', 'isbn', 'binding_type', 'quantity_on_hand'],
    });
    if (!res.ok) throw new Error('expected ok');
    expect(res.config.fieldKeys).toEqual(['name', 'isbn', 'quantity_on_hand']);
    expect(res.droppedFieldKeys).toEqual(['lexile_level', 'binding_type']);
  });

  it('reports nothing dropped for a fully current config', () => {
    const res = parseSharedPresetConfig({
      itemTypeKind: 'other',
      fieldKeys: ['name', 'sku', 'warehouse'],
      format: 'xlsx',
    });
    if (!res.ok) throw new Error('expected ok');
    expect(res.droppedFieldKeys).toEqual([]);
    expect(res.config).toEqual({
      itemTypeKind: 'other',
      fieldKeys: ['name', 'sku', 'warehouse'],
      format: 'xlsx',
    });
  });

  it('collapses duplicate field ids silently (same field, same column)', () => {
    const res = parseSharedPresetConfig({
      itemTypeKind: 'book',
      fieldKeys: ['name', 'name', 'isbn', 'isbn'],
    });
    if (!res.ok) throw new Error('expected ok');
    expect(res.config.fieldKeys).toEqual(['name', 'isbn']);
    expect(res.droppedFieldKeys).toEqual([]);
  });

  it('drops non-string field entries as unknown', () => {
    const res = parseSharedPresetConfig({
      itemTypeKind: 'book',
      fieldKeys: ['name', 42, { key: 'sku' }],
    });
    if (!res.ok) throw new Error('expected ok');
    expect(res.config.fieldKeys).toEqual(['name']);
    expect(res.droppedFieldKeys).toEqual(['42', '[object Object]']);
  });

  it('an all-unknown field list still parses — zero fields, everything reported', () => {
    const res = parseSharedPresetConfig({ itemTypeKind: 'book', fieldKeys: ['gone_a', 'gone_b'] });
    if (!res.ok) throw new Error('expected ok');
    expect(res.config.fieldKeys).toEqual([]);
    expect(res.droppedFieldKeys).toEqual(['gone_a', 'gone_b']);
  });

  it('refuses a non-object, a bad itemTypeKind, and a missing field list — with reasons', () => {
    expect(parseSharedPresetConfig('"scalar"')).toEqual({
      ok: false,
      reason: 'The stored preset is not a config object.',
    });
    expect(parseSharedPresetConfig({ itemTypeKind: 'all', fieldKeys: ['name'] })).toEqual({
      ok: false,
      reason: 'The stored preset does not say which export it belongs to.',
    });
    expect(parseSharedPresetConfig({ itemTypeKind: 'book', fieldKeys: 'name' })).toEqual({
      ok: false,
      reason: 'The stored preset has no field list.',
    });
  });

  it('strips invalid option values and unknown option keys, keeping valid ones', () => {
    const res = parseSharedPresetConfig({
      itemTypeKind: 'book',
      fieldKeys: ['name'],
      format: 'docx', // not a real format — stripped
      options: {
        includeImages: 'yes', // not a boolean — stripped
        imageSize: 'large',
        smuggled: true, // unknown key — stripped
        pdf: { paperSize: 'a4', density: 'compact', pageNumbers: false }, // a4 stripped
        xlsx: { freezeHeader: 1 }, // not a boolean — stripped, group collapses away
      },
    });
    if (!res.ok) throw new Error('expected ok');
    expect(res.config.format).toBeUndefined();
    expect(res.config.options).toEqual({
      imageSize: 'large',
      pdf: { density: 'compact', pageNumbers: false },
    });
  });
});

describe('preset load path reuses THE server field-permission gate', () => {
  // The claim under proof: a shared preset's field list is enforced by
  // resolveExportFields — the exact function POST /api/inventory/export runs
  // for every request (route.tsx:110) — and by NOTHING here. The chain below
  // is the real one: stored config -> parseSharedPresetConfig -> builder
  // state -> toExportRequest -> request.fields -> resolveExportFields.

  const stored: SharedExportPresetConfig = {
    itemTypeKind: 'other',
    fieldKeys: ['name', 'sku', 'unit_cost'],
    format: 'xlsx',
  };

  it('parse does NOT permission-filter: a gated field passes through untouched', () => {
    const parsed = parseSharedPresetConfig(stored);
    if (!parsed.ok) throw new Error('expected ok');
    // unit_cost is the field the registry's own comment nominates for a
    // future permission; the parser must hand it through regardless.
    expect(parsed.config.fieldKeys).toContain('unit_cost');
  });

  it('toExportRequest carries the preset fields VERBATIM as request.fields', () => {
    const parsed = parseSharedPresetConfig(stored);
    if (!parsed.ok) throw new Error('expected ok');
    const state = {
      ...initialExportBuilderState('other'),
      format: 'xlsx' as const,
      fieldKeys: parsed.config.fieldKeys,
      presetId: 'shared-1',
    };
    const req = toExportRequest(state, { scope: 'all', itemType: 'product' });
    expect(req.fields).toEqual(['name', 'sku', 'unit_cost']);
  });

  it('resolveExportFields REFUSES the preset-derived list for a user without the field permission', () => {
    const parsed = parseSharedPresetConfig(stored);
    if (!parsed.ok) throw new Error('expected ok');
    const res = resolveExportFields({
      fields: parsed.config.fieldKeys,
      itemType: 'product',
      format: 'xlsx',
      options: {
        includeImages: false,
        imageMode: 'embedded',
        imageSize: 'medium',
        pdf: {
          layout: 'table',
          catalogColumns: 2,
          orientation: 'auto',
          paperSize: 'letter',
          density: 'comfortable',
          repeatHeaders: true,
          pageNumbers: true,
          wrapText: true,
        },
        xlsx: { freezeHeader: true, autoFilter: true, includeSummarySheet: false },
      },
      // The CURRENT user holds items:export but NOT the (test-seam) cost
      // permission — the admin who SAVED the preset is irrelevant here.
      can: (p) => p === 'items:export',
      permissionOverrides: { unit_cost: 'reports:read' },
    });
    expect(res).toEqual({
      ok: false,
      status: 403,
      message: 'You do not have permission to export Unit cost.',
    });
  });

  it('...and ADMITS the same list, in preset order, for a user who holds it', () => {
    const parsed = parseSharedPresetConfig(stored);
    if (!parsed.ok) throw new Error('expected ok');
    const res = resolveExportFields({
      fields: parsed.config.fieldKeys,
      itemType: 'product',
      format: 'xlsx',
      options: {
        includeImages: false,
        imageMode: 'embedded',
        imageSize: 'medium',
        pdf: {
          layout: 'table',
          catalogColumns: 2,
          orientation: 'auto',
          paperSize: 'letter',
          density: 'comfortable',
          repeatHeaders: true,
          pageNumbers: true,
          wrapText: true,
        },
        xlsx: { freezeHeader: true, autoFilter: true, includeSummarySheet: false },
      },
      can: () => true,
      permissionOverrides: { unit_cost: 'reports:read' },
    });
    if (!res.ok) throw new Error('expected ok');
    expect(res.fields.map((f) => f.key)).toEqual(['name', 'sku', 'unit_cost']);
  });
});

describe('droppedFieldsNote', () => {
  it('speaks plural and singular correctly', () => {
    expect(droppedFieldsNote({ name: 'Warehouse walk', droppedFieldKeys: ['a', 'b'] })).toBe(
      '"Warehouse walk" references 2 fields that no longer exist and were skipped: a, b.',
    );
    expect(droppedFieldsNote({ name: 'Warehouse walk', droppedFieldKeys: ['a'] })).toBe(
      '"Warehouse walk" references 1 field that no longer exists and was skipped: a.',
    );
  });
});
