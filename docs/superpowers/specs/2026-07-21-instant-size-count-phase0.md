# Instant Size Count — Phase 0 Architecture & Feasibility

**Status:** Phase 0 complete (repo audit wf_da04dbf7-f95). Go/no-go below. Read-only audit; no product code changed by the audit itself.

**Feature:** A native, continuous-camera computer-vision feature in the Expo app that detects small circular clothing **size stickers** (XS, S, M, L, XL, XXL, XXXL, XXXXL, XXXXXL) in a live video feed, counts garments per size with duplicate prevention, and works offline.

**SCOPE DECISION (owner, 2026-07-21):** v1 is a **review-only per-vendor size tally** — an employee counts the sizes in a vendor shipment and a human reads the resulting list. It does **NOT write inventory**: no `finalize → adjust_stock`, no add-vs-set, no size→SKU resolution. "Completing" a session just **locks** the review list. Each session carries an optional `supplier_id` so lists file under the vendor. (An inventory-write mode can be added later as a separate, deliberate step.) This de-scopes sections 6/8 below where they describe an inventory transaction — the idempotent-transaction machinery is not built for v1.

---

## 1. Readiness rating: **WAREHOUSE PILOT READY (as a track), gated on model + device**

The **software system** around the detector — data model, offline sync, idempotent inventory transaction, module gating, capture UI shell, review/correction, audit — is buildable and testable now. The **detector itself** (a trained size-sticker model) and its **on-device real-time runtime** are a hardware + dataset track that runs on the owner's side via EAS builds → TestFlight and a data-capture effort. No latency or accuracy numbers are asserted in this document; those are measured on a real device once a model exists. This is honest per the master prompt's anti-fabrication rules.

## 2. The deployment model (owner-defined)

`runtimeVersion.policy = appVersion` (app.config.ts:26), and adding a native module (VisionCamera + a TFLite frame-processor) is a **native change** — it **cannot** be OTA'd onto existing 1.1.0 binaries; it must ride a **new EAS build**. So:

1. **Native shell → TestFlight.** The VisionCamera frame-processor + on-device inference runtime + the capture/overlay UI ship in an **EAS build** the owner triggers and installs on a real device via TestFlight. This is the on-device test surface (resolves "no physical device here").
2. **Model = OTA-able asset.** The trained model file (`.tflite` / Core ML) is an **asset**, not native code — so once the native shell is in TestFlight, updated models + the JS/UI layer ship via **`pnpm release:ota`** on top of the installed binary. This is exactly the owner's plan: "push the build to TestFlight while we train the model, then push OTA."
3. **Store release** once validated: version bump + `pnpm release:ios/android` (production channel, auto-submit).

## 3. Architecture decision: native-module path

Three paths were evaluated against the **actual** stack (Expo SDK 53, RN 0.79.6, **New Architecture ON**, Hermes, prebuild-generated `ios/`+`android/` — both gitignored, config-plugin + autolink model, `react-native-reanimated` 3.17.5 present, `expo-camera` only, **zero** first-party native code today beyond the `with-fmt-consteval-fix` Podfile patch):

- **Path A — react-native-vision-camera + a frame-processor plugin (react-native-fast-tflite) + react-native-worklets-core. ✅ CHOSEN.** VisionCamera v4 supports RN 0.79 + New Arch, autolinks under prebuild, ships its own Expo config plugin, and needs **zero hand-written Swift/Kotlin**. It slots into the exact prebuild/config-plugin/autolink pattern the app already uses for its third-party native modules. `reanimated` (the worklet prerequisite) is already installed.
- **Path C — Expo Modules API native view (Apple Vision / ML Kit natively).** Fully compatible with the build model but requires authoring + maintaining **both** Swift and Kotlin — which this app has never done. **Fallback** only if a stock TFLite model can't meet accuracy and we need platform-native detectors.
- **Path B — fully custom local Expo module doing detection+events.** Same cost as C with more surface. **Rejected.**

**Build changes for Path A:** add `react-native-vision-camera` + `react-native-fast-tflite` + `react-native-worklets-core` to `apps/mobile/package.json`; add the VisionCamera config plugin to `app.config.ts` plugins; `NSCameraUsageDescription` already exists (app.config.ts:49) so no new iOS permission string; `expo prebuild`; **a new EAS build** to test (cannot use Expo Go, cannot OTA the native add). Consider (not required) an RN 0.81 bump while touching native — RN 0.79 works today.

## 4. The identity limitation (honest, load-bearing)

A size sticker "L" is **not a unique identifier** — two identical "L" shirts are visually indistinguishable, so a camera-only system **cannot guarantee** the same physical garment isn't recounted after full occlusion. The design addresses this honestly with **two modes**:

- **RAPID PASS MODE (primary, recommended).** The employee moves each garment through a visible **virtual count gate**; a garment counts only when its sticker is recognized consistently, its track **crosses the gate** in the approved direction, and it hasn't already committed a count. Directional hysteresis prevents a hovering garment from multi-counting. This is the highest-accuracy workflow.
- **BOX OVERVIEW MODE (secondary, beta).** Point at an open box; overlay all visible stickers with per-item state (green confirmed / amber uncertain / red unreadable). Multi-object tracking maintains identity through moderate camera motion, with **explicit warnings** when heavy occlusion / rapid scene change / identical re-entry makes dedupe uncertain. Not released broadly until duplicate rates are validated on-device.
- **FUTURE — StockPilot Smart Label.** A per-unit QR/DataMatrix/NFC label alongside the human-readable size is the **only** path to absolute individual identity. Documented, not required for v1; it's an operations effort (producing + applying labels), not code.

## 5. Model approach (decide in Phase 1, prove on-device)

The vocabulary is a tiny constrained set — `packages/core/src/inventory/size-run.ts` already enumerates it (`SIZE_ALTERNATION`, longest-match-first, incl. both `2XL` and `XXL` spellings, directly relevant to the "repeated X" confusion). The hard problem is **adjacent-size confusion** (M/W, L/XL, XL/XXL, XXL/XXXL) on small, rotated, glared, curved stickers.

- **Recommended: two-stage** (a one-class circular-sticker detector → a dedicated 9-class size classifier), with an explicit **ABSTAIN / low-confidence** output that never auto-applies a count. Optionally a constrained-OCR cross-check on uncertain crops.
- Single-stage 9-class detector is simpler but riskier on the fine-grained adjacent-size problem. Hybrid (geometry proposal + classifier) is a viable third option.
- **All three must be benchmarked on representative warehouse footage** (owner-captured) — no approach is chosen by assertion.

## 6. Data model & reuse (buildable now, no hardware)

Strong reuse — this feature rides existing infrastructure:

- **Size vocabulary + SKU mapping:** `packages/core/src/inventory/size-run.ts` (`SIZE_ALTERNATION`, `extractSize`, `groupBySizeRun`). Each size is its own `inventory_items` row with `custom_fields.size` and SKU `${base}-${size}`. A detected sticker token → item/SKU is a **name/size lookup**. **Gap:** there is no size *dimension* table, and `/api/v1/mobile/snapshot` omits `custom_fields`/size, so offline size→item resolution needs a snapshot extension or a resolver (net-new, buildable).
- **Offline outbox + idempotency:** `apps/mobile/src/lib/cycle-count-cache.ts` (`pending_actions`, `idempotency_key UNIQUE`) + `cycle-count-sync.ts` drain engine + `queue.ts`/`sync.ts`. Clone for a new `size_count` outbox kind.
- **Idempotent server transaction:** `idempotency_keys` table + `post_receipt_v2` (`unique(org,scope,key)`, replay-on-same-hash) — the template. `adjust_stock` is delta-based and **not** idempotent, so per-garment count events need idempotent semantics keyed on a client UUID.
- **Session/event/audit + private storage:** `supabase/migrations/0124_ai_shelf_scan.sql` (per-attempt row + JSONB payload + `model_version` + `confirmed_by` + org-scoped RLS + private bucket) — mirror as `size_count_sessions` + `size_count_events`.
- **Module gating:** `packages/core/src/modules/registry.ts` `ai_shelf_scan` (premium module) — clone as `instant_size_count` (dependsOn `['ai']`, surfaces `['mobile']`).
- **Capture UI shell:** `expo-camera` permission-gate pattern (App-Store-compliant) + `cycle-count/scan/[id].tsx` reticle/live-capture precedent. Note the **preview** can reuse this, but the **frame-processor** is net-new (VisionCamera).
- **Async Claude review lane:** `resolveAiProvider` + `shelf-scan.ts` structured-output pattern — for uncertain-crop review + supervisor summaries. **Claude is never in the real-time frame loop** (latency/cost/privacy) — only async, human-in-the-loop.

**New data entities (buildable here):** `size_count_sessions` (org, warehouse, receiving/PO ref, product/SKU-group, box id, mode, status, expected qty, operator, device, model_version, offline flag, sync status) + `size_count_events` (session, idempotency key, ephemeral track id, size, qty delta, confidence, recognition method, counted_at, model_version, review status) + `size_count_adjustments` (audit of corrections) + an idempotent finalize RPC that applies per-size deltas via `adjust_stock` under an `idempotency_keys` guard.

## 7. What's blocked here vs owner-side

**Buildable now (this environment, no hardware/dataset):** the `instant_size_count` module + entitlement + server gate; the session/event/adjustment data model + migration + pgTAP; the idempotent finalize transaction; the Bearer sync endpoints; the mobile offline outbox kind + sync branch; size→SKU resolution + snapshot extension; the feature-flag scaffolding; the VisionCamera dep + config-plugin wiring + a JS frame-processor **stub** with a **hot-swappable model asset slot**; the data-capture (opt-in training-example recorder) + annotation-schema + model-card/dataset-card docs; the async Claude uncertain-review endpoint.

**Owner-side track (hardware + dataset + EAS):** capturing + labeling a real sticker dataset; training + quantizing the two-stage model → `.tflite`/Core ML; triggering the EAS build → TestFlight; on-device FPS/thermal/battery/accuracy benchmarking; gate-crossing + confidence calibration; duplicate-rate validation. I can scaffold the training pipeline + capture tooling; I cannot train a model without data or run a build without a device.

## 8. Go / No-Go

**GO — as a phased pilot track.** The software foundation is real, reusable, and buildable/testable now; the ML + device work is well-scoped and rides the TestFlight/OTA model the owner defined. Recommended Phase 1 order:

1. **Server + data model (fully buildable + pgTAP-tested here):** `instant_size_count` module; `size_count_sessions`/`_events`/`_adjustments` migration + idempotent finalize RPC + RLS + pgTAP; Bearer session/event/finalize routes; snapshot size extension.
2. **Mobile offline + UI shell (buildable here, TestFlight-tested by owner):** outbox kind + sync branch; the Rapid Pass capture screen shell (live preview + virtual gate + live per-size tally + review/correction) with the frame-processor as a stubbed module + hot-swappable model slot; feature-flag gate.
3. **Native frame-processor + model integration (owner EAS build → TestFlight):** add VisionCamera + fast-tflite + worklets-core + config plugin; wire the stub to real inference once a model exists.
4. **Data pipeline + model (owner-side, I scaffold):** opt-in capture recorder, annotation schema, dataset/model cards, training config; then train → OTA the model asset.

Do NOT release Box Overview mode broadly before on-device duplicate rates are validated. Rapid Pass is the pilot workflow.
