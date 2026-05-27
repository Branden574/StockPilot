# StockPilot — App Store launch runbook

End-to-end checklist for taking the mobile app from this repository to a
public App Store release. Updated 2026-05-27.

> Everything in this document that says **YOU** requires action by the
> account owner (paid services, Apple/Google portals, legal review).
> Everything that says **DONE** is already wired in the repo.

---

## 1. Apple Developer Program enrollment — **YOU**

1. Go to https://developer.apple.com/programs/enroll/ and sign in with your
   personal Apple ID (the one you want to own the developer account).
2. Pick **Individual** (no D-U-N-S number needed) unless you want the app
   listed under a company name — then pick **Organization** and prepare a
   D-U-N-S number (free, 5–10 day lead time via Dun & Bradstreet).
3. Pay the **$99/yr** membership. Activation usually takes 24–48 hours.
4. Once active, log in to https://appstoreconnect.apple.com and accept
   the most recent Program License Agreement.

You will end up with three identifiers Apple will ask for in `eas.json`:

| Field in `eas.json` | Where to find it |
| --- | --- |
| `appleId` | Your Apple Developer login email |
| `appleTeamId` | Apple Developer → Membership → Team ID (10 chars) |
| `ascAppId` | App Store Connect → My Apps → StockPilot → App Information → Apple ID (numeric) — generated after step 2 below |

Replace the `REPLACE_WITH_*` placeholders in [eas.json](eas.json) once you have them.

---

## 2. App Store Connect — create the listing — **YOU**

1. https://appstoreconnect.apple.com → **My Apps → + → New App**.
2. Fill in:
   - **Platform:** iOS
   - **Name:** `StockPilot`
   - **Primary Language:** English (U.S.)
   - **Bundle ID:** `app.stockpilot.mobile` (must match `app.config.ts` exactly; if it isn’t in the picklist, create it first at Apple Developer → Certificates, Identifiers & Profiles → Identifiers).
   - **SKU:** `stockpilot-ios-001` (internal label, any string)
   - **User Access:** Full Access
3. Note the numeric **Apple ID** in App Information — that’s the `ascAppId`.

### Listing fields to populate (draft copy provided in §6 below)

- **Subtitle** (30 chars)
- **Promotional text** (170 chars, editable post-release without re-review)
- **Description** (4000 chars)
- **Keywords** (100 chars, comma-separated)
- **Support URL** (`https://stockpilotusa.com/support` — needs to be live)
- **Marketing URL** (optional — your landing page)
- **Privacy Policy URL** — `https://stockpilotusa.com/privacy` ← **DONE** in this PR
- **EULA URL** — `https://stockpilotusa.com/terms` ← **DONE** in this PR (or leave blank to inherit Apple’s default)
- **Category** — *Productivity* (primary) / *Business* (secondary)
- **Age Rating** — 4+ (no questionable content)
- **Pricing** — Free (with no in-app purchases for now)

### Privacy nutrition label

Apple will walk you through a questionnaire. Honest answers based on the
current app:

- **Data linked to you:** Name, Email Address, Photos (only when user
  attaches one to an item), Sensitive Info: **None**, Diagnostics: **None**
- **Data used to track you:** **None**
- **Data not linked to you:** Crash data via Expo if you opt-in later
- **Tracking:** **No**

---

## 3. Push notifications credentials — **YOU + EAS**

1. Apple Developer → Certificates, Identifiers & Profiles → **Keys** → **+**.
2. Name it `StockPilot APNs`, check **Apple Push Notifications service (APNs)**.
3. Download the resulting `.p8` (you only get to download it once — store
   it somewhere safe like 1Password). Note the **Key ID** and your
   **Team ID**.
4. Upload to EAS:
   ```
   cd apps/mobile
   eas credentials
   ```
   Pick `iOS → Production → Push Notifications: Set up your Apple Push API Key`.
   It will prompt for the `.p8`, Key ID, and Team ID.

Without this, builds will install fine but `expo-notifications` won’t
actually deliver pushes to TestFlight or App Store builds.

---

## 4. EAS Build configuration — **DONE**

[eas.json](eas.json) defines three profiles:

| Profile | Purpose | Channel | API URL |
| --- | --- | --- | --- |
| `development` | Local dev client on the sim | none | `http://localhost:3000` |
| `preview` | TestFlight / internal QA | `preview` | `https://stockpilotusa.com` |
| `production` | App Store release builds | `production` | `https://stockpilotusa.com` |

### One-time setup

```
pnpm dlx eas-cli login          # uses your Expo account
cd apps/mobile
eas init                        # link this directory to an Expo project
```

### Set the Supabase env vars as **EAS secrets** so they ship in production builds:

```
eas env:create --scope project --name EXPO_PUBLIC_SUPABASE_URL --value 'https://YOUR_PROJECT.supabase.co' --visibility plaintext
eas env:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value 'YOUR_ANON_KEY' --visibility secret
```

Use **the production Supabase project** — not your dev one. If you have
a single Supabase project for now, that’s fine; just be aware that
TestFlight builds will hit live data.

### First build

```
eas build --platform ios --profile preview     # TestFlight build
eas build --platform ios --profile production  # App Store build
```

First build takes ~15–25 min. EAS will prompt for distribution cert + provisioning profile — let it generate them for you.

---

## 5. TestFlight beta — **YOU**

1. After the `preview` build finishes, run:
   ```
   eas submit --platform ios --profile production --latest
   ```
   This uploads the IPA to App Store Connect.
2. Wait ~10–30 minutes for Apple to process. The build appears under
   **TestFlight → Builds**.
3. Add yourself (and any beta testers) under **Internal Testing**. Internal
   testers don’t require Beta App Review.
4. Install the TestFlight app on your iPhone, accept the invite, install
   StockPilot. **Soak for at least a few days** with real-world use before
   submitting for App Review.

Things to actively poke during soak:

- Sign up / sign in / sign out
- Face ID enable/disable
- Push test from Settings
- Scan a barcode → adjust stock
- Pull-to-refresh on every list
- **Delete-account flow** (use a throw-away account)
- Airplane mode + reconnect → sync recovery
- Notifications received in foreground, background, and locked-screen states

---

## 6. App Store listing copy — **DRAFT**

Edit before submitting. Verify character counts in App Store Connect — it
will hard-truncate.

### Name (30 chars max)

```
StockPilot
```

### Subtitle (30 chars max)

```
Inventory built for the field
```

### Promotional text (170 chars, editable anytime)

```
Scan, count, restock — all from your phone. StockPilot syncs your inventory in real time and works offline when the warehouse Wi-Fi doesn’t.
```

### Description (4000 chars)

```
StockPilot is the inventory system field teams actually use.

Built for warehouses, schools, and multi-site operations that need to track items, books, locations, and purchase orders without fighting their software.

— SCAN ANYTHING —
Point your camera at a barcode, ISBN, or QR code. Stock moves before you put the phone down. Books resolve to title + author + cover automatically.

— ALWAYS IN SYNC —
Counts and movements made on the phone show up on the web dashboard instantly. Edits made on the web sync to the phone within 60 seconds. Pull-to-refresh on any list to force-sync.

— WORKS WITHOUT WI-FI —
Cycle counts, stock movements, and item lookups keep working when the warehouse signal dies. Changes queue locally and flush as soon as you’re back online.

— REAL FILTERS —
Filter items and books by category, location, charter, and stock status. Save the view you use most. Search by name, SKU, or barcode.

— FACE ID UNLOCK —
Sign in once, unlock with a glance after that. Your password never leaves your device.

— FULL WEB PARITY —
Books, Bundles, Orders, Rentals, Movements, Reports, Procedures, AI assistant — every surface from the web app is reachable from the phone’s drawer.

— PUSH NOTIFICATIONS —
Get notified when stock dips below reorder, when a PO is received, when a cycle count gets assigned to you.

— BUILT FOR TEAMS —
Multi-organization support, role-based permissions (owner / admin / staff), warehouse and charter-level access controls, full audit trail.

—

StockPilot mobile is a companion to the StockPilot web dashboard at stockpilotusa.com. You’ll need a StockPilot account (or an invite from your org owner) to sign in.

Privacy policy: stockpilotusa.com/privacy
Terms of service: stockpilotusa.com/terms
Support: hello@stockpilot.app
```

### Keywords (100 chars, comma-separated)

```
inventory,barcode scanner,warehouse,stock,cycle count,books,asset tracking,SKU,purchase order
```

### What’s New in This Version (4000 chars)

```
First public release. Welcome aboard.

• Scan barcodes, ISBNs, and QR codes from anywhere in the app
• Real-time sync with the StockPilot web dashboard
• Offline-capable cycle counts and stock movements
• Full filter parity with the web — category, location, charter, stock status, sort
• Face ID / Touch ID unlock
• Push notifications for low stock, PO receipts, and cycle-count assignments
• Books catalog with ISBN lookup
```

---

## 7. Screenshots — **TODO (semi-automated)**

Apple requires screenshots at the largest supported iPhone size. As of
2026, that’s **6.9-inch iPhone Pro Max** (1320 × 2868). At minimum
provide 3 screenshots; up to 10 allowed. iPad is optional — skip unless
you specifically want to launch on iPad.

Easiest path: take them in the iOS Simulator with `Cmd+S`, which drops a
PNG on the Desktop at the right pixel dimensions.

Recommended screen flow:

1. **Home** — Good-morning + stat cards
2. **Items** — list with a filter chip applied
3. **Filter sheet** — open
4. **Scan** — camera + Scan to adjust stock card
5. **Item detail** — with movements list visible

I (Claude) can run through the sim and generate these on request — just
ask: “grab App Store screenshots”.

---

## 8. Submit for App Review — **YOU**

1. App Store Connect → **App Store → iOS app → +Version (1.0.0)**
2. Attach the production build from §4.
3. Fill in **App Review Information**:
   - **Sign-in required:** Yes
   - **Demo account:** create a throwaway StockPilot account, give it
     access to a small demo org with a few items, and put the
     email/password here. Reviewers WILL use it — they will reject
     otherwise.
   - **Notes:** mention that the “Send test push” button only delivers
     to real devices (the simulator can’t register an APNs token), and
     that account deletion lives at Settings → Delete my account.
4. **Version Release:** “Automatically release this version”
5. **Submit for Review**.

Review timeline: usually 24–48 hours. If rejected, the most common
reasons given the current app shape are:

- **Guideline 5.1.1(v)** — Account deletion missing. Already wired.
- **Guideline 4.0** — UI bug or crash on reviewer’s test device. Make
  sure TestFlight soak is solid first.
- **Guideline 2.1** — Demo account doesn’t work. Test it from a fresh
  install before submitting.

---

## 9. After approval

- The app goes live at the time you specified.
- Subsequent submissions only need a new build + “What’s New” copy.
- Phased release (1% → 100% over 7 days) is enabled by default in App
  Store Connect — leave it on.

---

## Google Play (later)

Same general flow, different portal. Play Console enrollment is **$25 one-time**. EAS handles Android builds with `eas build --platform android --profile production` and submission with `eas submit --platform android`. You’ll need a Play Console service account JSON saved at the path referenced in `eas.json` (`secrets/play-store-service-account.json`).

Account deletion: Google Play has a parallel deletion requirement (Play Console → Policy → Account deletion). Point the URL field at `https://stockpilotusa.com/account/delete` (or document that deletion is in Settings) and they’ll accept it.

---

## Status snapshot (2026-05-27)

| Item | Status |
|---|---|
| Bundle ID configured | ✅ |
| Icon + splash wired in `app.config.ts` | ✅ |
| Privacy manifest (`PrivacyInfo.xcprivacy`) | ✅ |
| In-app account deletion | ✅ |
| `/privacy` + `/terms` pages | ✅ |
| `eas.json` build profiles | ✅ |
| App version → `1.0.0` | ✅ |
| Apple Developer account | ⏳ YOU |
| App Store Connect listing | ⏳ YOU |
| APNs key uploaded to EAS | ⏳ YOU |
| Production Supabase env vars in EAS | ⏳ YOU |
| Screenshots | ⏳ Ask Claude or take manually |
| TestFlight soak | ⏳ |
| Listing copy finalized | ⏳ Draft in §6 |
| Submitted for review | ⏳ |
