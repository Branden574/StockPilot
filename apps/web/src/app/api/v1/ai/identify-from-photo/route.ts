import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { env } from '@/lib/env';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VISION_MAX_BYTES = 6 * 1024 * 1024;

/**
 * Mobile-side wrapper around the identifyFromPhoto AI tool. Accepts a
 * direct multipart upload of the captured cover (skipping the
 * upload-then-fetch round-trip the chat tool needs). Returns the same
 * structured shape: { title, author, isbn?, publisher?, edition?,
 * language?, confidence, notes? }.
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  // 30 cover-IDs per minute per user is way over the realistic mobile
  // capture cadence; a tighter cap is fine here because Vision calls
  // are heavier (image upload + multi-second model latency).
  const rl = await checkRateLimit(`ai-vision:${ctx.userId}`, 30, 60_000, 'closed');
  if (!rl.allowed) {
    return NextResponse.json(
      {
        error: 'rate_limited',
        retryAt: rl.resetAt,
      },
      { status: 429 },
    );
  }
  if (!env.GEMINI_API_KEY) {
    // Don't leak the env var name. The mobile client just needs to
    // know the feature isn't ready and to retry-or-give-up.
    return NextResponse.json(
      { error: 'feature_unavailable' },
      { status: 503 },
    );
  }

  let bytes: ArrayBuffer;
  let mimeType: string;
  let hint = '';

  const contentType = req.headers.get('content-type') ?? '';
  try {
    if (contentType.startsWith('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('image');
      if (!(file instanceof Blob)) {
        return NextResponse.json(
          { error: 'image field is required' },
          { status: 400 },
        );
      }
      bytes = await file.arrayBuffer();
      mimeType = file.type || 'image/jpeg';
      const h = form.get('hint');
      if (typeof h === 'string') hint = h.slice(0, 500);
    } else if (contentType.includes('application/json')) {
      // Fallback: { imageBase64, mimeType, hint } JSON. Keeps the
      // endpoint usable from clients that can't stream multipart.
      const body = (await req.json()) as {
        imageBase64?: string;
        mimeType?: string;
        hint?: string;
      };
      if (!body.imageBase64) {
        return NextResponse.json(
          { error: 'imageBase64 is required' },
          { status: 400 },
        );
      }
      const buf = Buffer.from(body.imageBase64, 'base64');
      bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      mimeType = body.mimeType || 'image/jpeg';
      hint = (body.hint ?? '').slice(0, 500);
    } else {
      return NextResponse.json(
        { error: 'expected multipart/form-data or application/json' },
        { status: 415 },
      );
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid request body' },
      { status: 400 },
    );
  }

  if (bytes.byteLength > VISION_MAX_BYTES) {
    return NextResponse.json(
      { error: `image too large (max ${VISION_MAX_BYTES} bytes)` },
      { status: 413 },
    );
  }
  if (!mimeType.startsWith('image/')) {
    return NextResponse.json(
      { error: `mime type must start with image/ (got ${mimeType})` },
      { status: 400 },
    );
  }

  const base64 = Buffer.from(bytes).toString('base64');
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: env.GEMINI_MODEL,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          title: { type: SchemaType.STRING },
          author: { type: SchemaType.STRING },
          isbn: { type: SchemaType.STRING },
          publisher: { type: SchemaType.STRING },
          edition: { type: SchemaType.STRING },
          language: { type: SchemaType.STRING },
          confidence: { type: SchemaType.STRING },
          notes: { type: SchemaType.STRING },
        },
        required: ['title', 'confidence'],
      },
    },
  });

  const prompt = `You are identifying the book or product in this image.
Return only the requested JSON. If a field isn't clearly visible or
inferable, omit it (do not guess). For ISBN, only fill it if you can
read the actual digits on the cover or back — never derive it from
the title. Confidence rubric:
  - "high": title + author are unambiguous from the image
  - "medium": title clear but author or edition uncertain
  - "low": you're inferring from a partial or blurry view
${hint ? `\nUser hint: ${hint}` : ''}`;

  try {
    const result = await model.generateContent([
      { text: prompt },
      { inlineData: { data: base64, mimeType } },
    ]);
    const raw = result.response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      parsed = JSON.parse(cleaned);
    }
    return NextResponse.json(parsed);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'vision_failed' },
      { status: 502 },
    );
  }
}
