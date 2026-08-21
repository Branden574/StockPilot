# Size-sticker scan evaluation

Measures how well `src/lib/ai/size-scan.ts` actually reads size stickers, by
running the real training corpus in `size_count_training_samples` through the
vision model and scoring against the labels the operator tapped at capture time.

The unit tests next to that module prove properties of OUR code. They cannot
tell you whether the scanner reads stickers, because that is a property of the
model plus the prompt. **Any change to the prompt should be re-measured here.**

## Running it

Needs a Supabase service-role key (to read the private `size-count-training`
bucket) and an Anthropic key. Both are read from the environment, falling back
to the env files outside the repo:

```bash
cd apps/web
node scripts/size-scan-eval/run.mjs --stage=all
```

Stages, so a re-run does not repeat the slow parts:

| stage | what it does | cost |
|---|---|---|
| `bursts` | builds the evaluation set from the DB | seconds |
| `images` | downloads + resizes to what the phone sends | ~70 MB, a few minutes |
| `score`  | runs the model and prints the report | one API call per burst |
| `all`    | all three in order | |

`--model=` picks the model, `--limit=N` runs a subset while iterating.

## Two things about the method that are easy to get wrong

**SCORE PER BURST, NEVER PER FRAME.** The capture tool records continuously, so
the table's 2,171 rows are bursts of near-identical frames of the same physical
sticker — grouping on (gap < 3s AND same label) gives **267 distinct stickers**.
One XL burst alone holds 352 frames; scoring per frame lets that single sticker
carry 16% of the result. The harness takes one frame from the MIDDLE of each
burst: the first frame is still being aimed and the last is already moving away.

**THE CORPUS DOES NOT COVER EVERYTHING.** It is one org over two days in July
2026. **XXXXL and XXXXXL have zero examples**, so no score here says anything
about them, and XXL has only ten. A number from this harness is evidence about
seven sizes photographed by one person in one warehouse.

## Results so far (267 bursts, confidence >= 0.7)

| prompt | model | overall | no-sticker recall | wrong readings |
|---|---|---:|---:|---:|
| first draft | haiku-4-5 | 73.0% | 40.5% | 44 |
| + rotation alphabet | haiku-4-5 | 89.1% | 83.3% | 20 |
| + carrier field | haiku-4-5 | 89.9% | 100% | 27 |
| + carrier field | sonnet-4-5 | 95.1% | 97.6% | 10 |
| **shipped** | **sonnet-5** | **99.3%** | **100%** | **2** |

Of those last two, ONE is a mislabelled corpus entry — the sticker in burst 259
plainly reads XXXL and was captured as XXL — so the honest figure is **one
genuine miss in 267**. It is burst 243: a `7XX` dot (XXL upside down) read as
`7XXX`.

`--model=` takes any Anthropic model id. **sonnet-5 and newer reject
`temperature`**, and this script omits it for them automatically; a caller
copying the request shape elsewhere must do the same or every call 400s, which
presents as a model that cannot read anything.

The X-miscounting that dominated the smaller models is essentially gone on
sonnet-5 (XXXL went 19/26 -> 26/26). Worth knowing for whoever revisits this: a
bigger IMAGE does not help that class. Running the same bursts at full capture
resolution scored identically on sonnet-4-5, because the vision API downsamples
to roughly 1568px on the long edge anyway, so the sticker never gains pixels. A
crop stage would — it is not built, and at one miss in 267 it is not worth
building yet.
