# Publishing release notes ("What's New")

Written for: whoever ships a user-facing change to StockPilot and needs to tell people about it.

Release notes are **content in the repository**, validated by a test, and published by a reviewed pull request. There is no editor and no database of release text. You never edit a UI component to publish a release.

## A release is not a deployment

StockPilot deploys many times for every change worth telling anyone about. The two are tracked separately and on purpose:

|                | Deployment                                 | Release                                        |
| -------------- | ------------------------------------------ | ---------------------------------------------- |
| What it is     | A build going live on production           | An announcement to people                      |
| Identity       | A hash baked into the bundle at build time | A permanent slug plus a revision               |
| Who sees it    | Every open tab, as "Refresh to update"     | The people it is addressed to, as "What's New" |
| Where it lives | `next.config.ts`, `/api/version`           | `apps/web/src/lib/releases/registry.ts`        |

A deployment with no new release still prompts a refresh, with honest wording and no "What's New" button. A release is announced once it is in the registry of the deployment production is serving, so it can never be announced before it is live, and a rollback takes it away again.

## The workflow

```
Draft release notes            add a release with status: 'draft'
        |
Validate content and audience  pnpm exec vitest run src/lib/releases   (from apps/web)
        |
Review the rendered preview    set status: 'published' on your branch, run the app, open What's New
        |
Approve the announcement       pull request review, by someone who has used the feature
        |
Confirm it is live             merge. The production deployment that contains it announces it.
        |
Published to eligible users    only the people its audience names are told
```

### 1. Draft

Add an object at the **top** of `RELEASES` in `apps/web/src/lib/releases/registry.ts` with `status: 'draft'`. A draft never leaves the server, so it is safe to merge early.

- `id` is a permanent kebab-case slug, for example `receiving-2026-10`. It keys every person's read state on web and mobile. **Never rename or reuse one**: renaming re-announces it to everybody.
- `publishedAt` is a full instant with an offset, for example `2026-10-02T17:00:00Z`. A bare date is refused, because it renders as the previous day for anyone west of Greenwich.
- `summary` is one plain paragraph that makes sense on its own. Older mobile builds show only the title and the summary.
- `revision` starts at `1`. See "Re-announcing" below.

### 2. Write every entry to answer four questions

| Field             | The question             | Bad                 | Good                                                           |
| ----------------- | ------------------------ | ------------------- | -------------------------------------------------------------- |
| `whatChanged`     | What changed?            | "Improved staging." | "Staging has a search box and filters for source and age."     |
| `whyItMatters`    | Why does it matter?      | "Better UX."        | "Long staging lists were slow to scan for one purchase order." |
| `howItAffectsYou` | How does this affect me? | "You will love it." | "Type part of a name or a PO number to narrow the list."       |
| `whatToDo`        | What do I need to do?    | (blank)             | "No action needed." or a concrete step                         |

`category` is one of `new`, `improved`, `fixed`, `action`. `area` is the part of the product as the reader knows it ("Orders", "Inventory", "Account").

Only describe what exists and what you verified. No invented numbers, no speed claims you did not measure, no marketing tone, no emojis, no exclamation marks. Never say StockPilot sent an email, created a ticket or notified a person unless it did; for maintenance requests it prepares an email the person reviews and sends.

### 3. Say who it is for

An entry that links to a page must name the **permission and module that page checks**, so nobody is told about a page that would bounce them:

```ts
audience: { anyPermission: ['orders:approve'], modules: ['orders'] }
```

Every listed dimension must pass; inside one, any value passes. Roles alone are a weak proxy, because permissions are configurable per organization and most features sit behind an optional module. A release with no entries the reader can reach is not shown to that reader at all.

Links must be `/dashboard/...` paths whose page exists. Older mobile builds push any other path straight into the native router and land on "Unmatched Route".

### 4. Validate

```
cd apps/web
pnpm exec vitest run src/lib/releases
```

The gate (`registry.test.ts`) fails the build when content is malformed, a link points at a page that does not exist, an audience names an unknown permission, a linked entry has no audience, the copy contains a claim the product cannot stand behind or empty filler, or one of the six legacy announcements changed by a character.

### 5. Publish

Change `status` to `'published'` in the pull request that ships the feature, or a later one. When that deployment is promoted to production, the people in the audience see the notice and the entry in the topbar.

## Changing a release later

- **Fixing a typo or clarifying wording**: edit the text. Do **not** bump `revision`. Nobody who already read it is told again.
- **Re-announcing on purpose** (the change grew, or the first note was materially wrong): bump `revision`. Read and dismissed state recorded against the older revision is cleared for everyone, and the release is unread again.
- **Withdrawing** (the feature was pulled): set `status: 'withdrawn'` and add a `withdrawnNote` saying why. It stays in history for the people it was addressed to, with the note and without its entries or links, and it is never shown as unread.
- **Never delete** a published release. History should stay truthful, and the id must not become reusable.

## What the machine does for you

| Concern                                              | How it is handled                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A tab opened in the middle of a deploy               | The loaded build is baked into the bundle, so the tab still learns it is stale                                                                                                                                                                     |
| A rollback                                           | A served build older than the loaded one is labelled as restored, not as new. Closing a notice is remembered only for the build it was closed FROM, so an old dismissal cannot hide a later rollback                                               |
| A second deploy between the last check and the click | Refresh is judged by whether the tab MOVED, so landing on something newer than expected is a success                                                                                                                                               |
| Preview and failed builds                            | Only the deployment holding the production alias answers `/api/version`                                                                                                                                                                            |
| Several releases missed                              | One notice for the newest; the rest are in history                                                                                                                                                                                                 |
| A new member                                         | Releases published before their account was created count as read. For an owner provisioned from the platform console, "created" is the day they were invited, not the day they first signed in, so a release published in between is offered once |
| A different person, or organization, in the same tab | The list, the unread count and an open drawer are cleared at once, and a response still in flight for the previous person is discarded                                                                                                             |
| What an outsider can learn                           | `/api/version` is public. It serves an opaque key that changes when a release is published, re-announced or withdrawn, and never a slug, a revision or an audience. Drafts do not change it                                                        |
| A slug the server does not recognise for this reader | The write reports `recorded: 0` and the app says it was not saved, instead of clearing the dot and bringing it back                                                                                                                                |
| Two tabs                                             | Dismissing or reading in one updates the others                                                                                                                                                                                                    |
| Unsaved work                                         | "Refresh to update" asks first when a registered form is dirty                                                                                                                                                                                     |
| Reading state cannot be loaded                       | Nothing is shown as unread, and the failure is reported                                                                                                                                                                                            |

## Protecting a form from "Refresh to update"

A form that holds work a reload would lose should register itself:

```ts
useUnsavedWork('po-form', 'Purchase order', () => isDirty);
```

Registered today: the item form and the receive-against-PO dialog. The refresh prompt names what it found, never claims that work is saved, and withdraws the warning by itself once the work is saved (it never reloads by itself).

`isDirty` must see every way the form can change, not only typing. Buttons, chips and anything that writes through `setValue()` fire no `change` event: the item form learned this the hard way. Only forms that register are protected, so add yours when you build one.
