# ADR-0034: Retry an unread receipt QR on preprocessed pixels, decoded with jpeg-js

> **Status:** proposed
> **Date:** 2026-10-03
> **Related plan(s):** [Plan 0031](../plans/0031-receipt-photo-qr-retry-passes.md)

## Context

ADR-0019 chose zxing-wasm and fed it the raw JPEG bytes. That ADR said real-photo robustness was
unproven, and that the fallback for failing photos would be the pasted link, not a second decoder.
On 2026-10-03 five real Serbian receipt photos (1080x1920, as Telegram delivered them) all got the
"no QR" hint. The diagnostics logging added that day (commit `1a8b9d1`) and a local experiment
found the following:

- In 2 of the 5, ZXing locates the symbol (QR version 20 to 23, EC level L, 7 to 8 px per module)
  and fails Reed-Solomon (`ChecksumError`). In the other 3 it locates nothing.
- Resolution is not the bottleneck. The causes are thermal-print dot gain (dark modules bleed into
  light ones), paper curl and creases, mild blur, and the lowest EC level (about 7% of codewords
  correctable).
- zbar and OpenCV's WeChat decoder also failed all five. The user reports that the phone's own
  camera scanner struggles with these receipts too.
- ZXing's own options (binarizers, `tryDenoise`, downscale on/off) rescued none. ImageMagick
  preprocessing before ZXing rescued one: a 1 px Gaussian blur, then a local-mean threshold
  (31x31 window, offset -3%).

Preprocessing needs pixels. zxing-wasm decodes the JPEG internally and exposes no pixels. In Node
it does accept a plain `{ data, width, height }` RGBA object in place of `ImageData` (verified
2026-10-03 against the synthetic fixture). So the only missing piece is a JPEG decoder.

## Decision

When the plain pass reads no receipt QR, `src/fiscal/qr.ts` decodes the JPEG to pixels with
**`jpeg-js`** (pure JS, no dependencies, pinned exactly). Decoding runs with its
`maxResolutionInMP` and `maxMemoryUsageInMB` limits set, because the input is untrusted. The
adapter converts the pixels to luminance and retries ZXing on a short, ordered list of
preprocessed variants written in plain TypeScript in the receipts adapter (blur, local-mean
threshold, morphology, crop to a located symbol). It stops at the first decode, within a
wall-time budget. The variant list is chosen by measuring a private, gitignored corpus of real
failed photos. A variant that rescues nothing in the corpus doesn't ship. A PNG or other
non-JPEG image gets only the plain pass.

## Consequences

### Positive
- No native build and no `allowBuilds` entry. The added dependency is small, pure JS and has no
  transitive dependencies.
- Each variant is a small pure function over a luminance array, unit-testable without a decoder,
  and replaceable when the corpus says so.
- The plain pass runs first and unchanged, so a photo that decodes today decodes the same way and
  just as fast.

### Negative
- `jpeg-js` was last released in 2022. JPEG baseline/progressive decoding is stable ground, but
  any bug fix depends on a dormant project. The memory limits and the 20 MB download cap bound
  the damage from a hostile file.
- A failed photo now costs several decode passes. They block the event loop for up to the budget
  (the plan sets it). On a single-user bot that's acceptable. A worker thread is the escape hatch
  if it isn't.
- Full RGBA of a 2560x1440 HD photo is about 15 MB transient, on a 256 MiB container.
- Real-photo gains are unproven beyond one of five. The plan measures them on the corpus and
  states the result instead of promising a rate.

## Alternatives considered

### Alternative A: sharp (libvips) for decoding and preprocessing
It handles every format and has fast, mature filters. It lost again for ADR-0019's reason: a
native dependency that the `--ignore-scripts` install must special-case, plus more memory on the
shared box. The filters needed are a few dozen lines of TypeScript.

### Alternative B: ZXing options only, no pixels
This would add no dependency. It lost on evidence: every option combination rescued 0 of 5.

### Alternative C: Rely on the live scanner and the pasted link only
Plan 0030's live scan reads many frames, but the user reports that the phone's scanner struggles
with these receipts too. So the photo path stays worth improving, and the scan and the link
remain the fallbacks.
