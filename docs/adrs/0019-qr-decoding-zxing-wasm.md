# ADR-0019: Decode receipt QR codes with zxing-wasm, with its wasm binary loaded from node_modules

> **Status:** proposed
> **Date:** 2026-10-01
> **Related plan(s):** [Plan 0014](../plans/done/0014-fiscal-receipts-rs-me.md)

## Context

ADR-0001 chose Node partly on the claim that JS/WASM QR decoders are good enough, "to be confirmed
in the receipts ADR". This is that ADR.

The input is a Telegram photo of a thermal receipt. Photos are recompressed, reportedly to 1280 px
on the long side (2560 px with the HD toggle; Telegram doesn't document this). Serbian QR codes
are dense: the 834-character verify URL needs about a 97-module code, so it needs roughly 300 px
of the frame to get 3 px per module. Montenegrin codes are short URLs and much less dense.

The runtime image installs production dependencies with `--ignore-scripts` and rebuilds only
`better-sqlite3` (ADR-0006, `pnpm-workspace.yaml`). A second native dependency (sharp/libvips)
would add a rebuild, platform binaries and an `allowBuilds` entry. The bot also must not fetch
code at runtime.

In a synthetic test on 2026-10-01 (the Serbian verify URL rendered to a QR, rotated 1.7 degrees,
noised, saved as JPEG q75), `zxing-wasm` decoded at 3 px per module and above, and `jsQR` failed at
every scale up to 5 px per module. This is one synthetic image, not a corpus of real receipts.

## Decision

We decode with **`zxing-wasm`** (ZXing-C++ compiled to WebAssembly, version 3.1.4 at the time of
writing, pinned exactly). We use the reader subpath with `formats: ['QRCode']` and
`tryHarder: true`. It takes the raw JPEG/PNG bytes Telegram returns, so no separate image decoder
is needed. Before the first decode, `prepareZXingModule` gets the `.wasm` binary read from the
installed package (`import.meta.resolve` plus `readFile`), because by default the library
downloads it from jsDelivr. Decoding lives in the receipts adapter (`src/fiscal/qr.ts`), never in
`src/domain/`.

## Consequences

### Positive
- No native build and no `allowBuilds` change. The Docker image gains about 1 MB of wasm.
- One call turns an image into text, and the same call handles a photo or an image sent as a file.
- An actively maintained decoder with ZXing's robustness on rotation and noise.

### Negative
- The wasm module is about 1 MB and is instantiated once per process, so it costs memory on the
  shared VPS. Decoding a large photo blocks the event loop for its duration (UNVERIFIED cost,
  measured in the plan).
- The library's runtime-fetch default is a trap. A version bump that changes the binary's path
  breaks decoding at startup, so the plan pins the loader with an offline test.
- Real-photo robustness is unproven. If real receipts fail too often, the fallback is the pasted
  link, not a second decoder.

## Alternatives considered

### Alternative A: jsQR + jpeg-js
Pure JS and small, but jsQR hasn't been released since 2021, needs a separate JPEG-to-RGBA
decoder, and failed the dense-code test at every scale.

### Alternative B: sharp + a decoder
sharp could crop, upscale and sharpen before decoding. It lost because it's a native libvips
dependency that the `--ignore-scripts` install would have to special-case, for a gain we can't yet
show we need.

### Alternative C: Link-only input, no decoder
The user scans with the phone's camera app and shares the link. This has zero dependencies and
stays in the plan as the fallback path. It lost as the only path on the user's call: the photo is
the expected gesture.
