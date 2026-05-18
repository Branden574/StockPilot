# AI Shelf Scan — v1 Design

**Date:** 2026-05-17
**Owner:** Branden
**Status:** Design approved — implementation in progress
**Migration:** [supabase/migrations/0124_ai_shelf_scan.sql](../../supabase/migrations/0124_ai_shelf_scan.sql)

## Problem

Cycle counting books at L4L's primary warehouse takes 2–3 hours of two people walking the shelves with a barcode scanner. That manual time is the single biggest ops cost for the team, and the same friction repeats at every prospective customer who runs a similar catalog.

Closest competitors in retail-audit CV (TraxRetail, Pensa Systems) target enterprise at $50k+/yr and don't integrate with an SMB inventory product. The gap is real.

## Goal

Cut a cycle count from hours to minutes by pointing the phone at a shelf, letting Gemini identify and count the books visible against the cycle count's line set, and pre-filling the counted quantities with explicit confidence flags so the user can rubber-stamp the easy stuff and re-check the hard stuff.

## v1 Scope (locked)

- **Item types:** books only (`item_type = 'book'`)
- **Capture mode:** one photo per scan (no multi-photo sweep, no real-time stream)
- **Platforms:** Expo mobile app only (web upload variant deferred to v2)
- **Confidence threshold:** hardcoded `0.85` (per-org tuning deferred)

## Non-goals

- General-purpose items (non-book). Visually similar SKUs without distinctive labels accuracy drops sharply.
- Multi-photo sweep. Complex de-dup + stitching UX; defer until v1 proves out.
- Web upload variant. The capture surface is the phone; managers who want web upload are a small minority of v1 users.
- Real-time camera analysis (analyze every frame). Single capture is cheaper and more predictable.
- Auto-confirm high-confidence lines without user tap. Forced user-in-the-loop until the org has 6+ months of accuracy data.
- Fine-tune model on org-specific catalog. The audit log captures the data; tuning is a separate project.

## User flow

1. Manager creates a cycle count on web (existing flow).
2. Picker opens the count in the Expo app, taps **AI Scan** (new button next to "Scan to count" on `[id].tsx`).
3. Camera screen opens with a framing overlay: *"Frame one shelf row from straight on."*
4. Tap capture. Photo previews briefly.
5. Photo compresses via existing `compressImageVariants` worker (300–600ms off-thread), uploads to `/api/cycle-counts/[id]/ai-scan` as multipart.
6. **Server:**
   - Validates cycle count is in `in_progress` status.
   - Loads the count's line set with each line's item: SKU, name, ISBN, primary cover image storage path.
   - Uploads the photo to the `cycle-count-scans` bucket at `{org_id}/{count_id}/{uuid}.webp`.
   - Calls Gemini 2.0 Flash with a structured-output prompt that includes the line set as JSON metadata.
   - Filters Gemini's response to only include SKUs that exist in the line set (defense against hallucination).
   - Persists a row in `cycle_count_ai_scans` with the raw response + storage path.
   - Returns `{ scanId, photoUrl, results: [{ lineId, sku, count, confidence, notes? }] }`.
7. **Mobile review screen** shows each line with a chip:
   - 🟢 Green — confidence ≥ 0.85, pre-filled, one-tap to keep
   - 🟡 Amber — confidence < 0.85, forces explicit confirm
   - ⚪ Grey "not detected" — AI didn't see this line, user enters manually
8. User edits any line (manual override), then taps **Confirm counts**.
9. Each confirmed line writes through the existing offline-capable `recordCount` path, but with a new optional `ai_scan_id` so the audit trail traces the count back to the scan. The scan's `confirmed_at` + `confirmed_by` are also written.

## Architecture

```
Expo app                          Web API                       Supabase
─────────                         ───────                       ────────
ai-scan/[id].tsx                  POST /api/cycle-counts/       storage:
  capture                  ───►     [id]/ai-scan                  cycle-count-scans/
                                    │
                                    ├─► supabase storage upload  ◄┘
                                    │     (cycle-count-scans)
                                    │
                                    ├─► loadLineSetWithMetadata   tables:
                                    │     (web service)            cycle_counts
                                    │                              cycle_count_lines
                                    ├─► lib/ai/shelf-scan          inventory_items
                                    │     buildPrompt              item_images
                                    │     callGemini
                                    │     filterToLineSet
                                    │
                                    └─► insert cycle_count_ai_scans

ai-scan/[id]/review               PATCH cycle_count_lines       cycle_count_lines
  per-line confirm                  (existing recordCount         (ai_scan_id set)
                          ───►       + new ai_scan_id field)
                                  PATCH cycle_count_ai_scans    cycle_count_ai_scans
                                    (confirmed_at, confirmed_by)  (confirmed)
```

## Components

### Server

**`apps/web/src/lib/ai/shelf-scan.ts`** (new) — pure functions, no Supabase deps, fully unit-testable
- `buildShelfScanPrompt(lineSet, options)` — assembles the Gemini prompt + structured-output schema given the cycle count's lines (sku/name/isbn/coverHint).
- `parseShelfScanResponse(raw, lineSet)` — parses Gemini's JSON output, filters to only include SKUs that exist in the line set, maps to `lineId`.
- Exports `AI_CONFIDENCE_THRESHOLD = 0.85`.

**`apps/web/src/app/api/cycle-counts/[id]/ai-scan/route.ts`** (new) — POST endpoint
- Auth via `withApiContext`, rate limit 10/min/user, body 10MB max.
- Multipart upload — `image` field is the photo.
- Validates cycle count is `in_progress` and belongs to caller's org.
- Loads line set via `CycleCountsService.getLineSetForAiScan(id)`.
- Uploads photo to `cycle-count-scans` bucket.
- Calls Gemini, parses + filters response.
- Inserts `cycle_count_ai_scans` row with raw response.
- Returns `{ scanId, photoSignedUrl, results }`.

**`apps/web/src/server/services/cycle-counts.ts`** (extended)
- New method `getLineSetForAiScan(cycleCountId)` — returns line array with item SKU, name, ISBN, primary cover storage_path.
- New method `confirmAiScan(scanId, confirmedLines, ctx)` — atomically writes each line's `counted_quantity` + `ai_scan_id` and marks the scan `confirmed_at`/`confirmed_by`.
- Extended `recordCount` accepts optional `aiScanId` for solo line confirms via the existing offline-capable path.

**`apps/web/src/server/actions/cycle-counts.ts`** (extended)
- New action `confirmAiScanAction(input)` wrapping the service call.

### Mobile

**`apps/mobile/app/cycle-count/ai-scan/[id].tsx`** (new) — capture screen
- Reuses `expo-camera` `CameraView` (same lib as the existing scan screen).
- Capture button + framing overlay text.
- On capture: compress via existing main-thread fallback (worker isn't available in RN — compress is faster on phones anyway, and the canvas API works through expo-image-manipulator).
- POST to `/api/cycle-counts/[id]/ai-scan` with auth bearer token from session.
- On success → router.push to review screen with the response payload (passed via params).

**`apps/mobile/app/cycle-count/ai-scan/[id]/review.tsx`** (new) — review/confirm screen
- Shows photo thumbnail at top.
- Each cycle count line renders as a row with: item name, expected qty, AI-proposed qty, confidence chip, optional notes.
- Tap a row to manually override counted_quantity via a sheet (same UX as the existing scan screen's confirm sheet).
- "Confirm counts" button → calls `confirmAiScanAction`, updates the local SQLite cache, navigates back to cycle-count detail.

**`apps/mobile/app/cycle-count/[id].tsx`** (modified)
- Adds an "AI Scan" button next to the existing "Scan to count" button.

### Data model

Migration 0124 (already applied):
- `cycle_count_ai_scans` — id, org_id, cycle_count_id, created_by, photo_storage_path, gemini_response (JSONB), model_version, created_at, confirmed_at, confirmed_by.
- `cycle_count_lines.ai_scan_id` — nullable FK.
- `cycle-count-scans` private storage bucket with org-scoped policies.

### Gemini prompt (sketch)

```
You are counting visible books on the shelf in this photo against a known set of titles.
Return a JSON object {"results": [...]}. Each result has:
  - sku: must match exactly one of the provided SKUs (or null if no match)
  - count: how many copies of that title you can see (whole number)
  - confidence: 0.0 to 1.0
  - notes: optional one-sentence rationale

Title set (only consider these):
[
  {"sku": "9780...", "title": "...", "author": "...", "isbn": "9780..."},
  ...
]

Rules:
- Only return rows where you can see the title clearly. Don't guess.
- Same title in multiple copies → ONE result with count = how many you see.
- Books partially obscured but identifiable → include with lower confidence.
- Unknown books in frame that aren't in the title set → ignore.
```

Structured output schema enforces the shape; we filter `sku not in lineSet` defensively in case Gemini hallucinates.

## Error handling

| Scenario | Behavior |
|---|---|
| Camera permission denied | Platform-native settings deep link with "Grant access" copy |
| Photo > 10 MB after compress | "Photo too large, try again with less zoom" |
| Network down during upload | Toast "No connection. Try again when online." (no queue — photo flow is online-only by design) |
| Gemini 503 / timeout | Toast "Couldn't process scan, try again" + retry button. Photo is preserved client-side until success or user cancel. |
| Gemini returns zero matches | Review screen shows "Nothing detected — scan in better light, or count manually" with all lines greyed. |
| Gemini hallucinates SKU not in line set | Server filters before responding. Discarded silently. |
| Cycle count not in_progress | 409 + "This count isn't accepting new entries" |
| User confirms without changes | Counts still write through (rubber stamp). Scan marked confirmed. |
| User cancels mid-review | `cycle_count_ai_scans` row stays with `confirmed_at = NULL` — useful for tuning later. |

## Rate limit + cost

- 10 scans / user / minute. AI vision is ~$0.0001/scan for input (1024 tokens of image @ $0.075/MTok). Realistic load: 200 scans/day across an org = ~$0.60/month. Well below cost concerns.
- Per-org daily cap deferred to v2 with real usage data.

## Testing

- Unit tests on `buildShelfScanPrompt` (snapshot-style: given a line set, prompt body contains all SKUs in the right shape).
- Unit tests on `parseShelfScanResponse`: hallucinated SKUs filtered, malformed JSON rejected, confidence clamped to [0,1].
- No E2E test framework on mobile yet; verification is real-shelf testing on day 5.

## Open questions resolved

- ~~Confidence threshold configurability~~ → deferred (hardcoded 0.85)
- ~~Multi-photo support~~ → deferred (single photo)
- ~~Web upload variant~~ → deferred (mobile only)
- ~~Per-org cost caps~~ → deferred (rate limit only)

## Build sequence

| Day | Output |
|---|---|
| 1 | Migration 0124 (✓ applied) |
| 2 | `lib/ai/shelf-scan.ts` + tests + API route + service extension |
| 3 | Mobile capture screen + photo upload integration |
| 4 | Mobile review screen + confidence chips + confirm flow + AI Scan button on detail screen |
| 5 | Real-shelf testing + prompt tuning + memory update (parked → shipped) |
