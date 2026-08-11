<!-- Provenance: compiled 2026-08-10. Every rule below is either implemented in a
     file in this repository (path cited) or is a standing operational rule with
     a named incident behind it. Provider console steps (Supabase, Vercel, EAS)
     were not re-walked while writing this and should be spot-checked against the
     current UI on first use; the sequence they encode is what matters and does
     not change with the UI. -->

# Secrets policy

How credentials are stored, handled, reported and rotated. Two of the rules here
exist because of specific incidents in this project, and those are marked.

## 1. Where secrets live

| Class                                 | Location                                                   | Notes                                                                                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local development                     | `~/Developer/stockpilot-env/` — **outside the repository** | Symlinked back to `apps/web/.env.local`, `apps/web/.env.local.prod`, `apps/mobile/.env.local` so `next dev` and `expo start` load them transparently. See [`docs/runbooks/env-files.md`](../runbooks/env-files.md). |
| Production, web                       | Vercel project environment variables                       | The authority for anything the deployed web app reads.                                                                                                                                                              |
| Production, mobile                    | EAS secrets / `eas.json`                                   | Note the trap below about `EXPO_PUBLIC_*`.                                                                                                                                                                          |
| Database-held integration credentials | Supabase Vault                                             | Connector OAuth tokens, carrier API keys. A cross-project restore changes the encryption context — treat connectors as needing reconnection.                                                                        |

Nothing secret is in git. The real env files were moved out of the working tree
on 2026-06-26 specifically so that "secret material never sits inside the
repository directory", not merely "never gets committed".

**Mobile trap worth restating**: `eas update` inlines `EXPO_PUBLIC_*` values from
the local env file at `~/Developer/stockpilot-env/`, **not** from `eas.json`. An
OTA built on a machine with a stale or wrong local env ships those values into the
bundle.

## 2. Never expand a secret in a shell

This is the rule that gets broken by accident, so it is stated first and
absolutely.

**Never write a command that expands a secret variable — including a command
whose only purpose is to check whether the variable is set.**

```bash
# WRONG — prints the VALUE when the variable IS set
echo "${SUPABASE_SERVICE_ROLE_KEY:-unset}"

# WRONG — same problem, and the value lands in the log
[ "$STRIPE_SECRET_KEY" != "" ] && echo "$STRIPE_SECRET_KEY"

# RIGHT — tests presence, prints nothing
[ -n "$SUPABASE_SERVICE_ROLE_KEY" ] && echo "service-role key: set"

# RIGHT — presence of a key in a file, by name only
grep -q '^SUPABASE_SERVICE_ROLE_KEY=' apps/web/.env.local && echo "present"
```

`${VAR:-fallback}` is the specific trap: it reads like a safety net and is
usually written to avoid an unbound-variable error, but the fallback only applies
when the variable is **empty**. When it is set — the case you are checking for —
the substitution prints the value. Terminal scrollback, CI logs, shell history
and any transcript of the session then contain a live credential, and it has to
be rotated.

Corollaries:

- Do not `cat`, `head`, `less` or open an env file to "see what's in it". Use
  `grep -q '^KEY='` to confirm a key is present by name.
- Do not paste a secret into a chat, an issue, a commit message, a screenshot or
  a support ticket. Anything pasted is compromised and must be rotated — see
  `SECURITY.md`, which already states this for `STRIPE_WEBHOOK_SECRET` and
  `CRON_SECRET`.
- Do not print a secret to prove a fix worked. Prove it with the behaviour that
  depends on the secret (a 200 instead of a 401), not with the value.

## 3. Never commit a secret, even temporarily

There is no "temporarily" in git. A commit that contains a secret has published
it to every clone and every reflog, and rewriting history does not recall it. The
only remediation is rotation.

Three layers enforce this, and all three are already wired:

1. [`scripts/check-no-committed-env.sh`](../../scripts/check-no-committed-env.sh) —
   runs as the first step of the CI `Lint + Typecheck` job. It is
   **default-deny**: any tracked file whose basename is `.env` or begins with
   `.env.` fails, and only `*.example` / `*.sample` are allowed back. That
   inversion is the postmortem finding from the 2026-05-17 incident, where
   `apps/web/.env.local.prod` — a backup of production credentials — slipped past
   a forbid-list of specific suffixes because the filename ended in `.prod`
   rather than `.local`.
2. `.gitignore` matches every plausible env-file shape regardless of suffix order
   (`.env`, `.env.*`, `*.env`, `.env*`, and the `**/` variants), with
   `!.env.example` negated back in.
3. TruffleHog in [`.github/workflows/security-scan.yml`](../../.github/workflows/security-scan.yml),
   run with `--only-verified` so it flags **only** credentials it can confirm are
   live. Near-zero false positives is what makes failing the build on a hit safe.
   Semgrep's `p/secrets` ruleset runs in the same workflow.

A GitGuardian ignore exists for exactly one file
([`.gitguardian.yaml`](../../.gitguardian.yaml)) and documents why: the platform
passphrase module is a pure scrypt utility whose `'NFKC'` string literal
false-positives the generic password detector. Adding to that list requires the
same standard of proof.

## 4. Report a secret by location, never by value

When a secret is found where it should not be — in a file, a log, a code review,
a screenshot — **report `FILE:LINE` and the credential's name. Never the value,
not even truncated.**

```
apps/web/src/lib/foo.ts:42 — hardcoded SUPABASE_SERVICE_ROLE_KEY
```

Not "the key starts with `sb_secret_...`". A prefix identifies the credential
type and narrows a brute-force; a partial value is still a disclosure, and it
propagates into the very transcripts and tickets that made the original finding a
problem. The person fixing it can open the file.

The same rule applies to a secret found in a log or a monitoring alert: cite
where the log line is, not what it said.

## 5. Rotation runbook

### The shape, and why the last step is the one that matters

```
1. Rotate at the provider          (mint the new credential)
2. Update every consumer           (Vercel env, EAS secret, local env file)
3. REDEPLOY                        (Vercel)
4. Verify a privileged path        (the canary below)
5. Revoke the old credential       (at the provider)
```

**Step 3 is not optional and is not implied by step 2.** Vercel environment
variables are read at **build/boot** time. Changing a value in the dashboard has
**no effect on the running deployment**. A rotation that stops after step 2 leaves
production authenticating with the old credential until something unrelated
triggers a deploy.

### The outage this encodes

On 2026-07-21 the Supabase service-role keys were rotated and the new value was
not propagated and redeployed. Every code path that goes through
`createAdminClient()` began returning **401**, while ordinary reads through the
user-authenticated client kept working normally.

That asymmetry is the thing to internalize, because it defeats casual checking:
**the site looked up.** The dashboard loaded, inventory rendered, sign-in worked.
What failed was the privileged half — webhooks, cron routes, admin tooling,
invite preflight, the rate limiter — and none of those are visible on a page
load. Anyone verifying "is the app fine?" by opening the app got a false green.

The fix was: mint a new secret key, set it in Vercel, and **redeploy**.

### The canary — verify a privileged path, not a page

After any rotation touching Supabase, exercise something that _requires_ the
service-role client, and confirm it succeeds:

- A cron route with its `CRON_SECRET`. It uses the admin client and returns JSON
  you can read, so a 401 is unambiguous.
- Or any admin-client-backed flow whose failure is visible: an invite send, a
  rate-limited action, a notification dispatch.

Do **not** treat "the dashboard loads" as verification. That is exactly the
signal that lied during the 2026-07-21 outage.

### Per-credential notes

| Credential                                           | Rotate at                              | Consumers to update                                                   | Redeploy needed                                                                                                      |
| ---------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Supabase service-role / secret key (`sb_secret_*`)   | Supabase → Project Settings → API keys | Vercel (production + preview), local `.env.local` / `.env.local.prod` | **Yes** — the 2026-07-21 outage                                                                                      |
| Supabase publishable / anon key (`sb_publishable_*`) | Same                                   | Vercel, local env, **mobile env** (it is inlined into the bundle)     | Yes, and an OTA or store build for mobile                                                                            |
| `CRON_SECRET`                                        | Self-generated                         | Vercel, and any external caller invoking a cron route                 | Yes                                                                                                                  |
| `STRIPE_WEBHOOK_SECRET`                              | Stripe → Webhooks → endpoint           | Vercel                                                                | Yes                                                                                                                  |
| `RESEND_API_KEY`                                     | Resend dashboard                       | Vercel, local env                                                     | Yes. Note: the local value is known to go stale — a working production email path does not prove the local one works |
| AI provider key                                      | Provider console                       | Vercel, local env                                                     | Yes                                                                                                                  |
| EAS / store credentials                              | Expo, Apple, Google consoles           | EAS                                                                   | n/a (build-time)                                                                                                     |

### When rotation is mandatory, not optional

- Any credential that was printed to a terminal, log, chat, issue, screenshot or
  transcript.
- Any credential in a commit, on any branch, at any point in history.
- Any credential held by a departing operator.
- Any credential in scope of a confirmed compromise (see
  [`incident-response.md`](incident-response.md)).

## 6. What this policy does not cover

- **No centralized secret manager.** Secrets live in the provider consoles plus
  one off-repo directory on the operator's machine. That is a deliberate
  scale-appropriate choice, not a control; it means there is no audit log of who
  read which secret when.
- **No automated rotation.** Every rotation above is a manual runbook. There is
  no scheduled forced rotation, so age is unbounded unless someone acts.
- **Local secret material is unencrypted at rest** beyond the operating system's
  full-disk encryption.

These are recorded so a reader does not infer a maturity level that is not there.
Closing any of them is a decision with a cost, and none is currently open work.
