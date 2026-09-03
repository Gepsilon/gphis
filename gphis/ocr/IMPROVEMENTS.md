# OCR — measured performance work, and what is left

A record of what was tried, what it cost, and what remains. Everything here was
measured on the same document unless stated: `FA0605-23.pdf`, a 3-page Beker
invoice with 32 line items, run against the vLLM sidecar on a 16 GB card.

Kept because the rejected ideas matter as much as the accepted ones — three of
them look obviously good and are not.

---

## Where the time goes

After the fixes below, a 3-page invoice takes **~7.4 s**:

| stage | time | share |
| --- | --- | --- |
| PDF render | 0.40 s | 5% |
| Layout detection (local GPU) | 0.18 s | 2% |
| **VLM decode** | **~7.4 s** | **93%** |

Rendering and layout are noise. Anything further has to come out of the VLM.

---

## Done

### Serve the VLM with vLLM instead of in-process

**29 s/page → 2–4 s/page.** The in-process backend decodes a page's ~30 layout
blocks one at a time (`batch_size` is 1). A server backend hands them over
together and overlaps them.

Four environment blockers, all silent or late-surfacing, are documented in
`docker/Dockerfile.vllm` and `docker-compose.vllm.yml` on the platform.

### Batch the pages of a document into one call

**11.78 s → 7.4 s (37%)**, byte-identical output. The ladder looped pages, so
page two's blocks could not start until page one's last block finished —
serialising the one thing the sidecar exists to overlap.

### Cap page size before the OCR engine

Detection on a 300 dpi A4 scan reserved 5.27 GB; capped at 4 MP it reserved
3.09 GB, ran 1.7x faster, and found one more line. This is the allocation that
OOMs the GPU when the sidecar shares the card.

---

## Rejected, with the evidence

### Threads over pages — **breaks correctness**

Three threads returned **40 rows where the correct answer is 31**. The pipeline
shares one layout model and concurrent calls corrupt each other's state rather
than raising. Do not revisit without a pipeline instance per thread.

### `max-num-batched-tokens` 16384 → 65536 — no gain, real cost

No measurable speed change, and the KV cache fell from **121,936 to 31,456
tokens** (7.44x to 1.92x concurrency): a larger batch budget takes activation
memory from the same allocation. vLLM's own PaddleOCR-VL recipe recommends
16384 and it is right.

### Lower render DPI — loses accuracy

| DPI | time | cells wrong (of 429) |
| --- | --- | --- |
| 200 | 12.85 s | baseline |
| 150 | 7.09 s | 2 — `PINATEL®`→`PINATEL @`, `LAX SENA`→`LAX,SENA` |
| 120 | 7.35 s | 4 — `Sitagliptine`→`Stagliptine`, `Date Prmp`→`Date Pmp` |

Both are description-column errors, which is where item matching happens, so
2 of 32 products would fail to match. Kept at 200. `render_document(dpi=...)`
takes the argument if a caller ever wants the trade.

---

## Not yet tried, roughly in order of expected value

### 1. N-gram speculative decoding

The best fit for this workload and **lossless by construction** — rejected
drafts fall back to the real model, so there is nothing to validate. Invoice
rows are highly repetitive: the same column structure, recurring product-code
prefixes, `0.00` and `(DA)` over and over. That is exactly what n-gram
speculation exploits. Plausibly 1.3–2x.

Add to `docker/vllm-server.yaml` on the platform:

```yaml
speculative-config: '{"method": "ngram", "num_speculative_tokens": 5, "prompt_lookup_max": 4}'
```

### 2. FP8 weights and KV cache

The card has native FP8. The model is only 0.9 B and decode-bound rather than
memory-bound, so expect less than speculation buys — and unlike speculation it
**changes the numbers**, so validate against the 429-cell baseline before
keeping it.

### 3. The fast image processor

vLLM still logs `Using a slow image processor`. Every one of ~30 blocks per
page goes through PIL-based preprocessing. Unknown size, cheap to test. May
need Transformers v5, which vLLM wants anyway — the v4 codepath is removed in
vLLM 0.24.

### 4. Per-block pixel clamp

PaddleOCR-VL clamps each block to 1,003,520 px internally. Lowering it cuts
vision tokens **only on large blocks** — the line-item table — and leaves small
text blocks untouched. Potentially the accuracy/speed trade that whole-page DPI
reduction gets wrong, applied where it costs least.

---

## Open correctness gap: alignment is not used on the VL path

The platform's OpenCV reference-image alignment (`app/documents/template/align.py`)
is accurate and worth keeping. It currently runs only on the template
extraction tier.

The VL path matches extracted values to annotated boxes **by position**, and
today it corrects only for scale — reference pixels to rendered-page pixels. A
scan that is rotated or shifted relative to the reference will therefore miss
its boxes, and the failure is quiet: the value simply appears unclaimed, which
looks identical to "the document does not have that field".

Running the existing alignment first, then matching in the aligned frame, would
make positional matching hold for photographed and skewed documents. This is
the single most valuable correctness item left.

---

## Baseline for regression checks

The document above should return, at 200 dpi:

* **32 line items** — the invoice states `Nombre produits facturée: 32(Unites)`,
  which is an independent check that no page was dropped
* **21 header fields**, including `Total TTC: 7 138 694.18 (DA)`
* arithmetic **32/32**, and a 33x13 grid of 429 cells
