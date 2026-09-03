"""Turning an OCR response into reviewable, mappable rows.

Handles both shapes the platform can return:

* **Named fields** — what the document registry (P2-2) will produce:
  `{"fields": {"surname": {"value": "...", "confidence": 0.98}}}`
* **Raw lines** — what it returns today: a flat list of detected text lines.

Writing both now costs a few lines and means this file does not need revisiting
when extractors land; named fields simply start appearing in the review panel.
"""

import re
from datetime import datetime

TRANSFORMS = (
    "None",
    "Uppercase",
    "Lowercase",
    "Title Case",
    "Date (YYYY-MM-DD)",
    "Digits Only",
    "Number",
)

# Separators seen on ID cards and invoices. The engine reads a period as a
# comma often enough that both must be accepted.
_DATE_PATTERNS = (
    "%Y-%m-%d",
    "%Y.%m.%d",
    "%Y/%m/%d",
    "%d-%m-%Y",
    "%d.%m.%Y",
    "%d/%m/%Y",
)


def apply_transform(value: str, transform: str | None) -> str:
    if value is None:
        return ""

    value = str(value).strip()

    if not transform or transform == "None":
        return value

    if transform == "Uppercase":
        return value.upper()

    if transform == "Lowercase":
        return value.lower()

    if transform == "Title Case":
        return value.title()

    if transform == "Digits Only":
        return re.sub(r"\D", "", value)

    if transform == "Date (YYYY-MM-DD)":
        return _normalise_date(value)

    if transform == "Number":
        return _normalise_number(value)

    return value


def _normalise_number(value: str) -> str:
    """Turn a printed amount into something a Currency or Float field accepts.

    Invoices in this corpus print `7 138 694.18` and `1 037 860,56` — thousands
    separated by spaces or dots, decimals by a point or a comma. Frappe will
    take neither, and a silent 0 on a quantity is worse than a visible blank,
    so an unreadable value is returned untouched for a human to look at.
    """
    text = re.sub(r"[^\d.,\-]", "", str(value or ""))
    if not text:
        return ""

    # Whichever separator appears last is the decimal one: `1.234,56` is
    # European, `1,234.56` is not, and both occur in the same document set.
    last_dot, last_comma = text.rfind("."), text.rfind(",")
    if last_dot > last_comma:
        text = text.replace(",", "")
    elif last_comma > last_dot:
        text = text.replace(".", "").replace(",", ".")

    try:
        return str(float(text))
    except ValueError:
        return str(value).strip()


def _normalise_date(value: str) -> str:
    """Best-effort date normalisation. Returns the input unchanged on failure.

    Returning the original rather than raising is deliberate: the user is about
    to review this value anyway, and a visible wrong date is easier to correct
    than an exception that loses the whole scan.
    """
    # The engine frequently misreads "." as ",". Normalise before parsing.
    cleaned = value.replace(",", ".").strip()

    for pattern in _DATE_PATTERNS:
        try:
            return datetime.strptime(cleaned, pattern).strftime("%Y-%m-%d")
        except ValueError:
            continue

    return value


def extract_candidates(result: dict) -> list[dict]:
    """Normalise either response shape into {field_name, value, confidence}."""
    fields = result.get("fields")

    if isinstance(fields, dict) and fields:
        candidates = []
        for name, payload in fields.items():
            if isinstance(payload, dict):
                candidates.append(
                    {
                        "field_name": name,
                        "value": payload.get("value"),
                        "confidence": float(payload.get("confidence") or 0.0),
                    }
                )
            else:
                candidates.append(
                    {"field_name": name, "value": payload, "confidence": 0.0}
                )
        return candidates

    # No extractor for this document type yet: fall back to raw lines so the
    # user still sees something reviewable.
    return [
        {
            "field_name": f"line_{index + 1}",
            "value": line.get("text"),
            "confidence": float(line.get("confidence") or 0.0),
        }
        for index, line in enumerate(result.get("lines") or [])
    ]


def build_field_rows(result: dict, profile) -> list[dict]:
    """Attach mapping information to each extracted value.

    `target_field` is None for anything the profile does not map — those rows
    still appear in the review panel so nothing is hidden from the user, they
    just do not fill anything on Apply.
    """
    mappings = {}
    for row in getattr(profile, "field_mappings", []) or []:
        if row.source_field:
            mappings[row.source_field.strip()] = row

    rows = []
    for candidate in extract_candidates(result):
        mapping = mappings.get(candidate["field_name"])
        raw_value = candidate["value"]

        rows.append(
            {
                "field_name": candidate["field_name"],
                "value": raw_value,
                "confidence": candidate["confidence"],
                "target_field": mapping.target_field if mapping else None,
                "transform": mapping.transform if mapping else "None",
                "overwrite_existing": bool(mapping.overwrite_existing) if mapping else True,
                "is_required": bool(mapping.is_required) if mapping else False,
                # What would actually be written to the form.
                "mapped_value": apply_transform(raw_value, mapping.transform if mapping else None),
            }
        )

    return rows


def missing_required(rows: list[dict]) -> list[str]:
    """Mapped-and-required fields that came back empty."""
    return [
        row["field_name"]
        for row in rows
        if row.get("is_required") and not str(row.get("mapped_value") or "").strip()
    ]


def _column_lookup(columns: list[str]) -> dict[str, str]:
    """Match a mapping's source column to a real one, tolerantly.

    The extractor reads the header off the page, so `P.U.Net (DA)` may come
    back with different spacing or casing than whoever typed the mapping used.
    Requiring an exact string would make a profile break on a reprint of the
    same invoice design.
    """
    lookup = {}
    for column in columns:
        lookup.setdefault(column, column)
        lookup.setdefault(column.strip().lower(), column)
        lookup.setdefault(re.sub(r"[^a-z0-9]", "", column.lower()), column)
    return lookup


def build_table_rows(result: dict, profile) -> dict:
    """Turn the extracted table into rows shaped for the target's child table.

    Returns the mapped rows plus what could not be mapped, because a silent
    partial mapping is the failure that costs the most: an invoice that posts
    with eight of its twelve line items looks perfectly normal.
    """
    mappings = [
        row for row in (getattr(profile, "column_mappings", None) or []) if row.source_column
    ]
    tables = result.get("tables") or []
    if not tables:
        return {"rows": [], "columns": [], "unmapped": [], "target_field": None, "row_count": 0}

    # The document's line items are the biggest table; narrow ones are the
    # key/value blocks, and those already arrived as fields.
    table = max(tables, key=lambda t: len(t.get("rows") or []))
    columns = list(table.get("columns") or [])
    lookup = _column_lookup(columns)

    resolved = []
    unmapped = []
    for mapping in mappings:
        wanted = mapping.source_column.strip()
        column = (
            lookup.get(wanted)
            or lookup.get(wanted.lower())
            or lookup.get(re.sub(r"[^a-z0-9]", "", wanted.lower()))
        )
        if column is None:
            unmapped.append(wanted)
        else:
            resolved.append((column, mapping))

    rows = []
    for source_row in table.get("rows") or []:
        mapped = {}
        for column, mapping in resolved:
            value = apply_transform(source_row.get(column, ""), mapping.transform)
            if value != "":
                mapped[mapping.target_field] = value
        # A row that mapped nothing is a separator or a stray line, not a line
        # item, and appending it would put a blank row in the invoice.
        if mapped:
            rows.append(mapped)

    return {
        "target_field": getattr(profile, "table_target_field", None),
        "columns": columns,
        "rows": rows,
        "row_count": len(rows),
        "unmapped": unmapped,
        # Reported so the review panel can say "12 of 32 rows mapped" rather
        # than quietly showing 12.
        "source_row_count": len(table.get("rows") or []),
    }


# --- matching extracted values to annotated boxes --------------------------
#
# A template drawn in the annotator binds a place on the page to a fieldname.
# The vision model reads the same page and returns values with their own
# positions. Matching the two gives a mapping nobody had to type — and, just as
# importantly, tells the difference between a mapping that is certain and one
# that is a guess.

MATCH_BOX = "box"      # the value was read from inside the drawn region
MATCH_NAME = "name"    # only the wording matched; a human should confirm
MATCH_NONE = None      # nothing claimed it


def _centre(box) -> tuple[float, float]:
    x1, y1, x2, y2 = box
    return (x1 + x2) / 2.0, (y1 + y2) / 2.0


def _region_rect(region: dict, scale_x: float, scale_y: float) -> tuple[float, float, float, float]:
    """A drawn region as (x1, y1, x2, y2) in the scanned page's pixels.

    The annotator stores boxes in the *reference image's* coordinates, and the
    scan is rendered at whatever size its own file dictates. Comparing the two
    without scaling silently matches nothing on any document whose render size
    differs from the reference — which is most of them.
    """
    x, y, w, h = (list(region.get("box") or [0, 0, 0, 0]) + [0, 0, 0, 0])[:4]
    return (x * scale_x, y * scale_y, (x + w) * scale_x, (y + h) * scale_y)


def _normalise_label(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())


def match_extracted_fields(result: dict, regions: dict | None, layout: dict | None) -> list[dict]:
    """Classify every extracted value against the template's annotated boxes.

    Returns one row per extracted value with how it was matched, so the review
    panel can apply the certain ones and ask about the rest.
    """
    fields = result.get("fields") or {}
    image = result.get("image") or {}
    subregions = ((regions or {}).get("subregions")) or []

    # When the platform aligned the pages it returned them in the reference's
    # own frame, so the extracted boxes and the drawn boxes are already in the
    # same coordinates and the ratio below comes out at 1. The arithmetic is
    # kept rather than special-cased: it is correct either way, and a scan that
    # failed to align still gets the scale correction it can have.
    reference_w = float((regions or {}).get("reference_width") or 0) or None
    reference_h = float((regions or {}).get("reference_height") or 0) or None
    scale_x = (float(image.get("width") or 0) / reference_w) if reference_w else 1.0
    scale_y = (float(image.get("height") or 0) / reference_h) if reference_h else 1.0

    statics = [r for r in subregions if (r.get("type") or "static") == "static"]
    rects = [(r, _region_rect(r, scale_x, scale_y)) for r in statics]

    # Field labels of the target DocType, for the fallback. Matching on the
    # printed label is a guess: an invoice says "Facture N°" where the DocType
    # says "Supplier Invoice No", and the two agreeing is luck, not evidence.
    by_label = {}
    for field in ((layout or {}).get("fields") or []):
        by_label.setdefault(_normalise_label(field.get("label")), field.get("fieldname"))
        by_label.setdefault(_normalise_label(field.get("fieldname")), field.get("fieldname"))

    claimed = set()
    rows = []
    for key, payload in fields.items():
        value = payload.get("value") if isinstance(payload, dict) else payload
        box = (payload.get("box") if isinstance(payload, dict) else None) or [0, 0, 0, 0]
        cx, cy = _centre(box)

        target, match = None, MATCH_NONE
        if any(box):
            for region, (x1, y1, x2, y2) in rects:
                if x1 <= cx <= x2 and y1 <= cy <= y2:
                    target = region.get("key") or region.get("name")
                    match = MATCH_BOX
                    break

        if target is None:
            guess = by_label.get(_normalise_label(key))
            if guess:
                target, match = guess, MATCH_NAME

        if target:
            claimed.add(target)
        rows.append(
            {
                "field_name": key,
                "value": value,
                "target_field": target,
                "match": match,
                # Only a positional match is safe to apply without being read.
                "certain": match == MATCH_BOX,
                "confidence": float((payload or {}).get("confidence") or 0.0)
                if isinstance(payload, dict)
                else 0.0,
            }
        )

    # Boxes that were drawn but nothing landed in. Either the document differs
    # from the reference, or the value simply is not on this page — both are
    # things the person reviewing needs to see.
    for region in statics:
        key = region.get("key") or region.get("name")
        if key not in claimed:
            rows.append(
                {
                    "field_name": key,
                    "value": "",
                    "target_field": key,
                    "match": MATCH_NONE,
                    "certain": False,
                    "confidence": 0.0,
                    "empty_region": True,
                }
            )

    # Certain first, then guesses, then the unclaimed: the review panel is read
    # top down and the rows needing attention should not be buried.
    order = {MATCH_BOX: 0, MATCH_NAME: 1, MATCH_NONE: 2}
    rows.sort(key=lambda r: (order.get(r["match"], 3), r["field_name"]))
    return rows
