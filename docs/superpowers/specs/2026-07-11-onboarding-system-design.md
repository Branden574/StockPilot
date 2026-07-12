# Onboarding & Product-Adoption System — Owner Spec (2026-07-11)

Owner-authored PRD (delivered verbatim in session; this file is the durable
condensation — every requirement retained). Goal: a brand-new user understands
the app without human training. NOT a welcome popup — a complete adoption
system.

## Experience types (all required)
1. **First-time account onboarding** — animated welcome (org, name, role, value
   prop) → Start tour / Explore / Remind later → role-based capability
   explanation (admin vs warehouse vs requester — never show inaccessible
   features) → nav tour (section-by-section spotlight incl. what's renameable)
   → role-based first-actions checklist.
2. **Page-level interactive tours** — per major page, offered ONCE on first
   visit, remembered, replayable. Spotlight the real elements. Items-page
   example steps in PRD (heading → filters → New Item → Import → row).
3. **New Item form walkthrough** — per-field: what it controls, required?,
   example, where it appears later, renameable? (name, SKU, serial, category,
   qty, charter, warehouse, rack, condition, status, source PO, vendor, cost,
   images, notes, custom fields). Offer on first open; sample record shown.
4. **Workflow tutorials** — multi-page guided flows: create item, PO import →
   staging → active, create/accept order, claim picking, pick slip, packing
   slips, staged→pickup/delivery→complete, racks, invite users,
   roles/permissions, terminology customization, reports, AI. Each step: what/
   why/what-next/who-can/undoable?/what-updates.
5. **Animated "What's New"** — per release: title, animation/illustration,
   problem solved, preview, Launch + Walkthrough + Dismiss + replay-later.
   One-screen or carousel. Track viewed/completed/dismissed per user; never
   re-show after complete/dismiss unless replayed. Role-filtered.
6. **Contextual tooltips/help icons** — staging? charter? source PO? reserved
   qty? claim picking? rejected orders? pickup vs delivery? archiving? Short,
   hover (web) + tap (mobile), keyboard + screen-reader accessible, with
   "Learn more / Start walkthrough" for long-form.
7. **Terminology & customization onboarding** — explain admins can rename/
   disable modules & labels (charter→school, items→inventory, staging→
   receiving, books→textbooks, rack→shelf). Guide admins to Organization
   Settings for modules, categories, fields, statuses, roles. Never assume all
   modules in use.
8. **Demo account onboarding** — demo homepage: full tour + scenario menu
   (inventory mgmt, PO imports, fulfillment, picking/packing, reporting, AI).
   Guided scenarios w/ completion states: add Chromebook; import PO → staging;
   claim+complete pick; packing slip for pickup; customize terminology. Sample
   data labeled; resettable; explain real-account differences.
9. **Persistent checklist** — role-based, % complete, saved, deep-links,
   launches walkthroughs, skippable optional steps, minimizes when done,
   reopenable from help menu. (v1 shipped 2026-07-11: animated Getting-started
   panel + AI chips + cross-device dismissal — EXTEND, don't replace.)
10. **Replay + Help/Learning Center** — restart full tour, page tours, workflow
    tutorials, What's New, videos, articles, shortcuts, contact support,
    search, completed-onboarding history.
11. **Mobile-specific** — one element at a time, bottom sheets, swipe nav,
    never cover the highlighted control, portrait+landscape, drawer-aware,
    touch targets, resume across screens, short text, reduced-motion.
12. **Animation/design** — smooth spotlight transitions, subtle motion,
    progress dots, dimmed backdrop, celebration on milestones. Never slow/
    distracting/sound-dependent. prefers-reduced-motion → fades only.
13. **Persistence (backend, NOT browser state)** — onboardingStatus/version,
    completedTours, dismissedTours, viewedAnnouncements, checklistProgress,
    lastOnboardingStep, completedAt, role-at-onboarding, platform. Versioned:
    changed flows show only new/changed steps.
14. **Role/permission-aware** — never spotlight inaccessible controls;
    role-change offers new-capability tour.
15. **Context-aware triggers** — first visit per page/feature offers its tour;
    show once, dismissible, never re-interrupt, always in Help; defer when
    user mid-task.
16. **Reusable infrastructure** — tour registry config (id, version, name,
    page, roles, platforms, feature flag, steps[{target, title, body,
    placement, animation, nextRoute, requiredAction, completionCondition}]),
    NOT hardcoded per page. Handle: unrendered elements, responsive layouts,
    route changes, scroll containers, modals, dynamic data, missing modules,
    permission gaps, mid-tour refresh/resume.
17. **Interactive vs passive steps** — passive info + safe required-action
    steps ("Click New Item to continue") using demo/sandbox data; never force
    production writes.
18. **Analytics** — started/completed/skipped/dismissed, exit step, time per
    step, checklist completion, announcement funnel, help opens, role+platform
    (PostHog exists, key currently unset → events must no-op safely). No
    sensitive inventory data in events.
19. **Acceptance criteria** — 20 items (new web user, new mobile user, demo
    tours, Items tour, New Item fields, Staging explainer, Orders lifecycle,
    picking claim, PO import flow, admin terminology, role gating, What's New,
    skip/dismiss/replay, no repeats, persistence across sessions, responsive,
    keyboard+SR accessible, reduced motion, dynamic-content safe, Help hub).

## Required tour catalog (19)
App overview · Dashboard · Items · New Item · Item details · Staging · PO
Import · Orders · Order creation · Picking claim · Pick slip · Packing slips ·
Pickup/delivery · Org settings · Terminology · Users/permissions · Reports ·
AI features · Demo overview.

## Delivery phases (agreed plan)
- **P1 (foundation)**: UX audit; mig `user_onboarding` state table; web tour
  engine (spotlight, steps, role gating, persistence, a11y, reduced-motion);
  Items + New Item tours as proving pair; "Learn this page" affordance.
- **P2**: remaining web page tours + workflow tutorials + contextual tooltip
  component + terminology-aware copy (resolveTerminology).
- **P3**: What's New announcement system + versioned registry + analytics.
- **P4**: mobile tour engine (bottom-sheet pattern) + mobile tours.
- **P5**: demo scenarios + Help/Learning Center hub + checklist extensions.

Final deliverables per PRD: architecture doc, tour inventory, state model,
role effects, demo improvements, how-to-add-announcements, admin content
updates, screenshots/recordings, a11y + persistence + reduced-motion tests.
