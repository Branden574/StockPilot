# Dependency hardening — August 2026

Remediation record for the 18 open Dependabot alerts on `main` as of 2026-08-07.
Companion documents: `current-threat-intelligence.md` (section 6 of the security
program) and `framework-patch-verification.md` (section 8).

## What the alert set actually was

Reconciled against the GitHub Dependabot API on 2026-08-07: **18 open alerts —
12 high, 6 moderate, zero critical.** Every one was transitive except `sharp`,
and every one surfaced through `pnpm-lock.yaml`.

A repository banner had been reporting "29 vulnerabilities (1 critical)". That
count is stale: a query across `open`, `fixed`, `dismissed` and `auto_dismissed`
states returned **no critical alert in any state**, and the GraphQL
`vulnerabilityAlerts` recount agrees at 18 (12 HIGH, 6 MODERATE). Treat the API
counts, not the banner, as authoritative.

## Before and after

All "after" values are resolved versions read back out of the committed lockfile,
not declared ranges.

| Package | Before | After | Alerts closed | Reached via |
|---|---|---|---|---|
| `sharp` | 0.34.5 | **0.35.3** (libvips 8.18.3) | GHSA-f88m-g3jw-g9cj (libvips heap-overflow set, 2 rated high) | direct dependency of `apps/web` |
| `undici` | 8.5.0 | **8.10.0** | 5 (cross-user information disclosure, CRLF injection, response desync, cookie-attribute injection, shared-cache poisoning) | direct in `apps/web` + Node/Expo chains |
| `brace-expansion` (1.x) | 1.1.14 | **1.1.18** | 2 | eslint / tooling chains |
| `brace-expansion` (2.x) | 2.1.0 | **2.1.4** | 2 | eslint / tooling chains |
| `brace-expansion` (5.x) | 5.0.6 | **5.0.9** | 2 | eslint / tooling chains |
| `postcss` | 8.5.12 | **8.5.26** | 1 (CVE-2026-69153) | Next.js / build chain |
| `dompurify` | ≤3.4.12 | **3.4.13** | 1 (GHSA-55q2-fjhq-7xh7) | PDF/markdown chain |
| `fast-uri` | 3.1.2 | **3.1.5** | 2 (host confusion via IDN + backslash authority) | dev tooling (ajv) |

**16 of 18 alerts resolved.** `sharp` matters most in practice: this application
feeds it genuinely untrusted input (user-uploaded item photos, HEIC conversion,
catalog masters), so libvips memory-safety fixes are load-bearing rather than
theoretical.

### The two that remain open, and why

`image-size` CVE-2025-71329 and CVE-2025-71330 (JXL/HEIF and ICNS parser
denial-of-service) have **no patched release available upstream**: GitHub reports
`first_patched_version: none`, and npm's newest published version (2.0.2) is
itself in the vulnerable range. There is nothing to upgrade to.

They were deliberately left untouched rather than papered over:

- Exposure is limited to `metro`, the React Native **development** bundler. The
  package is not reachable from `apps/web` runtime code and is never shipped in
  the mobile bundle or the web deployment.
- Resolved version is unchanged at 1.2.1.
- **Do not dismiss these alerts without owner sign-off.** They should stay open
  as a standing reminder to watch for an upstream fix; a dismissal would silently
  drop that signal.

## Override discipline

Transitive fixes use `pnpm.overrides` in the root `package.json`, and every key
is **version-scoped**:

```
"brace-expansion@1": "^1.1.18",
"brace-expansion@2": "^2.1.4",
"brace-expansion@5": "^5.0.9",
"postcss@8":         "^8.5.23",
"dompurify@3":       "^3.4.13",
"fast-uri@3":        "^3.1.5",
"undici@6":          "^8.9.0",
"undici@8":          "^8.9.0",
```

This is not stylistic. A bare `"brace-expansion": "^5.0.9"` would force a v5
major onto consumers that declare v1 or v2, which is exactly how the June 2026
`js-yaml` override incident broke installs. Scoping each key to its own major
patches every vulnerable line **within** that line. The corollary is a
maintenance obligation: a new major of an overridden package needs a **new
scoped key**, because the existing keys will not match it.

## Mobile / over-the-air impact

**No change to the shipped OTA bundle.**

- `apps/mobile/package.json` is byte-identical (confirmed absent from the commit
  diff), so `runtimeVersion` is unaffected.
- The touched packages that appear anywhere under mobile's tree — `undici`,
  `postcss`, `brace-expansion` — are reachable only through `@expo/cli`,
  `@expo/metro-config`, `metro` and `eslint`: Node-side build and dev tooling
  that Metro never bundles into the app.
- `sharp` and `dompurify` are not reachable from `apps/mobile` at all.
- No native-module version shifted.

## Verification performed

- Resolved-version read-back from the committed `pnpm-lock.yaml` for all eight
  packages (the table above).
- `pnpm audit --prod` reports zero findings for any package in the alert set.
- Full gate run: core, web and mobile test suites; typecheck on all three
  packages; web lint; `pnpm --filter web build` (which exercises the new `sharp`
  native binary).
- Commit scope audited: three files (`apps/web/package.json`, root
  `package.json`, `pnpm-lock.yaml`) and nothing else.

## Open follow-ups — NOT done in this change

Recorded here so they are tracked rather than remembered.

1. **Supply-chain tooling hardening (P1).** `pnpm` 9.12.3 executes package
   lifecycle scripts by default. Migrating to pnpm 10.x with an
   `onlyBuiltDependencies` allowlist removes that execution path, and setting
   `minimumReleaseAge` to several days prevents a freshly-published malicious
   version from resolving at all. CI already installs with `--frozen-lockfile`;
   this closes the developer-workstation path. See the threat-intelligence
   document for the campaign context.

2. **Residual `pnpm audit --prod` tail (P1).** Twelve advisories remain outside
   the Dependabot alert set, all denial-of-service class in tooling chains, one
   rated critical (`tar`). Several already have overrides whose floors have gone
   one release stale. Fix by raising the existing scoped floors (`tar@7`,
   `shell-quote`, `js-yaml@3`, `js-yaml@5`) and adding `nanoid@3`, then
   reinstalling and re-running to zero. Note `js-yaml` is the permanently-
   dismissed alert from a prior cycle — the override, not the alert, is what
   needs moving.

3. **`undici` override topology cleanup (P2).** A pre-existing override already
   forced v6-declaring consumers onto a resolved v8 before this change; that
   topology was preserved and merely moved to a patched 8.x. It is not a new
   major jump, but `apps/web` still *declares* `^6.27.0` while *running* 8.x.
   Align the declaration with reality so the next reader is not misled.

4. **Local development Node (P2).** The development machine runs 22.22.2, one
   security release behind 22.23.2. Production is unaffected (Vercel patches the
   managed runtime within the chosen major), but the Vercel project's Node major
   should be owner-verified — it must not be sitting on an end-of-life 20.x.

5. **Expo SDK 53 end-of-support — owner decision, and the most strategically
   important item here.** Mobile runs Expo SDK 53, which is the newest patch of
   that line (53.0.27) but is past Expo's roughly three-SDK support window. No
   published advisory affects it today. The problem is the *response path*: if a
   framework-level native security issue lands, the fix requires an SDK
   migration, an EAS native build and a store review — weeks of lead time — and
   is **not** deliverable over the air. JS-only fixes to our own code remain
   OTA-deliverable. This should be scheduled while it is routine rather than
   waited on until it is an incident.
