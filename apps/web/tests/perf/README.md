# Performance harness

A scripted, signed-in browser that times what a person feels: how long after a
click something responds, how long until real content is on screen, and how
long the photos take. It reports percentiles, never a single run, and it
measures any build from the outside, so a "before" number can be taken before
the change it is judging exists.

It is not part of `pnpm test:e2e` and never runs in CI on its own.

## Run it

```bash
cd apps/web

# Against production, with the QA account, no password involved:
PERF_BASE_URL=https://stockpilotusa.com \
PERF_USER_EMAIL=<qa account email> \
PERF_SUPABASE_URL=https://<project-ref>.supabase.co \
PERF_ENV_FILE=.env.local \
PERF_ROLE=admin \
PERF_LABEL=before-my-change \
PERF_DATASET="Demo Co, 29 list rows, 33 photos" \
PERF_SERVER_STATE=steady \
PERF_ITERATIONS=40 \
pnpm perf

# Before / after table and chart from two saved runs:
PERF_BEFORE=perf-results/<before-run> PERF_AFTER=perf-results/<after-run> pnpm perf:compare
```

Never point it at `next dev`: dev mode has no prefetching and no minification,
so its numbers describe nothing a customer sees. Do not run anything heavy on
the machine (tests, builds, other agents) while a run is in progress.

### Judging a change

1. Take the baseline TWICE on the same build and compare the two runs with
   `perf:compare`. That is an A/A comparison, and the report says so. Any row
   that is not "no material change" there is this harness's own noise for that
   row, at that sample size.
2. Make the change, deploy it to the same kind of target, run again with the
   same variables, and compare against the baseline.

3. Pass the A/A pair to the comparison (`PERF_DRIFT_A`, `PERF_DRIFT_B`). Two runs
   of one build, half an hour apart, have been seen to move server-bound rows by
   15 to 30% with no change at all. A change no larger than its row's same-build
   drift is reported as drift, whatever the statistics inside one run say.

At 20 samples a row can only prove a large change, and a p95-only regression can
only be raised as a candidate. Use `PERF_ITERATIONS=40` or more for runs that
will judge a pull request.

| Variable                          | Default                 | Meaning                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERF_BASE_URL`                   | `http://localhost:3000` | What to measure.                                                                                                                                                                                                                                                                                                     |
| `PERF_USER_EMAIL`                 | required                | Account to sign in as.                                                                                                                                                                                                                                                                                               |
| `PERF_ROLE`                       | required                | A LABEL for that account (`admin`, `staff-restricted`…). The role written into the results is the one the server reports after sign-in.                                                                                                                                                                              |
| `PERF_DATASET`                    | required                | What data is being measured. It cannot be added to a result afterwards. The list's row count and the photos on screen are also measured.                                                                                                                                                                             |
| `PERF_SUPABASE_URL` + service key |                         | Magic-link sign-in. The key is read from `SUPABASE_SERVICE_ROLE_KEY` or from the file `PERF_ENV_FILE` names, never printed, and sent only to `https://<ref>.supabase.co` or a local stack. No email is sent. The link itself goes only to stockpilotusa.com, a local target, or the https host in `PERF_ALLOW_HOST`. |
| `PERF_USER_PASSWORD`              |                         | Password sign-in. LOCAL TARGETS ONLY: Playwright logs whatever is typed into a form.                                                                                                                                                                                                                                 |
| `PERF_SERVER_STATE`               | `not controlled`        | `post-deploy`, `post-idle`, `first-org-request` or `steady`: the state the server was in when the run started.                                                                                                                                                                                                       |
| `PERF_BROWSER`                    | `chromium`              | `chromium`, `webkit` or `firefox` (install with `npx playwright install <name>`).                                                                                                                                                                                                                                    |
| `PERF_DPR`, `PERF_VIEWPORT`       | `2`, `1440x900`         | Below 768 px wide the sidebar is a drawer; the sidebar scenarios then record `link-hidden-at-this-viewport`.                                                                                                                                                                                                         |
| `PERF_NETWORK`                    | `unthrottled`           | `fast-4g` or `slow-4g` are APPLIED by emulation (Chromium only). A label is never just written down.                                                                                                                                                                                                                 |
| `PERF_CPU`                        | `1`                     | CPU slowdown factor, applied by emulation (Chromium only).                                                                                                                                                                                                                                                           |
| `PERF_ITERATIONS`                 | `20`                    | Timed samples per scenario. One extra sample runs first and is reported apart.                                                                                                                                                                                                                                       |
| `PERF_COLD_ITERATIONS`            | `10`                    | Samples for empty-browser-cache scenarios (each re-downloads the whole app).                                                                                                                                                                                                                                         |
| `PERF_HOVER_MS`                   | `150`                   | Pause between the pointer arriving on a link and the click. The REAL time on the link is measured and reported (it is longer: the pointer has to travel).                                                                                                                                                            |
| `PERF_SETTLE_MS`                  | `2000`                  | Rest time on the start page before the measured click.                                                                                                                                                                                                                                                               |
| `PERF_SCENARIOS`                  | all                     | Comma-separated scenario ids to run.                                                                                                                                                                                                                                                                                 |

## What it measures

Scenarios live in `scenarios.ts`; report rows in `src/lib/perf/report.ts`.

- **click to visible response**: from the trusted click event to the link spinner
  or the top progress bar (while it is climbing) being on screen. The report
  names which one it was. Budget: p75 75 ms, p95 150 ms.
- **click to loading skeleton**, and **click to useful content**: the first moment
  the destination's real content is visible: a data row, a detail heading, a
  storefront card. The skeletons contain no table, no `h1`, no detail link and no
  card, so a skeleton cannot satisfy it. Budget for a warm soft navigation: p75
  500 ms, p95 1000 ms.
- **the page-data fetch**: the navigation's own request (told from background
  prefetches by its headers): when it was sent, and how long the server took to
  answer.
- **photos**: when the first ones were REQUESTED (discovery), when their bytes were
  in hand, and when the last photo in the first rows / first cards / whole screen
  was done. "Done" is never earlier than the content the photo sits in: priority
  photos are preloaded and their bytes often land before the list paints. The
  photo set has to settle first (no skeleton left, same photos for three polls).
- **photo delivery audit**: per surface, what was fetched (thumbnail, master,
  through the optimizer or direct), at what size, against what the screen needs
  (rendered CSS px × DPR), whether the browser cache served it, with which
  caching headers, and whether a blur placeholder was shown.
- **signed-URL stability**: whether the signed URL of the same photo changed
  during a run, or between two runs on this machine.
- **hard loads**: document first byte, FCP, LCP, layout shift, with a warm browser
  cache and with an empty one.
- **network and health**: requests by kind inside a fixed window (from the click to
  one second past content), which routes were prefetched, bytes by kind, images revalidated with a
  304, broken photos, failed page-data fetches, console and hydration error COUNTS.

Timing happens inside the page on the page's clock, in a `MutationObserver`, so
there is no polling interval to round up to. "Visible" is stamped two animation
frames after the DOM changed: one frame late at worst, never early.

## Reading the results

Each run writes `perf-results/<time>-<label>-<browser>/`:

- `results.json`: every sample, including failed ones, plus the environment.
- `summary.md`: the owner's table, every other row, the first request of each
  scenario, the photo delivery audit and the signed-URL check.
- `chart.svg`: the same numbers, in panels with their own scale. A row with no
  data draws no bar.

Rules the report keeps:

- A cell is a measurement or it says `not measured`. Nothing is estimated.
- A navigation that timed out, crashed or landed on the error screen, and a photo
  set that never completed, DID NOT FINISH. On time rows those samples are ranked
  last (slower than everything that finished): one in forty sits above p95, ten in
  forty push p75 to `did not finish`. They are never dropped, and any comparison
  says how many there were on each side. A failure of the harness itself (a link
  that is not there) is different: it voids a time row, and on other rows up to 5%
  is tolerated and stated.
- Every row shows `n / attempted`, `failed` and `no value`.
- Percentiles are nearest-rank: every cell is a value that was observed. With
  fewer than 20 samples, p95 is simply the slowest sample, and the row says so.
- The first sample of each scenario is reported apart, with a note on whether it
  really was the first request to its routes in that run. Cold and warm are never
  averaged together. The owner's post-deploy budget can only be judged from runs
  started with `PERF_SERVER_STATE=post-deploy` or `post-idle`.
- A result is labelled LAB, PREVIEW SYNTHETIC or PRODUCTION SYNTHETIC from what
  the site reports about itself. None of them is field data from real users.
- A metric the browser cannot report (layout shift and long tasks outside
  Chromium) is `not measured`, never 0.
- `perf:compare` calls a comparison unfair, and says why, when target, browser,
  viewport, DPR, network profile, measured round trip, account (verified role and
  label), dataset (label and measured size), server state, harness version or
  method differ, or when either run spans a deploy.
- "Improved" / "regressed" need a change of at least 10% that is also larger than
  one frame and larger than the two runs' own scatter (a seeded bootstrap, so the
  same two files always give the same answer; it is labelled as derived). A p95
  that gets 10% worse is a regression even if p75 improved. An apparent
  improvement inside the noise is not claimed; an apparent regression inside the
  noise is raised as a candidate to re-measure.

## Privacy and secrets

Photo URLs are 30-day bearer credentials and their paths name an organization and
an item. Item names, SKUs and emails are on every page the harness opens. None of
it is written down:

- inside the page, each photo URL is reduced to a **class**
  (`src/lib/perf/image-class.ts`) and to short KEYED hashes (of the URL, of the
  object path, of the token). The key is 32 random bytes created once per machine
  in the gitignored `tests/perf/.auth/`; it is passed into the collector's closure,
  never onto `window`;
- the network log hashes URLs the same way and keeps only caching headers, sizes
  and route templates (`src/lib/perf/route-template.ts`);
- a failed iteration stores a short code (`timeout:useful`, `link-missing`…), never
  Playwright's message, which quotes URLs and selectors;
- tracing, video, screenshots AND Playwright's failure snapshot
  (`error-context.md`, an ARIA dump of the page including input values) are off;
- console output is counted, never stored;
- the sign-in link and the service key are never printed, and every step that
  touches them rethrows a fixed message.

The saved session (`tests/perf/.auth/<label>.json`) is a live signed-in session.
It is mode 0600, the teardown signs it out (`scope=local`) and deletes it, and
because Playwright skips teardown on Ctrl-C, the next run's setup first ends and
deletes anything left behind. `perf-results/` and `tests/perf/.auth/` are
gitignored.

## Known limits

- The two-frame stamp includes any long main-thread task that lands between the
  frames. Chromium's Element Timing would give the compositor's own paint time; it
  is not used yet, to keep one method across engines.
- Browser Event Timing only reports interactions of 16 ms or more, so that row is
  a lower-censored measure and is titled as such.
- Not measured yet: the public catalog (`/r/<token>`, needs an anonymous context
  and a benchmark organization), back/forward, pagination, search, the mobile
  drawer, WebKit and Firefox runs, and the role matrix beyond the QA admin.
