<!-- Provenance: compiled 2026-08-07. Installed-version figures are lockfile-resolved
     reads of this repository and are reproducible via the cited pnpm commands.
     Latest-version and advisory claims come from a primary-source research pass
     (npm registry, nextjs.org, react.dev, GitHub Advisory Database) and have not
     been independently re-confirmed by a human; spot-check before use in an
     attestation. Recommendations are version-hygiene actions valid on their own. -->

# Framework patch-level verification — StockPilot (security program section 8)

Date: 2026-08-07. Repo: /Users/brandenvincent-walker/Developer/InventorySystem (read-only). Monorepo: apps/web (Next.js on Vercel), apps/mobile (Expo/React Native).

## 1. Exact installed versions (from pnpm-lock.yaml + `pnpm -r why`)

| Package | Installed (exact, lockfile-resolved) | Declared range | Where |
|---|---|---|---|
| next | 16.3.0 | ^16.3.0 | apps/web |
| react | 19.2.5 | ^19.0.0 | apps/web |
| react-dom | 19.2.5 | ^19.0.0 | apps/web |
| react (mobile) | 19.0.0 | 19.0.0 (exact pin) | apps/mobile (required by RN 0.79 / Expo SDK 53) |
| @supabase/supabase-js | 2.105.1 | ^2.46.1 | apps/web + apps/mobile (same resolution) |
| @supabase/ssr | 0.5.2 | ^0.5.2 | apps/web (peers supabase-js 2.105.1) |
| @supabase/auth-js (bundled) | 2.105.1 | via supabase-js | both |
| expo | 53.0.27 (SDK 53) | ~53.0.0 | apps/mobile |
| react-native | 0.79.6 | 0.79.6 | apps/mobile |
| node (local dev) | v22.22.2 | engines: node >=20.11.0 (root package.json only) | machine |

Notes: `react-server-dom-webpack` (and -turbopack/-parcel) are NOT installed from npm — they appear in the lockfile only as an optional peer of next. The RSC runtime this app actually executes is Next.js's vendored copy inside the `next` package. That distinction drives the React verdict below.

## 2. Latest-patch comparison (primary sources: nextjs.org blog, GitHub releases, npm registry, GitHub Advisory DB)

### Next.js — installed 16.3.0, latest stable 16.3.0. CURRENT.
- npm dist-tag `latest` = 16.3.0, published 2026-08-03. No 16.3.x stable after it (canary line is at 16.3.1-canary.10).
- July 2026 security release (2026-07-21, first release of the new pre-announced monthly program) fixed 9 CVEs — 4 high: CVE-2026-64641 (DoS via Server Actions), CVE-2026-64642 (middleware/proxy bypass, Turbopack + single locale), CVE-2026-64645 (SSRF/open-redirect via rewrites/redirects with request-controlled hostname), CVE-2026-64649 (SSRF in Server Actions on custom servers); 5 medium: CVE-2026-64643/64644/64646/64647/64648. Patched in 16.2.11 and 15.5.21; the blog states the fixes are included in 16.3.0 stable.
- Post-July hardening: "Port ReplyServer traversal guards to FlightClient" (react/react PR 37144, merged 2026-07-29; Next backports #96405 to 15.x — released as 15.5.23 on 2026-08-07 — and #96407 to next-16-2, unreleased there). VERIFIED PRESENT in v16.3.0: the vendored `react-server-dom-webpack-client.node.production.js` at tag v16.3.0 carries the guard markers ("Invalid reference" x2, getPrototypeOf x6), matching v15.5.23 and the next-16-2 head; the pre-guard v16.2.12 shows x1/x4. So 16.3.0 contains hardening that 16.2.12 does not.
- Forward-looking: the security release program is monthly and pre-announced; expect an August 2026 release around mid-month. Treat it as a planned same-week patch window.

### React 19.x — installed 19.2.5 (web), latest 19.2.8. No advisory against the installed packages; routine bump advised.
- react 19.2.6 (2026-05-06), 19.2.7 (2026-06-01), 19.2.8 (2026-07-21) — each shipped in lockstep with 19.0.x/19.1.x on RSC security dates (19.2.8 landed the same day as Next's July security release).
- The RSC advisory series (CVE-2025-55182 "React2Shell" RCE, Dec 2025; CVE-2026-23864, Jan 2026; CVE-2026-23870 DoS, May 2026 — fixed in 19.0.6/19.1.7/19.2.6) lists `react-server-dom-webpack/-turbopack/-parcel` as the affected packages, NOT `react`/`react-dom`. Those packages are not installed here; this app's Flight/RSC surface is Next's vendored runtime, which 16.3.0 patches.
- Verdict: no security-relevant patch is pending against the react/react-dom actually installed. Bumping 19.2.5 -> 19.2.8 is cheap (already inside ^19.0.0), aligns with the coordinated security waves, and removes ambiguity in future audits. P2.
- Mobile react 19.0.0: RN app has no Flight server; RSC advisories do not apply. Expo SDK 53 pins react 19.0.0 exactly — do not bump independently (expo doctor validates it).

### @supabase/supabase-js — installed 2.105.1, latest 2.112.2. No security delta.
- GitHub Advisory DB: zero advisories against supabase-js 2.x and zero against @supabase/ssr. The only Supabase-client advisory is GHSA-8r88-6cj9-9fh5 (low, auth-js path routing, patched 2.70.0); bundled auth-js here is 2.105.1 — not affected.
- 2.105.1 -> 2.112.2 (2026-08-06) is feature/fix cadence (supabase ships ~weekly). Routine P2.
- @supabase/ssr 0.5.2 vs latest 0.12.4: large 0.x gap, no advisories. Upgrade deliberately (cookie-handling API has evolved across 0.x); do not fold into a routine bump without reading release notes. P3.

### Expo / mobile — expo 53.0.27 is the LATEST patch of SDK 53, but SDK 53 is past Expo's support window.
- npm `latest` = 57.0.11; SDK 53 line tops out at 53.0.27 (installed). Expo maintains roughly the last three SDKs (57/56/55) — SDK 53 should no longer expect fixes, security or otherwise.
- No published GHSA affects expo 53 or react-native 0.79 (the expo advisories on record are patched in 9.1/48.0; the RN ReDoS is 0.6x-era). CVE-2025-11953 (RN dev-server RCE in @react-native-community/cli-server-api) is dev-machine-only, not shipped in the production app.
- Exposure: if an RN/Expo security issue lands tomorrow, the fix path is SDK upgrade -> EAS native build -> store review (JS-only fixes via OTA remain possible for our own code, but framework-level native fixes are NOT OTA-deliverable, and runtimeVersion=appVersion means a store release). Lead time is weeks, so the upgrade should start before it is urgent. react-native 0.79.7 (2025-10-21) exists on the current line as a trivial interim bump if an EAS build ships for other reasons.

## 3. Runtime — Node on Vercel
- No Node pin: apps/web/vercel.json sets no runtime; apps/web/package.json has no engines; root engines (`node >=20.11.0`) is not the Vercel project root, so the project-settings value governs. Vercel default for NEW projects is 24.x; this project predates that — OWNER-VERIFY the actual setting (Project Settings -> Build and Deployment -> Node.js Version). If it reads 20.x, move it: Node 20 is EOL upstream (April 2026) and stopped receiving the July security fixes.
- Vercel automatically rolls out minor/patch security updates to its managed runtime, so the production patch level within the chosen major is Vercel's responsibility.
- Node security: the 2026-07-29 security release shipped v22.23.2 / v24.18.1 / v26.5.1 — 11 CVEs (3 high: HTTP/2 memory-limit evasion CVE-2026-56846, HTTP/2 use-after-free CVE-2026-56848, permission-model FS escape CVE-2026-58043) and bumped bundled undici (8.9.0/7.29.0/6.28.0 per line) + llhttp 9.4.3 — undici is the `fetch` implementation, directly relevant to server-side fetch. Local dev machine runs v22.22.2, which PREDATES this release — update local Node to 22.23.2+. CI uses setup-node `node-version: 22`, which resolves latest 22.x at run time — fine.

## 4. Verdict table

| Component | Installed | Latest patch | Security delta? | Action | Breaking-change risk |
|---|---|---|---|---|---|
| next (web) | 16.3.0 | 16.3.0 | No — installed IS the latest; contains July-2026 CVE fixes + FlightClient traversal guards (verified in vendored bundle) | None; patch same-week when the ~mid-August monthly security release lands | n/a |
| react / react-dom (web) | 19.2.5 | 19.2.8 | No advisory names react/react-dom; RSC CVEs target react-server-dom-* (not installed; vendored copy patched via next 16.3.0). 19.2.6/19.2.8 are security-wave companion releases | Upgrade-routine P2 (`pnpm up react react-dom` inside ^19.0.0) | Minimal (patch-level) |
| @supabase/supabase-js | 2.105.1 | 2.112.2 | No — no GHSA on 2.x; bundled auth-js 2.105.1 past the only (low) advisory | Upgrade-routine P2 | Low (minor-line cadence; smoke-test auth + realtime) |
| @supabase/ssr | 0.5.2 | 0.12.4 | No advisories | Upgrade-routine P3, deliberately (read 0.6-0.12 release notes) | Moderate (0.x cookie-API evolution) |
| expo (mobile) | 53.0.27 (SDK 53) | 53.0.27 on line; SDK 57 current | No published advisory, BUT line is out of Expo's ~3-SDK support window — no future security patches; native fixes not OTA-deliverable | Upgrade-routine P2 with priority: schedule SDK 53 -> 55+/57 migration + EAS build now, before it becomes P1 | High (native modules, RN 0.79 -> 0.8x, store release required) |
| react-native (mobile) | 0.79.6 | 0.79.7 on line | No (dev-server CVE-2025-11953 is dev-only) | Fold into SDK migration | High (with SDK jump) |
| node (Vercel runtime) | project setting unknown — OWNER-VERIFY | 22.23.2 / 24.18.1 (2026-07-29 security release) | Vercel auto-patches within the major; risk only if project pins EOL 20.x | Owner-verify setting; move to 22.x/24.x if on 20.x | Low (Next 16 supports both) |
| node (local dev) | 22.22.2 | 22.23.2 | Yes — predates 2026-07-29 release (3 HIGH CVEs, undici/llhttp bumps) | Upgrade-routine P2 (local only) | None |

## 5. Bottom line
Production web is in the best patch position it has ever been: next 16.3.0 is the newest stable in existence (released 2026-08-03), carries all nine July-2026 CVE fixes plus post-July RSC hardening, and no security-relevant newer patch exists for anything installed on the web side. The single largest real exposure is structural, not a pending patch: mobile sits on Expo SDK 53, which is past Expo's support window, and any framework-level security fix would require a multi-week SDK migration + EAS build + store review to deliver. Second watch item: the pre-announced Next.js monthly security release expected ~mid-August — plan a same-week patch window. Housekeeping: owner-verify the Vercel Node.js major (must not be 20.x), update local Node to 22.23.2+, and take react/react-dom to 19.2.8 with the next routine dependency pass.
