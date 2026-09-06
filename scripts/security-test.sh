#!/usr/bin/env bash
#
# `pnpm security:test` — the named security gate.
#
# WHY A SEPARATE GATE AT ALL
# --------------------------
# `pnpm test` already runs every suite in the monorepo, so on a green build this
# script proves nothing new. It exists for the two situations that are not a
# green build:
#
#   1. A failure here says "a security property broke", not "a test broke". That
#      distinction decides whether a red build can be merged around, and it is
#      lost when the assertion is one of several thousand.
#   2. It is runnable on its own, in seconds, without the full suite — which is
#      what makes it usable while writing a migration or a policy.
#
# The overlap with `pnpm test` is therefore deliberate. Do not "optimise" it away
# by removing these files from the main suite.
#
# EXPLICIT MANIFESTS, NOT GLOBS
# -----------------------------
# The suites are listed by path rather than selected by a naming pattern. This
# repo has at least six partial conventions for marking a security test
# (`*.security.test.ts`, `*.gates.test.ts`, `*-guard.test.ts`, `*-scope.test.ts`,
# `*-traversal.test.ts`, and a large number with no marker at all), so any glob
# either misses real coverage or drags in unrelated files. An explicit list is
# auditable: the security surface is readable in one place, and adding to it is a
# visible diff.
#
# THE MANIFEST POLICES ITSELF
# ---------------------------
# Every entry is checked to EXIST before anything runs, and a missing entry is a
# hard failure. This is not defensive padding. vitest positional arguments are
# substring filters: a filter matching zero files is not an error, so a renamed
# or deleted test file would silently shrink this gate while it kept reporting
# success. A security gate that can quietly stop checking things is worse than no
# gate, so the pre-check turns that into a red build.
#
# A second pre-check covers the other direction — a security suite that was
# written but never LISTED. See "PRE-CHECK 2" below for why it is apps/web only.
#
# ENVIRONMENT
# -----------
#   SECURITY_TEST_SKIP_DB=1   Skip the pgTAP section. Prints a loud SKIPPED line.
#                             For a machine with no Docker. CI must never set it.
#
# The pgTAP section needs the local Supabase stack running (`supabase start`),
# because `supabase test db` runs pg_prove against it. It does NOT apply
# migrations — start the stack first, and if you have added a migration since,
# reset the local database before trusting a pass.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

RED=''
GREEN=''
YELLOW=''
BOLD=''
RESET=''
if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
fi

say()  { printf '%s\n' "$*"; }
head2() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
fail() { printf '%sFAIL%s %s\n' "$RED" "$RESET" "$*" >&2; }
pass() { printf '%sok%s   %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%sSKIPPED%s %s\n' "$YELLOW" "$RESET" "$*"; }

# ═══════════════════════════════════════════════════════════════════════════
# MANIFEST 1 — pgTAP database invariants (supabase/tests/)
#
# security_invariants.test.sql is the allowlist-based sweep over whole classes
# of object (see docs/security/SECURITY-INVARIANTS.md). Everything else proves a
# specific security fix and is here because a regression in it is a security
# regression, not a feature bug.
# ═══════════════════════════════════════════════════════════════════════════
PGTAP_TESTS=(
  # The class-wide invariant sweep — anon/PUBLIC execute posture, RLS coverage,
  # view security_invoker, predicate tautologies, storage-path floor, buckets.
  supabase/tests/security_invariants.test.sql

  # Tenant isolation and cross-tenant write holes.
  supabase/tests/0201_location_org_guard_test.sql
  supabase/tests/0202_item_stock_levels_org_check_test.sql
  supabase/tests/0203_fk_org_consistency_test.sql
  supabase/tests/0204_charter_fk_org_consistency_test.sql
  supabase/tests/0205_supplier_fk_org_consistency_test.sql
  supabase/tests/0206_recurring_po_templates_write_test.sql
  supabase/tests/0217_crownjewel_critical_rls_fixes.test.sql
  supabase/tests/0229_inventory_select_rls_hashed_sets.test.sql
  supabase/tests/0300_product_group_org_immutable.test.sql
  supabase/tests/0321_movement_read_scope_and_attribution.test.sql
  supabase/tests/0322_quantity_guards_avatar_scope_override_clears.test.sql
  # AR-2 — the warehouse-scope RLS floor, and the org-level location scope that
  # decides which locations a scoped counter may even see.
  supabase/tests/0331_ar2_warehouse_scope.test.sql
  supabase/tests/0343_cycle_count_org_level_location_scope.test.sql

  # Authorization, permissions, privilege escalation.
  supabase/tests/0207_permission_overrides.test.sql
  supabase/tests/0208_po_write_has_permission.test.sql
  supabase/tests/0209_realtime_permission_overrides.test.sql
  supabase/tests/0212_has_permission_write_rollout.test.sql
  supabase/tests/0215_permission_override_no_escalation.test.sql
  supabase/tests/0218_lock_org_billing_columns.test.sql
  supabase/tests/0219_org_module_minplan_rls.test.sql
  supabase/tests/0220_org_members_insert_owner_guard.test.sql
  supabase/tests/0236_picking_rpcs_warehouse_scoped.test.sql
  supabase/tests/0279_auditor_read_permissions.test.sql
  supabase/tests/0282_cycle_count_assignment_lock.test.sql

  # Function privilege posture (the P0 class).
  supabase/tests/0318_secdef_grants.test.sql
  supabase/tests/0329_function_grants_and_search_path.test.sql
  # 0341 also carries the behaviour change, but the SECURITY DEFINER
  # self-authorization inside publish_outbox is the security property: before it,
  # every non-admin's outbox event was silently dropped by RLS inside a
  # best-effort try/catch, so connectors only ever heard admins.
  supabase/tests/0341_manual_writeoff_any_mode_and_outbox_secdef.test.sql

  # Account disable / session revocation.
  supabase/tests/0308_account_disable.test.sql
  supabase/tests/0309_pin_user_profile_disable_flags.test.sql
  supabase/tests/0310_rls_blocks_disabled_accounts.test.sql
  supabase/tests/0311_restrict_disable_reason_visibility.test.sql
  supabase/tests/0311_user_can_access_inventory_disable_guard.test.sql
  supabase/tests/0312_close_disable_residual_gaps.test.sql
  supabase/tests/0313_stop_notifying_disabled_accounts.test.sql

  # Account identity: verified self-service email change (projection pin + sync).
  supabase/tests/0345_verified_email_change.test.sql

  # Storage and attachment exposure.
  supabase/tests/0026_avatar_logo_buckets.test.sql
  supabase/tests/0142_order_attachments_read_floor.test.sql
  supabase/tests/0315_maintenance_photos_bucket.test.sql
  supabase/tests/0323_storage_path_shape_constraints.test.sql
  supabase/tests/0324_validate_storage_path_and_nonneg_constraints.test.sql
  supabase/tests/0326_storage_path_floor_completion.test.sql

  # Auth material and trusted writers.
  supabase/tests/0025_notification_writers.test.sql
  supabase/tests/0027_mfa_recovery_codes.test.sql
  supabase/tests/0330_share_token_hash_at_rest.test.sql

  # AI read scoping.
  supabase/tests/0320_semantic_search_org_scope.test.sql
)

# ═══════════════════════════════════════════════════════════════════════════
# MANIFEST 2 — apps/web vitest, paths relative to apps/web/
# ═══════════════════════════════════════════════════════════════════════════
WEB_TESTS=(
  # Storage path traversal (HI-8) and upload content verification.
  src/lib/storage-path.test.ts
  src/server/services/storage-path-traversal.test.ts
  src/lib/image-signature.test.ts
  src/server/actions/profile.test.ts
  src/server/services/item-images.test.ts
  src/server/services/public-items.test.ts

  # Declared-type spoofing: the bytes decide the type, never the caller's word.
  # The 2026-08-21 wave (see project_upload_security_hardening) — a sniffer, a
  # PDF/zip threat scanner, and the three write paths that must consult them.
  # A regression here re-opens "upload an HTML/JS payload as image/png".
  src/lib/file-signature.test.ts
  src/lib/document-threat-scan.test.ts
  src/server/services/attachment-byte-guard.test.ts
  src/server/services/capture-byte-guard.test.ts
  src/server/services/po-imports.scan-byte-verification.test.ts

  # AI boundaries: org-scoped tool reads, prompt-injection containment, SSRF.
  src/lib/ai/tools.security.test.ts
  src/lib/ai/untrusted.test.ts
  src/lib/ai/chat.write-guard.test.ts
  src/app/api/books/extract-isbns-ai/route.gates.test.ts
  src/app/api/v1/items/upc-lookup/route.gates.test.ts
  src/lib/ssrf-guard.test.ts
  # The book-cover rehost is the one place the server fetches a caller-supplied
  # URL and stores the bytes; these pin the host allowlist and redirect posture.
  src/server/services/books-import.ssrf.test.ts

  # Authorization gates on server actions and routes.
  src/app/api/orders/[id]/signature/route.test.ts
  src/server/actions/po-imports.gates.test.ts
  src/server/actions/purchase-orders.gates.test.ts
  src/server/actions/purchase-orders.destination-gate.test.ts
  src/server/services/po-imports.approval-threshold.test.ts
  src/server/services/po-imports.presign.test.ts
  src/server/services/purchase-orders.approval.test.ts

  # Permissions and escalation.
  src/server/actions/permissions.override-clear.test.ts
  src/server/actions/permissions.auditor-preset.test.ts
  'src/app/(dashboard)/dashboard/auditor-read-gates.test.tsx'

  # Identity, MFA, sessions, API keys.
  src/lib/auth/api-context.aal.test.ts
  # HI-6 pinned on BOTH auth paths: an ENROLLED user under an 'optional' org
  # policy still requires AAL2, so a stolen password alone cannot pass the gates.
  # context.mfa.test.ts below is the web twin — keep the pair together.
  src/lib/auth/api-context.mfa.test.ts
  src/lib/auth/platform-admin.test.ts
  src/lib/auth/platform-passphrase.test.ts
  src/lib/auth/api-key.test.ts
  src/lib/auth/access-predicate.test.ts
  src/lib/auth/account-status.test.ts
  src/server/services/context.mfa.test.ts
  src/app/auth/confirm/route.test.ts
  src/server/actions/auth.change-password.test.ts
  src/server/actions/auth.password-reset.test.ts
  src/server/actions/auth.account-disabled.test.ts
  src/server/actions/auth-error-classify.test.ts
  src/server/actions/mfa-recovery.test.ts
  src/server/services/platform/sessions.test.ts
  src/server/services/team.remove-member-sessions.test.ts

  # Output safety and information leakage.
  src/server/services/service-error.test.ts
  src/lib/safe-return-path.test.ts
  src/lib/exports/filename.test.ts
  src/server/security/monitors.test.ts
  src/server/services/maintenance-share-links.test.ts
  'src/app/m/[token]/photo/[n]/route.test.ts'
  # MED-26 / migration 0330 — a /r or /m share token is a bearer credential, so
  # only its hash may exist at rest; the plaintext column is gone and the value
  # is shown once. The DB half is 0330 in MANIFEST 1.
  src/server/services/public-links-token-hash.test.ts
  # Signed storage URLs, tokens and keys must never reach a log line or an
  # error payload.
  src/lib/redact-urls.test.ts
  # MED-24 — attribute-context escaping in the shared email components. These
  # templates interpolate org- and user-supplied text into href/style contexts.
  src/lib/email/es/components.escaping.test.ts
  # MED-27/28 — the emitted header set: no Supabase CSP wildcard, popup-safe
  # COOP, CORP. Asserted as properties, not as the literal strings.
  src/test/security-headers.test.ts

  # Warehouse scoping (defence in depth behind the RLS policies).
  src/lib/warehouse-scope.test.ts
  src/lib/locations/scope.test.ts
)

# ═══════════════════════════════════════════════════════════════════════════
# MANIFEST 3 — apps/mobile vitest, paths relative to apps/mobile/
#
# Mobile's security surface is narrower by construction: it holds no RLS policy
# and signs no storage URL. What it does own is the disabled-account eviction
# path and scope filtering over its offline cache.
# ═══════════════════════════════════════════════════════════════════════════
MOBILE_TESTS=(
  src/lib/account-disabled-probe.test.ts
  src/lib/account-disabled-state.test.ts
  src/lib/account-disabled-wiring.test.ts
  src/lib/account-eviction.test.ts
  src/lib/remembered-identity.test.ts
  src/lib/cta-gating.test.ts
  src/lib/warehouse-scope.test.ts
)

# ═══════════════════════════════════════════════════════════════════════════
# MANIFEST 4 — packages/core vitest, paths relative to packages/core/
# ═══════════════════════════════════════════════════════════════════════════
CORE_TESTS=(
  src/constants/permissions.test.ts
  src/auth/account-status.test.ts
  src/schemas/inventory.test.ts
  src/signature/signature.test.ts
)

# ═══════════════════════════════════════════════════════════════════════════
# PRE-CHECK — every manifest entry must exist.
# ═══════════════════════════════════════════════════════════════════════════
head2 "Manifest pre-check"
MISSING=()
for f in "${PGTAP_TESTS[@]}";  do [ -f "$ROOT/$f" ]                || MISSING+=("$f"); done
for f in "${WEB_TESTS[@]}";    do [ -f "$ROOT/apps/web/$f" ]       || MISSING+=("apps/web/$f"); done
for f in "${MOBILE_TESTS[@]}"; do [ -f "$ROOT/apps/mobile/$f" ]    || MISSING+=("apps/mobile/$f"); done
for f in "${CORE_TESTS[@]}";   do [ -f "$ROOT/packages/core/$f" ]  || MISSING+=("packages/core/$f"); done

if [ ${#MISSING[@]} -gt 0 ]; then
  fail "${#MISSING[@]} manifest entr(y/ies) do not exist on disk:"
  for f in "${MISSING[@]}"; do say "       $f"; done
  say ""
  say "A vitest path filter that matches nothing is NOT an error, so a stale"
  say "manifest would shrink this gate silently. Fix the path or remove the"
  say "entry in scripts/security-test.sh — deliberately, with the reason in the"
  say "commit message."
  exit 1
fi
pass "$(( ${#PGTAP_TESTS[@]} + ${#WEB_TESTS[@]} + ${#MOBILE_TESTS[@]} + ${#CORE_TESTS[@]} )) manifest entries all present"

# ═══════════════════════════════════════════════════════════════════════════
# PRE-CHECK 2 — the apps/web manifest must also be COMPLETE.
#
# WHY THIS EXISTS (2026-09, audit finding SP-029)
# -----------------------------------------------
# The pre-check above only catches manifest entries that DISAPPEAR. It says
# nothing about security suites that were never added, and between #92 and this
# audit nine of them accumulated unlisted — the byte-verification wave
# (file-signature, document-threat-scan, the three byte guards), the /r token
# hash, the api-context MFA inversion, the books-import SSRF properties, and URL
# redaction. Each one still ran under `pnpm test`, so CI went red on a
# regression, but the step named "Security invariants" stayed GREEN — and this
# script's whole reason to exist (see the header) is that the LABEL on a red
# build decides whether it gets merged around. A gate that silently stops
# growing rots exactly as fast as one that silently shrinks.
#
# This is a DISCOVERY check, not a selection glob. The manifests above are still
# explicit paths; nothing is ever run because it matched a pattern. All this
# does is refuse to let a file that announces itself as a security suite sit
# outside the manifest unnoticed.
#
# WEB ONLY, DELIBERATELY. The same idea over supabase/tests/ is useless: the
# words that mark a pgTAP file as security-relevant ('RLS', 'security definer',
# 'grants', 'search_path') appear in the first 40 lines of 81 of the 145 files
# there, because almost every table in this schema has RLS and almost every
# fixture mentions it. That check would demand classifying half the suite and
# would be turned off within a week. pgTAP additions stay a human decision.
#
# It is a FLOOR, not a ceiling. Most of WEB_TESTS matches no pattern at all and
# was added by judgement; five of the nine suites this audit added (the sniffer,
# the threat scanner, two byte guards, the api-context MFA twin) do not match
# this marker either. Passing it does not mean the manifest is complete — it
# means nothing that ANNOUNCED itself was ignored.
#
# If this fails on a file that is NOT a security-property suite, the answer is
# to reword its header comment, not to weaken the pattern. Do not extend the
# marker to the filename conventions listed in the header above: `*-guard`
# alone pulls in rack-shape.inventory-guard.test.ts, which is a warehouse
# labelling regression guard with no security content.
# ═══════════════════════════════════════════════════════════════════════════
WEB_SECURITY_MARKER='Security (wave|MED-|HI-|invariant)|SSRF|token hash at rest|byte guard'

UNLISTED=()
while IFS= read -r abs; do
  rel="${abs#apps/web/}"
  # Exact-element membership: every entry is a bare `src/...` path, so padding
  # both sides with spaces cannot match a prefix of a longer path.
  case " ${WEB_TESTS[*]} " in
    *" $rel "*) continue ;;
  esac
  UNLISTED+=("$rel")
done < <(
  find apps/web/src \( -name '*.test.ts' -o -name '*.test.tsx' \) -print \
    | sort \
    | while IFS= read -r f; do
        head -40 "$f" | grep -qE "$WEB_SECURITY_MARKER" && printf '%s\n' "$f"
      done
)

if [ ${#UNLISTED[@]} -gt 0 ]; then
  fail "${#UNLISTED[@]} apps/web suite(s) announce themselves as security tests but are not in WEB_TESTS:"
  for f in "${UNLISTED[@]}"; do say "       $f"; done
  say ""
  say "Add each to the WEB_TESTS manifest in scripts/security-test.sh, under the"
  say "section that matches the property it pins. If one of these is not really a"
  say "security-property suite, reword its header comment — do not loosen the"
  say "marker pattern, because that turns this check off for everything."
  exit 1
fi
pass "no unlisted apps/web security suites"

FAILED=()

# ═══════════════════════════════════════════════════════════════════════════
# 1. pgTAP database invariants
# ═══════════════════════════════════════════════════════════════════════════
head2 "Database invariants — pgTAP (${#PGTAP_TESTS[@]} files)"
if [ "${SECURITY_TEST_SKIP_DB:-0}" = "1" ]; then
  warn "pgTAP skipped because SECURITY_TEST_SKIP_DB=1. The database half of the"
  warn "security gate did NOT run. Do not read this run as a pass."
else
  if pnpm exec supabase test db "${PGTAP_TESTS[@]}"; then
    pass "pgTAP database invariants"
  else
    fail "pgTAP database invariants"
    say ""
    say "If this failed to CONNECT rather than to assert, the local Supabase"
    say "stack is not running: \`pnpm exec supabase start\`. If you have added a"
    say "migration since the stack came up, \`pnpm db:reset\` first — a pass"
    say "against a stale schema means nothing."
    FAILED+=("pgTAP")
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# 2-4. Application-layer suites
# ═══════════════════════════════════════════════════════════════════════════
run_vitest() {
  local label="$1" pkg="$2"; shift 2
  head2 "$label — vitest ($# files)"
  if pnpm --filter "$pkg" exec vitest run "$@"; then
    pass "$label"
  else
    fail "$label"
    FAILED+=("$label")
  fi
}

run_vitest "Web application"  "@stockpilot/web"    "${WEB_TESTS[@]}"
run_vitest "Mobile client"    "@stockpilot/mobile" "${MOBILE_TESTS[@]}"
run_vitest "Shared core"      "@stockpilot/core"   "${CORE_TESTS[@]}"

# ═══════════════════════════════════════════════════════════════════════════
# Verdict
# ═══════════════════════════════════════════════════════════════════════════
head2 "Security gate"
if [ ${#FAILED[@]} -gt 0 ]; then
  fail "${#FAILED[@]} section(s) failed: ${FAILED[*]}"
  say ""
  say "Treat a failure here as a security regression until proven otherwise."
  say "Do not adjust an assertion to make it pass — the assertions are the"
  say "specification. See docs/security/SECURITY-INVARIANTS.md."
  exit 1
fi
pass "all sections passed"
if [ "${SECURITY_TEST_SKIP_DB:-0}" = "1" ]; then
  warn "reminder: the pgTAP half was skipped, so this is a partial result."
fi
