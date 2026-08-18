# StockPilot landing film — production plan

Status: the film is **live and scrubbing** on the existing 546-frame sequence. This
document covers what to generate to make it better, and how, without wasting credits.

---

## 1. Assessment of the existing footage — do not throw it away

I sampled the shipped sequence at nine points before planning anything. It is
better than it was given credit for:

| Frame | % | Content | Verdict |
|---|---|---|---|
| 1–70 | 0–13% | Wide aisle, slow push, figure distant | **Keep** — strong establishing shot with a clean left-side negative space |
| 140 | 26% | Figure walking toward camera down the aisle | **Keep**, but it is doing a job it was not shot for (see gap A) |
| 210 | 38% | Hand holding a phone against a shelf label | **Keep** — excellent |
| 280 | 51% | Phone scanning a carton barcode, mint scan beam, confirm tick | **Keep — this is the best frame in the set** |
| 350 | 64% | Carton opened on a bench, scanner resting | **Keep** |
| 420 | 77% | Blue crate riding a cart in the aisle | **Keep** — and it happens to match the crate model |
| 490 | 90% | Cart of crates travelling through filled racks | **Keep** |
| 546 | 100% | Elevated wide, aisle in order | **Keep** |

Three properties make this footage genuinely valuable and expensive to reproduce:

1. **It is already one location.** Same architecture, same rack system, same floor,
   same high-window daylight throughout. That continuity is the hardest thing to
   generate and the easiest thing to destroy.
2. **The accent is already on-brand.** The shelf labels and the scan beam are a
   mint/teal that sits within a few degrees of `--mint #5db89f`. That is luck, and
   it is worth protecting.
3. **The compositions leave negative space.** The aisle converges near centre, so
   copy sits comfortably left through the whole run.

**Recommendation: generate 3 shots, not 8.** Regenerating the whole film would cost
far more, risk continuity, and replace footage that is already working.

---

## 2. The three real gaps

### Gap A — INBOUND (chapter 01, Purchase order)
The film starts *inside* the building. There is no arrival: no dock, no truck, no
pallets crossing the threshold. Chapter 01 currently plays over "a figure walking
down an aisle", which does not say *an order arrived*.

### Gap B — STAGING (chapter 03)
There is no shot of stock **waiting** — the visual idea of "received, counted,
not yet placed" is the one beat the footage never states. Chapter 03 currently
borrows the bench/unpacking shot.

### Gap C — PLACEMENT (chapter 04, Put away)
Nothing is ever *placed onto a rack*. The cart shot implies transport, not
placement. This is the chapter carrying StockPilot's sharpest domain claim — a
crate sits **on** a rack — so it is the most valuable gap to close.

Optional Gap D — a true crane-up for the close. Frame 546 already works; do this
only if credits are spare.

---

## 3. The technique that makes this work: frame chaining

**Seedance 2.0 accepts both `start_image` and `end_image`.** This is the whole
plan. Rather than generating free-floating clips and hoping they match, every new
shot is pinned to real frames:

```
existing f_0140.jpg ──> [ SHOT A ] ──> existing f_0150.jpg
      (end_image)                          (start_image)
```

Concretely:

- **Gap A** generates *backwards* from the film's opening: its `end_image` is
  `frames-hi/f_0001.jpg`, so the new arrival footage lands exactly on the existing
  first frame. The join is invisible because it is literally the same pixel data.
- **Gap B** and **Gap C** are generated *between* two existing frames — start on
  one real frame, end on another — so both joins are pinned.

This converts "make it feel like one location" from a prompt-engineering hope into
a mechanical guarantee. It is also why the shots must be generated in the order
below: each one's anchor frames must exist first.

Extract the anchors with:

```bash
cd apps/web/public/landing/frames-hi
cp f_0001.jpg f_0140.jpg f_0150.jpg f_0400.jpg f_0410.jpg ~/Desktop/anchors/
```

---

## 4. Model and settings

| Setting | Value | Why |
|---|---|---|
| Model | `seedance_2_0` | The only recommended model carrying `start_image` **and** `end_image` **and** `image_references` |
| `mode` | `std` | Required for 1080p; `fast` caps at 720p |
| `resolution` | `1080p` | Matches the existing 1920×1080 frames exactly. Do not generate 4K — it is discarded at frame extraction |
| `aspect_ratio` | `16:9` | Matches existing |
| `duration` | 5s | ~120 frames at 24fps, which is the right density for a chapter |
| `generate_audio` | **`false`** | This is a silent scroll-scrub. Audio is pure waste |
| `bitrate_mode` | `high` | Frames get re-encoded as JPEG; start from the cleanest source |

Balance at time of writing: **1,118 credits, Plus plan.** Confirm per-generation
cost in the UI before a batch — budget for 2–3 attempts per shot, because the
first generation rarely lands the camera move.

---

## 5. Shot specifications

### SHOT A — `inbound-dock`

| Field | Value |
|---|---|
| Chapter | 01 Purchase order (film 0.11–0.26) |
| Purpose | Say *an order physically arrived*, which the film currently never does |
| Composition | Loading dock interior looking out; daylight from the opening; pallets stacked right; **left third kept empty and darker** for the headline |
| Camera | Slow dolly forward, from the dock threshold inward. No pan, no tilt |
| Lighting | Bright daylight from the dock door, falling off to the interior warehouse ambient. Must resolve to the same interior key as `f_0001` |
| Continuity | Same concrete floor, same black steel racking, same pale walls, same high windows |
| UI safe zone | Left 40% |
| Start frame | none (film opens here) |
| **End frame** | `frames-hi/f_0001.jpg` — **required**, this is what welds it to the existing film |
| Duration | 5s · 16:9 · 1080p |

**Prompt**
```
Photorealistic cinematic interior of a modern distribution warehouse, viewed from
just inside a loading dock. Daylight pours through the open dock door and falls off
into cool interior ambient. Stacked cardboard cartons and shrink-wrapped pallets sit
to the right of frame. Tall black steel racking recedes into the background. Polished
concrete floor. Slow steady dolly moving forward from the dock into the building.
Locked horizon, no handheld shake. Muted natural colour, soft contrast, shallow
depth in the background only. The left third of the frame is open, uncluttered and
slightly darker. Anamorphic 35mm look, no lens flare.
```

**Negative prompt**
```
text, logos, brand names, signage, watermarks, people looking at camera, crowds,
fast motion, whip pan, crash zoom, handheld shake, lens flare, HDR, oversaturation,
neon, futuristic sci-fi, robots, drones, forklifts driving at speed, motion blur,
fisheye, tilted horizon, night, snow, outdoor parking lot
```

**Transition out** → ends exactly on `f_0001`, the existing aisle push.

---

### SHOT B — `staging-bay`

| Field | Value |
|---|---|
| Chapter | 03 Staging (film 0.55–0.68) |
| Purpose | The idea the footage has never stated: stock **waiting**, received but not yet placed |
| Composition | A marked floor bay holding neatly grouped cartons and one blue crate, racking behind. **Left 40% open** |
| Camera | Slow lateral track left-to-right past the staging bay. Subjects nearly static — this is the calmest shot in the film |
| Lighting | Same overhead daylight; no new practical sources |
| Continuity | The blue crate must match the one at `f_0420`. Same floor, same racking |
| UI safe zone | Left 40% |
| **Start frame** | `frames-hi/f_0400.jpg` |
| **End frame** | `frames-hi/f_0410.jpg` |
| Duration | 5s · 16:9 · 1080p |

**Prompt**
```
Photorealistic modern warehouse interior. A floor staging area marked with painted
yellow lines holds neatly grouped cardboard cartons and a single blue plastic crate,
arranged in orderly rows and clearly waiting to be put away. Tall black steel racking
filled with boxes stands behind. Polished concrete floor with soft reflections.
Overhead daylight from high clerestory windows. Very slow lateral tracking movement
from left to right, camera parallel to the staging area. Subjects still. Calm,
ordered, documentary. Muted natural palette, soft contrast. Left portion of frame
open and uncluttered.
```

**Negative prompt**
```
text, logos, brand names, signage, watermarks, clutter, mess, spilled goods, people
in motion, fast camera movement, whip pan, zoom, handheld shake, lens flare, HDR,
oversaturation, neon, dramatic shadows, night, empty featureless room
```

**Transition out** → lands on `f_0410`, continuing into the existing cart move.

---

### SHOT C — `place-into-crate` (highest value)

| Field | Value |
|---|---|
| Chapter | 04 Put away (film 0.68–0.80) |
| Purpose | Show a crate **on a rack**, and stock going into it. This is StockPilot's sharpest domain claim and the film currently never depicts it |
| Composition | Medium shot, rack bay at mid-height; a blue crate already seated **on a rack shelf**; gloved hands place a boxed item into it. **Right 45% open** — this chapter's copy sits right |
| Camera | Slow push-in toward the crate, ending on the crate lip. Minimal parallax |
| Lighting | Same overhead daylight, slight falloff into the rack depth |
| Continuity | Blue crate identical to Shot B and `f_0420`. Same racking, same gloves/apron as the existing operator shots |
| UI safe zone | **Right 45%** (deliberately the opposite side from every other shot — this is what lets the page flip its scrim and vary composition) |
| **Start frame** | `frames-hi/f_0410.jpg` |
| **End frame** | `frames-hi/f_0420.jpg` |
| Duration | 5s · 16:9 · 1080p |

**Prompt**
```
Photorealistic close medium shot inside a modern warehouse. A blue plastic crate sits
on a black steel rack shelf at chest height, seated squarely on the shelf. A worker in
a dark apron and light work gloves carefully lowers a small cardboard box into the
crate. Neighbouring shelves hold neatly arranged cartons. Overhead daylight, soft
falloff into the depth of the racking. Very slow push-in toward the crate, ending
framed on the crate opening. Deliberate, unhurried, precise. Muted natural colour,
soft contrast, shallow depth of field on the background racking. Right side of frame
open and uncluttered.
```

**Negative prompt**
```
text, logos, brand names, barcodes with readable numbers, signage, watermarks, faces
toward camera, fast hands, dropping, throwing, clutter, fast camera movement, whip
pan, crash zoom, handheld shake, lens flare, HDR, oversaturation, neon, crates on the
floor, crate stacks without racking
```

**Transition out** → lands on `f_0420`, the existing cart shot.

---

### SHOT D — `crane-out` *(optional, only if credits are spare)*

Crane up and back from the aisle to a calm high-wide of the ordered warehouse.
`start_image` = `frames-hi/f_0546.jpg`, no end frame. 5s. Appended to the film's
tail so the close resolves upward. Same prompt discipline as above; camera direction
"slow crane up and backwards, revealing the full aisle grid".

---

## 6. Assembly pipeline

```
generate (2-3 attempts per shot)
   ↓ pick the take whose motion is steadiest — NOT the prettiest single frame
match exposure + white balance to the existing plates
   ↓ the existing footage is the reference; grade new material to IT
splice: A + existing[1..140] + existing[141..400] + B + C + existing[421..546] (+ D)
   ↓ joins are already pinned by the anchor frames, so no dissolves are needed
export ProRes / high-bitrate master, 1920x1080, 24fps
   ↓
extract frames:
   ffmpeg -i master.mov -vf "scale=1920:1080" -q:v 4 frames-hi/f_%04d.jpg
   ffmpeg -i master.mov -vf "scale=1280:720,select='not(mod(n\,2))'" -q:v 6 frames-lo/f_%04d.jpg
   ↓
update HI.count / LO.count in components/marketing/landing/film.ts
   ↓
re-tune CHAPTER_RANGE in the same file — the ranges are NORMALISED, so a changed
frame count does not require touching the chapters, but the CONTENT boundaries move
```

**After any footage change, re-run `film.test.ts`.** It asserts the chapter ranges
are contiguous, cover 0–1, and match the story stage keys one-for-one — which is the
guard against "foreground says Purchase Orders, background shows a forklift".

---

## 7. What this costs and what to do first

Generate **Shot C first**. It closes the most valuable gap, and it is the one whose
success or failure tells you whether the chaining technique holds on this footage.
If Shot C's joins are clean, run A and B. If they are not, stop — the existing film
already works, and no further credits should be spent until the join problem is
solved on one shot.
