# Cura OCR — ERPNext connector

The `OCR` module inside the Cura app. It connects ERPNext to the OCR Platform,
lets users draw document templates without leaving the Desk, and fills forms
from scanned documents.

The platform is a separate service. This module holds **no OCR logic at all** —
it is a client, plus the UI for driving one.

---

## Contents

1. [How it fits together](#how-it-fits-together)
2. [Setup](#setup)
3. [DocTypes](#doctypes)
4. [Extraction strategies](#extraction-strategies)
5. [Guides](#guides)
6. [Files](#files)
7. [Design notes](#design-notes)

---

## How it fits together

```
  Browser / phone
        │  uploads a file, picks a template
        ▼
  ERPNext (this module)          ← holds the API key, server-side only
        │  REST + X-API-Key
        ▼
  OCR Platform                   ← alignment, extraction, validation
```

**The API key never reaches the browser.** Everything goes through whitelisted
methods, which is the whole reason to route through Frappe rather than calling
the platform from JavaScript.

Templates are *edited* here and *stored* on the platform, which needs the
reference image as pixels at alignment time. Frappe pushes; the platform is the
system of record.

---

## Setup

### 1. Point at the platform

**OCR Settings** (single DocType) → set the Base URL and API key.

| Topology | Base URL |
| --- | --- |
| `bench start` on the same machine | `http://localhost:8080` |
| Frappe in Docker, same machine | `http://ocr-platform:8080` |
| Remote or hosted platform | `https://ocr.example.com` |

Create a key on the platform:

```bash
cd /home/mouaad/Projects/ocr-platform && docker compose exec ocr python /srv/scripts/manage.py key create --email ops@example.com --name erpnext
```

Paste it into OCR Settings, then press **Test Connection**. It checks
reachability first and credentials second, so "the box is down" and "your key
is wrong" produce different messages.

### 2. Check the quota

**Refresh Quota** fills in plan, credits and period. The dashboard indicator
turns amber at 70% used and red at 90% — the point is to warn before a
receptionist hits a 402 mid-scan.

Full breakdown: **OCR → Usage and Billing** (`/app/ocr-usage`).

---

## DocTypes

| DocType | Purpose |
| --- | --- |
| **OCR Settings** | Single. Connection, defaults, widget behaviour, retention, cached quota. |
| **OCR Template** | A document design: reference image, drawn regions, platform ID, version. |
| **OCR Profile** | Binds a document type to a target DocType, with field mappings. |
| **OCR Field Mapping** | Child of Profile: source field → target field, with a transform. |
| **OCR Scan** | One row per scan. Image, status, credits, raw response, extracted fields. |
| **OCR Extracted Field** | Child of Scan: field, value, confidence, applied. |
| **OCR Document Type** | Local cache of the platform's document types. |

`OCR Settings.api_key` uses the `Password` fieldtype, so Frappe encrypts it at
rest.

---

## Extraction strategies

Two paths, chosen per profile by **Extraction Strategy**:

| Strategy | Used for | How it reads the page |
| --- | --- | --- |
| **Vision Model** | Invoices | PaddleOCR-VL reads the page directly, returning the line-item table *and* the key/value blocks printed around it in one pass |
| **Plain OCR** | ID cards | Text lines from fixed positions on a card aligned to its reference — no VLM, which would be slower and add nothing to a document with no table |

The geometric detector and the ladder were removed from this app after a
563-invoice comparison; see `IMPROVEMENTS.md` for the numbers. They remain on
the platform, which is ERP-neutral and has other callers.

### Templates are bindings, not just extractors

A template does two separable jobs, and an invoice profile uses only the
second:

1. **Alignment.** The scan is warped onto the reference image with OpenCV
   feature matching before anything reads it. Measured on a copy rotated 3.5°
   and shifted 65 px, the extracted field boxes landed **within one pixel** of
   the unrotated original. Without it, positional matching fails on any
   photographed or skewed page — and fails *quietly*, looking identical to
   "the document does not have that field".
2. **Bindings.** Each drawn box carries the target DocType's own fieldname, so
   an extracted value arrives already addressed to the field it fills.

A value is matched to a box three ways, and the difference is shown in the
review panel because it is the difference between a fact and a guess:

| Verdict | Meaning |
| --- | --- |
| matched by position | The value was read from inside the drawn box. Certain. |
| guessed by name | Only the wording resembled a field name. **Check it.** |
| unclaimed | Nothing matched. Map it by hand, or ignore it. |

Without a template, nothing is lost: the vision model still returns the table
and the header fields, and the columns are mapped once during review. That
mapping is saved to the profile, so the next scan from the same supplier is
automatic.

### Playground

**OCR → OCR Playground** (`/app/ocr-playground`) runs a document you upload and
shows what came back: the reconciliation verdict, the extracted table, the
header fields, time, and credits.

Use it when onboarding a new supplier's paperwork — on a real document, before
committing a profile to it. Each run is charged, because each does the GPU
work, which is still far cheaper than discovering the wrong setup after it is
deployed across a document flow.

The result is deliberately shown in three states, not two:

| Verdict | Meaning |
| --- | --- |
| ✓ Reconciled | A table was extracted **and** its arithmetic checks out |
| ~ Extracted, unverified | A table came back, but nothing proves it is right |
| ✗ Nothing usable | No table |

The middle state is the one that matters. A best-effort result is returned when
nothing reconciles, and rendering that as a success is how an unchecked total
reaches an invoice.

---

## Guides

### Draw a template

1. **OCR Template → New.** Give it a name, a document type (the identifier the
   platform stores it under, e.g. `upc_invoice`), and attach a **reference
   image** — a clean example of that document design.
2. Set **Target DocType** — the annotator offers that DocType's fields, so
   without it there is nothing to drag.
3. Save, then click **Open Annotator**.
4. The left panel lists the target's **user-visible fields**, and a section per
   child table. Drag a field onto the page: the box appears already bound to
   that fieldname. Move it, resize it by the corner handle. Placed fields grey
   out in the palette.
5. For line items, drag the child table's **Table area** chip first, then drag
   that table's fields inside it to become columns.
6. **Save**, then **Sync to Platform**.

Boxes are never named by hand. The name would be a matter of spelling, and a
misspelled key maps to nothing — dragging a real field makes that impossible.

A template cannot be synced with a table that has no columns, or with the same
field placed twice — both are caught while the drawing is still on screen.

> **Why you draw columns but not rows:** a template cannot know how many line
> items a document has. Columns are fixed by the design; rows are found at
> extraction time by clustering text.

### Scan a document into a form

1. **OCR Profile → New**: pick the document type, the **target DocType**, and
   add field mappings (`source_field` → `target_field`, with an optional
   transform such as `Date (YYYY-MM-DD)` or `Digits Only`).
2. Hard-reload the browser (**Ctrl+Shift+R**). The list of OCR-enabled DocTypes
   ships in the Desk boot payload, so a new profile is invisible until the page
   reloads.
3. Open a record of the target DocType. A floating **Scan** button appears
   bottom-right.
4. Upload or photograph the document. On a phone the file input opens the
   camera directly.
5. The **review panel** lists every extracted field with its confidence.
   Low-confidence reads are flagged in red. Values are editable.
6. **Apply** fills the open form. *Nothing is saved* — you review and save.

Mapping to a field the target DocType does not have is rejected when the
profile is saved, not silently ignored at scan time.

### Reading the results

An **OCR Scan** record is created for every attempt, including failures.

| Status | Meaning |
| --- | --- |
| `Completed` | Extraction succeeded |
| `Failed` | The platform returned an error, or alignment failed |
| `Quota Exceeded` | No credits left — nothing was charged |

`mark_applied` records which fields a human actually accepted. That gap —
between what OCR proposed and what was kept — is the only honest measure of
extraction quality on real documents.

### Retention

Scanned identity documents are personal data, so retention is **enforced**, not
merely documented. `OCR Settings → Retention (Days)` defaults to 90; `0` opts
out explicitly. A daily scheduled job removes expired scans along with their
attached images.

```bash
bench --site gp.local execute gphis.ocr.tasks.purge_expired_scans
```

---

## Files

```
gphis/ocr/
  client.py        HTTP client — the only place that knows the platform exists
  api.py           Whitelisted methods called from the Desk
  mapping.py       Platform response → reviewable rows; value transforms
  boot.py          Ships enabled profiles with the Desk boot payload
  tasks.py         Daily retention purge
  doctype/         OCR Settings · Template · Profile · Scan · Document Type
  page/
    ocr_annotator/  Canvas annotator
    ocr_playground/ Strategy comparison on a real document
    ocr_usage/      Usage and billing dashboard
  workspace/ocr/   The OCR workspace
public/js/
  ocr_widget.js    Floating scan button, upload dialog, review panel
```

Registered in `hooks.py`: `extend_bootinfo` for the widget, `scheduler_events`
for retention, and `app_include_js` for the bundle.

---

## Design notes

**Why the widget knows where to appear without a server call.** Enabled
profiles are pushed into `frappe.boot.ocr` by `boot.py`. Deciding per form load
with an HTTP request would put a round trip in front of every navigation. The
cost is that a new profile needs a page reload.

**Why the annotator stores image pixel coordinates.** Boxes are recorded in the
reference image's own coordinate space, not screen space, so a template drawn
on a zoomed-out view stays correct.

**Why columns carry no height.** A column is `[x, y, width]` relative to its
table. Height belongs to the table body, whose extent is only known once rows
are clustered at extraction time — the schema encodes the constraint directly.

**Why failures are recorded.** A failed scan that leaves no trace is a support
ticket with no evidence. Quota rejections are recorded too; a customer
repeatedly hitting their ceiling should be visible.

**Two gotchas found the hard way:**

- Editing a **workspace JSON** without bumping its `modified` timestamp does
  nothing — Frappe skips re-syncing a workspace older than the database record.
- A Frappe **DocType JSON** with a `table` region and no columns will sync
  happily and then extract nothing from every document. Validation runs at save
  time on both sides for this reason.

---

## Configuration reference

| OCR Settings field | Default | Effect |
| --- | --- | --- |
| `enabled` | ✓ | Master switch; turns off all OCR without losing configuration |
| `base_url` | `http://localhost:8080` | Platform address |
| `api_key` | — | Encrypted at rest |
| `default_mode` | `balanced` | `fast` / `balanced` / `accurate` — see the warning below |
| `default_lang` | `en` | PaddleOCR language code |
| `default_min_confidence` | 0.5 | Below this, values are flagged for review |
| `show_widget` | ✓ | Show the floating scan button |
| `widget_position` | Bottom Right | |
| `store_scan_images` | ✓ | Turn off if scanned documents must not be stored |
| `retention_days` | 90 | `0` keeps scans forever |

> **`mode` changes billing, not work.** On the platform, `/v1/ocr` and
> `/v1/documents/extract` read `mode` to validate it and to price the request —
> 1, 2 and 4 credits per page for `fast`, `balanced` and `accurate` — and then
> run exactly the same extraction regardless.
>
> A **Vision Model** profile goes through `/v1/documents/analyze`, where the
> strategy decides the work and `mode` still only prices it. So on either path
> `accurate` costs 4x per page for the same result. Leave `default_mode` at
> `fast` unless the pricing is deliberate.
