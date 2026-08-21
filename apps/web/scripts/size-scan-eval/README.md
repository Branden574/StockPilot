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

| prompt | model | overall | no-sticker recall | false sizes |
|---|---|---:|---:|---:|
| first draft | Haiku 4.5 | 73.0% | 40.5% | 25 |
| + rotation alphabet | Haiku 4.5 | 89.1% | 83.3% | 7 |
| + carrier field | Haiku 4.5 | 89.9% | 100% | 0 |
| + carrier field | Sonnet 4.5 | 95.5% | 100% | 0 |
| shipped prompt | Sonnet 4.5 | **95.1%** | 97.6% | 1 |

The remaining error is concentrated in one place: **XXXL read as XXL, 7 of 26**.
It is not a resolution problem — running the same bursts at full capture
resolution scored identically, because the vision API downsamples to roughly
1568px on the long edge anyway, so the sticker never gains pixels. Fixing it
needs a crop stage (locate the dot, crop, re-read), which is not built.
