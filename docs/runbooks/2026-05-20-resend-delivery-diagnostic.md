# Resend Email Not Reaching Org Recipients — Diagnostic Runbook

**Date:** 2026-05-20
**Symptom:** Resend dashboard marks an email as "sent" / "delivered", but recipients on company / school org domains (e.g. `@cvsouth.org`) never see the message — not in inbox, not in spam.

This runbook walks through the most likely causes in order of likelihood. Code changes already shipped (commit `ac17340` — auto Reply-To header) handle the small mechanical wins. The remaining causes are infrastructure / DNS / recipient-side gateway.

## 1. Check the actual delivery state in Resend (5 min)

Resend's status column hides the most useful information. To see the full lifecycle:

1. Go to https://resend.com/emails
2. Find one of the missing emails (filter by recipient address)
3. Click into it — you'll see an **Events** tab with the timeline:
   - `sent` — Resend handed it off to the recipient MX server
   - `delivered` — the MX server accepted it
   - `bounced` — the MX server rejected it (with reason)
   - `complained` — recipient marked as spam
   - `delayed` — temporarily deferred (greylisting, throttling)

**What to look for:**
- If you see `delivered` but no inbox arrival → recipient quarantine (skip to step 4)
- If you see `bounced` → fix the bounce reason (often DKIM/SPF; step 2)
- If you see only `sent` and never `delivered` → recipient server silently dropped (DMARC + quarantine; steps 2 + 4)

## 2. Verify DNS records on `stockpilotusa.com` (5 min)

Resend requires three DNS records on the sending domain. If any are missing or wrong, mail servers downgrade or reject your messages.

1. Go to https://resend.com/domains
2. Click `stockpilotusa.com`
3. Resend shows the three required records:
   - **MX** record for `send.stockpilotusa.com` (or whatever subdomain)
   - **TXT** record for SPF (e.g. `v=spf1 include:amazonses.com ~all`)
   - **CNAME** for DKIM (the `resend._domainkey` record)
4. Each row should show a green checkmark ("Verified").

**If any row is red / "not verified":**
- Open Namecheap → `stockpilotusa.com` → Advanced DNS
- Add the missing record exactly as Resend shows it
- Wait 5-15 min, then click "Verify" again in Resend

**Test it from terminal:**
```bash
dig +short TXT stockpilotusa.com | grep spf
dig +short CNAME resend._domainkey.stockpilotusa.com
```

Both should return non-empty results.

## 3. Check DMARC policy on the sending domain (2 min)

```bash
dig +short TXT _dmarc.stockpilotusa.com
```

If the result is empty, **add this TXT record** at Namecheap on `_dmarc`:
```
v=DMARC1; p=none; rua=mailto:dmarc-reports@stockpilotusa.com
```

`p=none` means "monitor only, don't reject" — safest starting policy. After 2 weeks of clean reports you can tighten to `p=quarantine` or `p=reject`.

## 4. Check Microsoft 365 / Google Workspace quarantine on the RECEIVING side

This is the most common cause of "looks delivered but never arrived". The recipient's mail admin needs to check.

### If recipient is on Microsoft 365 (likely for charter schools)
1. Admin signs in to https://security.microsoft.com
2. Email & collaboration → **Review → Quarantine**
3. Filter by sender domain: `stockpilotusa.com`
4. If messages appear:
   - Click → **Release** → also click **Block sender / allow sender** to whitelist for future
5. To allow `stockpilotusa.com` permanently:
   - Mail flow → Tenant Allow/Block Lists → Domains → Add `stockpilotusa.com`

### If recipient is on Google Workspace
1. Admin signs in to https://admin.google.com
2. Apps → Google Workspace → Gmail → **Spam, phishing, and malware**
3. Add `stockpilotusa.com` to the **Approved senders** list

### If recipient is on a self-hosted server
Ask the recipient's IT to check their mail gateway logs (Postfix, Exchange, etc.) for the message and explain why it was held.

## 5. Quick sanity check — does it work to a non-org address?

Send a test order or invite to a Gmail / iCloud / Outlook.com address you control. If those arrive instantly, the sender side is healthy and the problem is 100% on the recipient org's gateway (step 4). If they ALSO don't arrive, the problem is on the sender side (steps 1-3).

## What's already done in code

Commit `ac17340`: added auto Reply-To header from `RESEND_FROM_EMAIL`. Microsoft 365 + Google score messages slightly higher when Reply-To resolves to a deliverable mailbox. Not a fix by itself; just removes one small negative signal.

## When to ask Resend support

If steps 1-3 all pass green and step 5 confirms delivery to non-org addresses works, but the org recipient still doesn't receive, contact Resend support (https://resend.com/support) with:
- The `req_…` request ID from the email's Events tab
- The recipient address
- A timestamp range when you sent
- Confirmation that DNS is verified and other recipients receive fine

They can see beyond what the dashboard exposes (e.g. if the recipient MX issued a `554` after `delivered`).
