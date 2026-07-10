import { describe, it, expect, vi } from 'vitest';
import { SchemaType } from '@google/generative-ai';

vi.mock('@/lib/env', () => ({ env: { ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: 'claude-haiku-4-5' } }));

import { userContent } from './claude';

/**
 * The whole migration rests on ONE invariant: a Gemini responseSchema (and a
 * tool-declaration `parameters`) is already a valid Anthropic input_schema,
 * because SchemaType enum values ARE the lowercase JSON-Schema type strings.
 * If a future @google/generative-ai bump changed these, every forced-tool
 * JSON call would silently break — so pin them.
 */
describe('SchemaType values are JSON-Schema type strings (Gemini→Anthropic passthrough)', () => {
  it('maps each enum member to its JSON-Schema string', () => {
    expect(SchemaType.OBJECT).toBe('object');
    expect(SchemaType.STRING).toBe('string');
    expect(SchemaType.NUMBER).toBe('number');
    expect(SchemaType.INTEGER).toBe('integer');
    expect(SchemaType.BOOLEAN).toBe('boolean');
    expect(SchemaType.ARRAY).toBe('array');
  });
});

describe('userContent media mapping', () => {
  it('puts the text prompt LAST, after all media', () => {
    const blocks = userContent('describe this', [
      { data: 'AAAA', mediaType: 'image/png' },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe('image');
    expect(blocks[1]).toEqual({ type: 'text', text: 'describe this' });
  });

  it('routes a PDF to a document block (not an image block)', () => {
    const [block] = userContent('extract', [{ data: 'JVBER', mediaType: 'application/pdf' }]);
    expect(block).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBER' },
    });
  });

  it('passes supported image subtypes through verbatim', () => {
    const [block] = userContent('x', [{ data: 'Z', mediaType: 'image/webp' }]);
    expect(block).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/webp', data: 'Z' },
    });
  });

  it('coerces an unsupported image subtype (e.g. HEIC) to jpeg so vision still runs', () => {
    const [block] = userContent('x', [{ data: 'Z', mediaType: 'image/heic' }]);
    expect(block).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'Z' },
    });
  });

  it('emits only the text block when there is no media', () => {
    const blocks = userContent('just text');
    expect(blocks).toEqual([{ type: 'text', text: 'just text' }]);
  });

  it('preserves media order for multi-page PO scans', () => {
    const blocks = userContent('extract', [
      { data: 'p1', mediaType: 'image/jpeg' },
      { data: 'p2', mediaType: 'application/pdf' },
    ]);
    expect(blocks.map((b) => b.type)).toEqual(['image', 'document', 'text']);
  });
});
