# StockPilot — Business Plan & Implementation Proposal

**Prepared for:** Learn4Life Charter Schools
**Prepared by:** Branden Vincent-Walker (Co‑Founder, CEO / CTO) & Andrew Rosas (Co‑Founder, COO)
**Date:** June 2026
**Contact:** branden574@gmail.com · stockpilotusa.com

---

## Executive summary

Learn4Life needs accurate, real‑time inventory across its warehouses and charter sites — without paying the steep per‑seat licensing and six‑figure implementation fees that commercial warehouse‑management systems (WMS) charge.

**StockPilot already solves this.** It is a modern, custom‑built inventory & warehouse platform that has been **running Learn4Life Fresno's live operation** (4 warehouses, ~10–20 staff) at a total infrastructure cost of roughly **$1,000 per year, with no per‑user fees**. The equivalent commercial system would cost **$5,000–$135,000+ per year in licenses alone at our scale**, plus a one‑time **$25,000–$500,000 implementation fee** before it processes a single order.

This document proposes formalizing and expanding StockPilot across Learn4Life under a simple operating model: the two people who built and run it — Branden Vincent‑Walker and Andrew Rosas — are retained as Learn4Life's dedicated inventory‑systems team, responsible for operating, maintaining, securing, and continuously improving the platform.

**The ask:**

| Item | Annual amount |
|---|---|
| Branden Vincent‑Walker — salary (minimum) | $100,000 |
| Andrew Rosas — salary (minimum) | $100,000 |
| System operating budget (infrastructure + scaling headroom) | $10,000 |
| **Total** | **$210,000 / year** |

For that, Learn4Life gets a **production system independently valued at $450,000–$650,000**, the **two owner‑operators who built it**, continuous feature development, full security & support, and **zero per‑user license fees** — a package no commercial vendor can match on cost, fit, or capability.

---

## 1. The opportunity

### 1.1 The problem at Learn4Life

Operating inventory across multiple warehouses and charter sites with spreadsheets, disconnected tools, or an off‑the‑shelf WMS creates real, recurring pain:

- **Fragmented tracking** — counts live in spreadsheets and people's heads; managers can't see real‑time stock across sites.
- **Manual, slow workflows** — receiving, counting, purchasing, and order requests are paper/phone/email‑driven.
- **Commercial WMS is a poor fit and expensive** — generic systems force the organization to adapt to *their* workflow, charge **per user forever**, and bill **$25,000–$500,000 just to implement**.
- **No software team to build in‑house** — the usual reason organizations settle for an ill‑fitting, costly vendor.

### 1.2 Market context

The global warehouse/inventory management software market is large and growing double‑digits as organizations modernize operations and adopt mobile + AI‑assisted workflows. But the market is dominated by **per‑seat SaaS** (Sortly, Cin7, Zoho) and **heavy enterprise suites** (NetSuite, SAP, Oracle, Manhattan, Microsoft Dynamics) — all of which are priced for vendor margin, not operator efficiency. StockPilot's structural cost advantage (serverless, no sales team, no per‑seat tax) is a durable moat at any scale Learn4Life will ever reach.

---

## 2. The solution: StockPilot

StockPilot is a full inventory & warehouse platform — **web + native mobile (iOS/Android)** — already in daily production use at Learn4Life Fresno.

### 2.1 Key features & benefits

- **Items & multi‑warehouse inventory** — real‑time on‑hand across warehouses and charters, warehouse‑scoped staff access, custom item fields, barcode/label support.
- **Purchase orders, end‑to‑end** — draft → ordered → receiving (full + partial/multi‑day receipts with live variance) → received, recurring POs, approval thresholds, supplier records, and printable PO PDFs.
- **Receiving, returns & cycle counts** — record what arrives (who/when), reverse mistakes safely, run selective counts, RMA/returns with stock‑accurate dispositions.
- **Order requests + public no‑account link** — teachers/partner sites submit requests via a single URL — no login, no training — landing straight in the manager's queue.
- **AI that no commercial WMS bundles:**
  - *AI Inventory Assistant* — natural‑language questions ("what's below reorder?") answered from real database queries (it cannot invent quantities).
  - *AI Shelf Scan* — a phone photo of a shelf returns item matches in seconds (a 20‑minute count becomes 30 seconds).
  - *AI PO Import* — paste a vendor invoice (PDF/CSV) and it drafts the PO automatically.
- **Native mobile on the floor** — scan, count, and adjust stock from a phone; the manager's dashboard updates in real time (~250 ms), not on a 5–30 second poll.
- **Integrations** — QuickBooks Online purchase‑order push, Sage migration tooling, webhooks + Slack/Teams alerts, and a scoped public API.
- **Reports & insights** — reorder forecasting, item cost‑over‑time history, inventory valuation, and an AI insights briefing.
- **Procedures knowledge base** — SOP library with video walkthroughs and per‑procedure Q&A.
- **Enterprise‑grade security** — database‑level row security (the database itself enforces who sees what), an immutable audit log of every privileged action, per‑org MFA policy, and hardened email/web posture (SPF/DKIM/DMARC, CSP, rate limits). Point‑in‑time backups & restore.

### 2.2 What StockPilot does better — not just cheaper

It is **not** a stripped‑down WMS. It is materially better than the commercial alternatives on mobile experience, real‑time collaboration, the AI features above, the no‑account requester flow, and — critically — **fit**: every workflow matches how Learn4Life actually operates (charter naming, warehouse‑scoped staff, your terminology, your picking‑and‑signing process). Commercial WMS forces *you* to adapt to *it*.

---

## 3. Why StockPilot vs. commercial WMS

### 3.1 Total annual cost at our scale (licenses + first‑year implementation)

| System | 5 users | 25 users | 100 users | 500 users |
|---|---|---|---|---|
| **StockPilot** | **~$1,000** | **~$1,000** | **~$1,500** | **~$3,000** |
| Sortly Pro | ~$3,000 | ~$10,000 | ~$30,000 | not viable |
| Cin7 (Core/Omni) | ~$6,000 | ~$25,000 | ~$60,000 | $150,000+ |
| Fishbowl | ~$6,000 | ~$15,000 | ~$45,000 | $150,000+ |
| NetSuite WMS | ~$30,000 | ~$50,000 | ~$135,000 | $625,000+ |
| Microsoft Dynamics 365 SCM | ~$36,000 | ~$70,000 | ~$240,000 | $1,150,000+ |
| SAP Business One WMS | ~$50,000 | ~$75,000 | ~$200,000 | $700,000+ |
| Oracle / Manhattan (enterprise) | $100,000–150,000+ | $200,000–250,000+ | $400,000–500,000+ | $1,500,000+ |

*Source: StockPilot Operating Cost & Value Analysis (2026‑05‑22); commercial figures are publicly published or industry‑typical rates.*

**The structural difference:** commercial WMS is **per‑seat** — every new staff member is another $50–$200/month, forever. StockPilot's serverless infrastructure cost is essentially flat. At 100 users, StockPilot costs **~$15/user/year**; NetSuite costs **~$1,350/user/year** — **90× more per person, every year.** StockPilot is **5–500× cheaper** across every realistic scale.

### 3.2 What the system is worth

Independently analyzed, StockPilot's **cost‑to‑recreate** is **$500,000–$1,000,000** (12–18 months of a small senior team), and its **production value** — a live, battle‑tested, security‑audited system with calibrated AI — is **$450,000–$650,000**. Learn4Life gets access to all of that for the operating arrangement below.

---

## 4. The proposal & operating model

### 4.1 Structure

StockPilot is owned by its founding company (Branden Vincent‑Walker and Andrew Rosas, **50/50; the company owns all intellectual property**). Learn4Life **does not need to buy the system** — and shouldn't. As the cost‑and‑value analysis concludes, *owning software without an in‑house engineering team is a liability dressed up as an asset*: unmaintained code rots, security patches lapse, and mobile apps break with OS updates within ~18 months.

Instead, Learn4Life retains the **team that built it**. Branden and Andrew operate StockPilot as Learn4Life's inventory‑systems function:

- **Branden Vincent‑Walker — CEO / CTO (builder):** platform development, new features, security, infrastructure, mobile releases, integrations, and day‑to‑day technical operation.
- **Andrew Rosas — COO (implementation & operations):** rollout across charters/warehouses, staff training & onboarding, workflow design, support, and on‑the‑ground operational ownership.

### 4.2 What Learn4Life pays — and gets

**Pays: $210,000 / year, all‑in**

- $100,000 minimum salary — Branden Vincent‑Walker
- $100,000 minimum salary — Andrew Rosas
- $10,000 / year — system operating budget

The **$10,000 operating budget** covers far more than today's ~$1,000 infrastructure bill; it provides headroom so the system scales without a separate ask:

| Operating budget line | Approx. annual |
|---|---|
| Core infrastructure (Vercel, Supabase, Resend, domain) | ~$1,500 |
| Scaling headroom (AI usage, email volume, storage as sites are added) | ~$3,500 |
| Monitoring, backups, security tooling, app‑store / dev accounts | ~$2,000 |
| Contingency | ~$3,000 |
| **Total** | **~$10,000** |

**Gets:**

1. The **StockPilot platform** ($450k–$650k production value) running every Learn4Life inventory operation.
2. **Two full‑time owner‑operators** — the people who built it, accountable for it.
3. **Continuous improvement, security, and support — included** (no per‑feature or per‑upgrade billing).
4. **Zero per‑user license fees** — add as many staff and sites as Learn4Life wants; the cost doesn't move.
5. **Full customization** to Learn4Life's exact workflows, with no vendor lock‑in.

### 4.3 Why this beats "just buy a WMS"

A commercial WMS would cost Learn4Life **license fees that grow with every user**, a **$25k–$500k implementation**, and would **still require staff to operate inventory** — while delivering a worse, generic, off‑the‑shelf experience. The StockPilot arrangement bundles **the software *and* the team** into one predictable $210k/year line, and the software half of that is the cheapest, most capable option on the market.

---

## 5. Financial summary

### 5.1 Three‑year outlook (illustrative)

| | Year 1 | Year 2 | Year 3 |
|---|---|---|---|
| Founder salaries (2 × $100k) | $200,000 | $200,000 | $200,000 |
| System operating budget | $10,000 | $10,000 | $10,000 |
| **Total cost to Learn4Life** | **$210,000** | **$210,000** | **$210,000** |
| *Underlying infrastructure cost* | *~$1,000* | *~$1,500* | *~$2,000* |

The infrastructure cost barely moves even as Learn4Life adds warehouses, charters, and staff — the defining advantage of the architecture.

### 5.2 The value case in one line

Learn4Life secures a **$450k–$650k system + its two builders + unlimited users + continuous development** for **$210k/year**, versus a commercial path that costs **more per year in software licenses alone at scale**, **adds $25k–$500k to implement**, and **still doesn't run itself**.

### 5.3 Optional upside (no extra cost to Learn4Life)

Because StockPilot is a horizontal, multi‑industry platform (not school‑specific), the founding company can license it to other organizations in the future. Learn4Life is the proven **anchor reference customer** — a position that strengthens the platform's roadmap and longevity at no cost or obligation to Learn4Life.

---

## 6. Implementation roadmap

StockPilot is **already live at Learn4Life Fresno**, so this is an expansion plan, not a from‑scratch build.

| Phase | Focus |
|---|---|
| **Q1 — Formalize & stabilize** | Formalize the operating arrangement; finalize roles; harden the Fresno deployment; document SOPs. |
| **Q2 — Roll out** | Expand to additional Learn4Life warehouses/charters with training & onboarding for each site. |
| **Q3 — Optimize & automate** | Reorder automation, AI insights, integrations (accounting), and reporting tuned to Learn4Life's needs. |
| **Q4 — Review & scale** | Performance review against goals, staff‑feedback‑driven improvements, and a plan for the next year. |

---

## 7. Team & ownership

- **Branden Vincent‑Walker — Co‑Founder, CEO / CTO.** Architected and built the entire StockPilot platform (web, mobile, database, AI, security, integrations).
- **Andrew Rosas — Co‑Founder, COO.** Leads implementation, operations, training, and the on‑the‑ground rollout — the boots‑on‑the‑ground half of the partnership.

**Ownership / IP:** the founders hold the company **50/50**, and **the company owns all intellectual property** (not held personally). This structure keeps the platform fundable and licensable while ensuring Learn4Life always works with accountable owners rather than an anonymous vendor. *(See the StockPilot Founders, IP & Equity Framework for the full structure.)*

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **"Key‑person" dependence** | Two owners (not one); full source control, documentation, and an SOP knowledge base; the system runs on standard, well‑documented technology any engineer can pick up. |
| **Scaling cost surprises** | The $10k operating budget includes explicit scaling headroom; infrastructure is serverless and grows in small, predictable steps. |
| **Data security / compliance** | Database‑level row security, immutable audit log, per‑org MFA, hardened email/web posture, and point‑in‑time backups are already in production. |
| **Vendor lock‑in** | None — the stack is open‑standard (Postgres, TypeScript, React); Learn4Life is never trapped. |
| **Continuity if priorities change** | Month‑to‑month value is concrete and measurable; the arrangement can be reviewed annually against agreed goals. |

---

## 9. Next steps

1. Review this proposal with Learn4Life leadership.
2. Confirm the operating arrangement and compensation ($100,000 minimum each + $10,000/year system operating budget).
3. Approve the Q1–Q4 rollout plan and set success metrics.
4. Formalize roles and begin the organization‑wide expansion of StockPilot.

**Contact:** Branden Vincent‑Walker · branden574@gmail.com · stockpilotusa.com

---

*Figures in this plan draw on the StockPilot Operating Cost & Value Analysis (2026‑05‑22). Commercial WMS pricing is based on publicly published or industry‑typical rates and varies by region, contract, and bundle. StockPilot operating costs reflect current Learn4Life usage and scale modestly with users, email, and AI volume.*
