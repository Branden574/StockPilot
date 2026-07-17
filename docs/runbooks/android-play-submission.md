# Android / Google Play submission runbook

Status as of 2026-07-16: iOS live (v1.1.0). Android **built before but never published**. Owner registering a **PERSONAL** Play developer account (chose personal over org 2026-07-16).

## Critical path (personal account) — the real timeline is ~2-3 weeks, not instant
1. **Register** personal account at play.google.com/console/signup ($25 one-time + government-ID identity verification). Public developer name: **StockPilot**. Owner drives; assistant guides field-by-field (do NOT automate Google login/payment).
2. **12-tester / 14-day closed test is THE gate.** New personal accounts must run a closed test with **≥12 testers opted in for 14 continuous days** before production access is granted. → Line up 12 Android testers NOW; get a build onto the closed track ASAP to start the clock. This is the bottleneck — everything else is faster than this.
3. Build AAB (no Play account needed): `cd apps/mobile && pnpm dlx eas-cli@20.3.0 build --platform android --profile production` (NO --auto-submit until the Play service-account JSON exists). EAS owns versionCode remotely (appVersionSource remote + autoIncrement).
4. Create app in console → upload AAB to **Closed testing** → paste store listing + Data Safety + Content rating (below) → add 12 testers → wait 14 days → apply for production.

## OPEN RISKS / decisions (do not skip)
- **HIGHEST RISK — READ_MEDIA_IMAGES may be REJECTED.** app.config.ts declares `android.permissions: ['CAMERA','READ_MEDIA_IMAGES']`. Google's Photo & Video Permissions policy says apps with *occasional single-photo* selection (exactly our "attach one photo to an item/PO/ticket" flow) should use the **Android system Photo Picker (zero runtime permission)** instead of declaring broad gallery access, and requires a declaration form whose "core use case" bar we likely DON'T clear. **Recommended fix before first submit:** remove `READ_MEDIA_IMAGES` from android.permissions and confirm expo-image-picker (~16.1.4) uses the system Photo Picker intent (see expo/expo#42819 — the plugin can auto-inject this perm; verify the BUILT AAB manifest, not just config). This is the item most likely to block/delay launch.
- **Android push does NOT work yet.** No `google-services.json` / FCM v1 credentials. `expo-notifications` is present (adds POST_NOTIFICATIONS + iOS aps-environment) but Android push needs a Firebase project → google-services.json → FCM v1 service-account key uploaded to EAS. OWNER-blocked (needs owner's Google/Firebase). Acceptable to ship the FIRST closed-test build WITHOUT Android push to start the 14-day clock, then fix FCM in a build during the window.
- **Adaptive icon** uses full-bleed `./assets/icon.png` as foreground → will be clipped by launcher masks (safe zone is inner ~66/108 dp). Needs a padded foreground PNG (design asset). Polish, not a blocker.
- **Target API:** Expo SDK 53 targets API 35 — meets current requirement. NEW-app deadline: must target **API 36 by Aug 31, 2026** (ext. to Nov 1). Submit before then or bump SDK.
- **16KB page size:** RN 0.79.6/SDK 53 support it, but NOT verified on a real AAB. Check Play Console's 16KB warning on the build; add `expo-build-properties` (AGP ≥8.6.0, NDK 29.x) if flagged.
- **Assets still needed:** Play **feature graphic 1024×500 PNG (REQUIRED)** — does not exist. Phone screenshots (assets/store-screenshots/*.png exist — likely iOS; Play accepts 320-3840px, 1:2–2:1 ratio, verify). Large-screen/tablet: no Android tablet work (iOS has it) — quality-score ding, not a blocker.
- Owner confirm: support@stockpilotusa.com inbox is live; no Google Play Billing in the Android app (→ Data Safety "Financial info = not collected" + content-rating "digital purchases = No"); expo-document-picker call sites (if it uploads non-image files, add "Files and docs" to Data Safety).

---

## STORE LISTING (paste-ready)
**Title (≤30):** `StockPilot: Inventory & Ops` (27)
**Short description (≤80):** `Barcode inventory, orders, purchase orders & cycle counts for warehouse teams` (77)
**Category:** Business (over Productivity — B2B ops tool).
**Contact:** support@stockpilotusa.com · https://stockpilotusa.com · Privacy: https://stockpilotusa.com/privacy

**Full description (≤4000):**
StockPilot is inventory and operations management software built for teams that run a warehouse, stockroom, supply closet, or field-service inventory — schools and districts, nonprofits, retail back-of-house, and small-to-midsize operations teams. It replaces spreadsheets and paper counts with one connected system for tracking stock, fulfilling orders, and keeping purchasing organized.

This is a business productivity tool for organizations, not a consumer marketplace or shopping app. StockPilot does not list items for sale to the public — it is invite-only software that your organization's admin sets up for your team, and it works alongside your existing purchasing and vendor relationships.

WHO IT'S FOR
- Warehouse and stockroom staff who scan items in and out
- Operations and inventory managers who need real-time visibility across locations
- Purchasing teams managing vendors and purchase orders
- Order pickers and fulfillment teams processing internal or customer requests
- Organizations running periodic cycle counts and audits

KEY FEATURES

Barcode and QR scanning — Scan items with your device camera to receive stock, pick orders, move inventory between locations, or look up item details instantly — no separate scanner hardware required.

Inventory items and stock levels — Track quantities across warehouses, racks, shelves, and staging areas. See what is placed, unplaced, or in transit, with a full location breakdown for every item.

Orders and picking — Manage order requests end to end: approval workflows, digital picking with claim/lock so two people never pick the same order, partial fulfillment and backorder support, proof-of-pickup signatures, and status tracking from request to delivery.

Purchase orders — Create and track purchase orders, receive against them with serial or batch detail, and keep vendor and cost information organized in one place. Recurring purchase order templates support routine restocking.

Cycle counts — Run full or selective cycle counts to reconcile physical stock against system records, with a clear count workflow and audit trail.

Movements and activity ledger — Every stock change is logged with before-and-after detail, timestamps, and the person responsible, so you always know what happened and why.

Transfers and put-away — Move stock between sites, racks, and shelves, and put away newly received or unplaced inventory with guided native flows.

Notifications — Get pushed alerts for order requests, approvals, and low-stock or backorder events relevant to your role, with per-notification mute controls.

AI assistant — An optional AI assistant helps answer questions about your inventory data and can help with day-to-day tasks like drafting reorders, based only on your organization's own data.

Multi-factor authentication — Sign in with email and password plus TOTP two-factor authentication to keep organizational inventory data secure.

GETTING STARTED
StockPilot is invite-only. Your organization's administrator creates your account and invites you by email; you cannot self-register from the app. Once invited, sign in with your credentials to access your organization's inventory, orders, and purchasing data on the go.

StockPilot is built to mirror the full web application, so work started on desktop continues seamlessly on mobile, and vice versa.

For support, contact us using the details on our Play Store listing or in-app Support screen.

---

## DATA SAFETY (paste-ready; grounded in code)
- Collects/shares user data: **Yes**. Encrypted in transit: **Yes** (HTTPS to stockpilotusa.com; Supabase HTTPS/WSS). Deletion method: **Yes** — in-app Settings → Delete my account → POST /api/v1/account/delete (tombstones profile, invalidates auth, removes biometric pairing + push tokens; org-owned inventory retained for other members — ensure privacy policy states this).
- **Personal info — Name:** collected, not shared, App functionality, Required.
- **Personal info — Email:** collected; shared with processors Supabase (auth/db) + Resend (transactional email); App functionality; Required.
- **Personal info — User IDs:** collected; processor Supabase (+ possibly Sentry incidental); App functionality; Required.
- **Photos:** collected (item photos, PO/doc scans, order signatures, cycle-count scans, AI photo→ISBN, support screenshots → Supabase Storage); shared with Supabase (storage) + Anthropic Claude (AI photo-lookup only) + Google Books (text only); App functionality; **Optional**; persisted (do NOT mark ephemeral overall).
- **App activity:** collected (movements/orders/PO/count history — operational data, NOT analytics); not shared; App functionality; Required. **No third-party analytics SDK exists** — do not declare an Analytics purpose.
- **Device or other IDs:** collected (Expo push token → public.push_tokens); shared with Google FCM/Expo push to route notifications; App functionality; **Optional**.
- **Crash logs + Diagnostics:** collected via Sentry (`enabled:!__DEV__`, `sendDefaultPii:false`, 10% traces; device model/OS/app version still counts as Diagnostics); shared with Sentry; App functionality.
- **NOT collected:** Financial info (no billing SDK in app — confirm), Location (no expo-location), Health/Messages/Contacts/Calendar. **Biometric data NOT collected** — Face/Touch/Fingerprint is a local OS unlock gate; app stores only a boolean opt-in in SecureStore, never a template.

---

## CONTENT RATING (IARC) — paste-ready
Category in questionnaire: Utility/Productivity/Business. All answers **No** except:
- **Users can interact online: Yes** (order notes/comments, B2B portal, support replies — tenant-scoped, server-mediated; adds a cosmetic "Users Interact" descriptor, does not raise age).
- Violence/Sexuality/Language/Controlled substances/Gambling/Location-sharing/UGC-public: **No**.
- Digital purchases (Play Billing): **No** (confirm no in-app billing).
Expected result: **ESRB Everyone / PEGI 3 / Everyone**.

### Permission justifications (if Play asks)
- **CAMERA** (standard, no special form): "…scan barcodes/QR on inventory items and packages, and capture photos to attach to inventory records, POs, and document scans. Only invoked when the user opens the scanner/capture screen; no background capture."
- **READ_MEDIA_IMAGES** (Photo & Video Permissions declaration required IF kept — but recommended to REMOVE, see risk above): "…attach an existing photo from the gallery to an item/PO/support ticket as an alternative to the camera; single user-initiated selection; not a gallery/editor/social app."
- **POST_NOTIFICATIONS** (auto-injected by expo-notifications; verify in built AAB): "…push notifications for order approvals, task assignments, low-stock/reorder alerts, support replies; disable at OS level or per-type in-app."
