"""Whitelisted endpoints called from the Desk UI.

Everything the browser needs goes through here, which is what keeps the OCR API
key server-side. The browser only ever talks to Frappe.
"""

import json

import frappe
from frappe import _
from frappe.utils import now_datetime

from gphis.ocr import client
from gphis.ocr.mapping import (
    match_extracted_fields,
    apply_transform,
    build_field_rows,
    build_table_rows,
    missing_required,
)


@frappe.whitelist()
def test_connection() -> dict:
    """Check reachability first, then credentials.

    Two steps on purpose: "the box is down" and "your key is wrong" are
    different problems with different fixes, and one message for both wastes
    the administrator's time.
    """
    settings = frappe.get_doc("OCR Settings")

    health = client.ping()
    account = client.get_account()
    subscription = account["subscription"]

    settings.connection_status = _("Connected to {0} v{1}").format(
        health.get("service", "OCR Platform"), health.get("version", "?")
    )
    settings.last_tested_on = now_datetime()
    settings.plan_name = subscription["plan"]["name"]
    settings.credits_included = subscription["credits_included"]
    settings.credits_remaining = subscription["credits_remaining"]
    settings.period_end = subscription["period_end"]
    settings.save(ignore_permissions=False)
    frappe.db.commit()

    return {
        "status": settings.connection_status,
        "plan": settings.plan_name,
        "credits_remaining": settings.credits_remaining,
    }


@frappe.whitelist()
def get_quota() -> dict:
    """Refresh and return the credit balance."""
    account = client.get_account()
    subscription = account["subscription"]

    settings = frappe.get_doc("OCR Settings")
    settings.plan_name = subscription["plan"]["name"]
    settings.credits_included = subscription["credits_included"]
    settings.credits_remaining = subscription["credits_remaining"]
    settings.period_end = subscription["period_end"]
    settings.save(ignore_permissions=False)
    frappe.db.commit()

    return {
        "plan": subscription["plan"]["name"],
        "credits_included": subscription["credits_included"],
        "credits_remaining": subscription["credits_remaining"],
        "credits_used": subscription["credits_used"],
        "period_end": subscription["period_end"],
    }


@frappe.whitelist()
def get_usage() -> dict:
    """Usage breakdown for the current billing period."""
    return client.get_usage()


@frappe.whitelist()
def sync_document_types() -> dict:
    """Pull available document types from the platform.

    The platform's document registry is P2-2 and does not exist yet, so this
    degrades cleanly: if the endpoint is missing, existing local records are
    left alone and the caller is told to create them manually.
    """
    try:
        payload = client._request("GET", "/v1/documents/types", client.META_TIMEOUT)
    except Exception:
        return {
            "synced": 0,
            "message": _(
                "The platform does not expose document types yet. "
                "Create OCR Document Type records manually for now."
            ),
        }

    synced = 0
    for item in payload.get("document_types", []):
        code = item.get("document_type")
        if not code:
            continue

        doc = (
            frappe.get_doc("OCR Document Type", code)
            if frappe.db.exists("OCR Document Type", code)
            else frappe.new_doc("OCR Document Type")
        )
        doc.document_type = code
        doc.title = item.get("title") or code
        doc.description = item.get("description")
        doc.available_fields = json.dumps(item.get("fields", []), indent=2)
        doc.synced_on = now_datetime()
        doc.save(ignore_permissions=True)
        synced += 1

    frappe.db.commit()
    return {"synced": synced, "message": _("Synced {0} document type(s).").format(synced)}


def _resolve_options(profile) -> tuple[str, str, float]:
    """Profile settings win; blanks fall back to OCR Settings."""
    settings = client.get_settings()
    mode = profile.mode or settings.default_mode or "balanced"
    lang = profile.lang or settings.default_lang or "en"
    min_confidence = profile.min_confidence or settings.default_min_confidence or 0.0
    return mode, lang, float(min_confidence)


# Two paths, because there are two kinds of document here and they want
# different things.
#
#   Vision Model — every invoice. The VLM reads the table and the key/value
#                  blocks around it in one pass. A template, when one exists,
#                  supplies the box-to-fieldname bindings; without one the
#                  user maps the columns at review time and it is remembered.
#   Plain OCR    — ID cards, where a patient record is created from fixed
#                  positions on an aligned card. No VLM: it would be slower
#                  and would add nothing to a document with no table.
#
# The geometric and ladder tiers were measured over 563 invoices and dropped
# from this app; see IMPROVEMENTS.md. They remain on the platform, which is
# ERP-neutral and has other callers.
STRATEGY_BY_LABEL = {
    "Vision Model": "vl",
    "Plain OCR": None,
}


def _resolve_strategy(profile) -> str | None:
    """The platform strategy for this profile, or None for the plain OCR path.

    An unset or unrecognised value means plain OCR — the behaviour every
    profile had before strategies existed. Defaulting the other way would
    silently start sending ID cards to the VLM.
    """
    return STRATEGY_BY_LABEL.get((getattr(profile, "strategy", "") or "").strip())


@frappe.whitelist()
def scan(profile: str, file_url: str) -> dict:
    """Run OCR on an attached file and record the result.

    Returns the extracted fields for review. Nothing is written to the target
    document here — the user reviews first, then applies.
    """
    profile_doc = frappe.get_doc("OCR Profile", profile)
    if not profile_doc.enabled:
        frappe.throw(_("Profile {0} is disabled.").format(profile))

    file_doc = frappe.get_doc("File", {"file_url": file_url})
    file_doc.check_permission("read")

    mode, lang, min_confidence = _resolve_options(profile_doc)
    strategy = _resolve_strategy(profile_doc)
    settings = client.get_settings()

    # A template is now two separable things: an extractor, and a set of
    # bindings from places on the page to fieldnames. A profile that names a
    # strategy uses the second without the first — the vision model reads the
    # document, and the drawn boxes say which field each value belongs to.
    platform_template_id = (
        frappe.db.get_value("OCR Template", profile_doc.template, "platform_template_id")
        if profile_doc.template
        else None
    )
    # Only the template *tier* needs the platform to hold a copy. Matching
    # against the boxes is done here, so an unsynced template must not block a
    # scan that never asks the platform about it.
    use_template = platform_template_id if not strategy else None
    if profile_doc.template and not strategy and not platform_template_id:
        frappe.throw(
            _("Template {0} has not been synced to the platform yet.").format(
                profile_doc.template
            )
        )

    scan_doc = frappe.new_doc("OCR Scan")
    scan_doc.profile = profile_doc.name
    scan_doc.status = "Pending"
    scan_doc.mode = mode
    scan_doc.scanned_by = frappe.session.user
    scan_doc.scanned_on = now_datetime()
    if settings.store_scan_images:
        scan_doc.scan_image = file_url
    scan_doc.insert(ignore_permissions=True)

    try:
        if use_template:
            result = client.extract_with_template(
                int(use_template),
                file_doc.get_content(),
                file_doc.file_name or "upload.jpg",
                mode,
            )
        elif strategy:
            # The ladder, which is what makes line items available without a
            # drawn template: the vision model returns the table *and* the
            # key/value blocks printed around it in one pass, so an invoice
            # from a supplier nobody has annotated still arrives mapped.
            result = client.analyze(
                file_doc.get_content(),
                filename=file_doc.file_name or "upload.jpg",
                strategy=strategy,
                mode=mode,
                template_id=platform_template_id,
                lang=lang,
            )
        else:
            result = client.run_ocr(
                file_doc.get_content(),
                filename=file_doc.file_name or "upload.jpg",
                lang=lang,
                mode=mode,
                min_confidence=min_confidence,
            )
    except client.OCRQuotaExceeded as exc:
        _fail_scan(scan_doc, "Quota Exceeded", str(exc))
        raise
    except Exception as exc:
        _fail_scan(scan_doc, "Failed", str(exc))
        raise

    rows = build_field_rows(result, profile_doc)
    line_items = build_table_rows(result, profile_doc)
    matched = _match_against_template(result, profile_doc)
    column_choices = _column_choices(result, profile_doc, line_items)

    scan_doc.status = "Completed"
    scan_doc.request_id = result.get("request_id")
    scan_doc.credits_charged = (result.get("usage") or {}).get("credits_charged") or 0
    scan_doc.duration_ms = int(result.get("duration_ms") or 0)
    scan_doc.raw_text = result.get("text") or _summarise_tables(result)
    scan_doc.raw_response = json.dumps(result, indent=2)
    for row in rows:
        # Only the child table's own fields; `rows` also carries mapping
        # metadata that the review panel needs but the record does not.
        scan_doc.append(
            "extracted_fields",
            {
                "field_name": row["field_name"],
                "value": row["value"],
                "confidence": row["confidence"],
            },
        )
    scan_doc.save(ignore_permissions=True)
    frappe.db.commit()

    return {
        "scan": scan_doc.name,
        "status": scan_doc.status,
        "source": "template" if use_template else (strategy or "ocr"),
        "fields": rows,
        # Mapped line items, ready to append to the target's child table.
        "line_items": line_items,
        # Extracted values classified against the template's annotated boxes:
        # certain, guessed, or unclaimed.
        "matched": matched,
        # Offered when the table was not annotated, so the columns can be
        # mapped against what actually came back.
        "column_choices": column_choices,
        "raw_text": result.get("text"),
        "target_doctype": profile_doc.target_doctype,
        "on_apply": profile_doc.on_apply,
        "missing_required": missing_required(rows),
        # Present only on the template path; the widget shows it when it is.
        "validation": result.get("validation"),
        "tables": result.get("tables") or [],
        "pages": result.get("pages"),
        "credits_remaining": (result.get("usage") or {}).get("credits_remaining"),
        "credits_charged": scan_doc.credits_charged,
    }


def _summarise_tables(result: dict) -> str:
    """A readable rendering of extracted tables, for the Scan record.

    The template path returns rows rather than a text blob, so `raw_text`
    would otherwise be empty on exactly the scans worth reviewing.
    """
    lines = []
    for table in result.get("tables") or []:
        columns = table.get("columns") or []
        lines.append(" | ".join(columns))
        for row in table.get("rows") or []:
            lines.append(" | ".join(str(row.get(c, "")) for c in columns))
        lines.append("")
    return "\n".join(lines).strip()


def _fail_scan(scan_doc, status: str, message: str) -> None:
    """Record the failure before the exception propagates.

    A failed scan that leaves no trace is a support ticket with no evidence.
    """
    scan_doc.status = status
    scan_doc.error_message = message
    scan_doc.save(ignore_permissions=True)
    frappe.db.commit()


@frappe.whitelist()
def mark_applied(scan: str, applied_fields: str, target_doctype: str = None, target_name: str = None):
    """Record which fields the user actually accepted.

    Worth storing: the gap between what OCR proposed and what a human kept is
    the only honest measure of extraction quality on real documents.
    """
    accepted = set(frappe.parse_json(applied_fields) or [])

    scan_doc = frappe.get_doc("OCR Scan", scan)
    for row in scan_doc.extracted_fields:
        row.applied = 1 if row.field_name in accepted else 0

    if target_doctype and target_name:
        scan_doc.linked_doctype = target_doctype
        scan_doc.linked_document = target_name

    scan_doc.save(ignore_permissions=True)
    frappe.db.commit()
    return {"ok": True}


@frappe.whitelist()
def preview_transform(value: str, transform: str) -> dict:
    """Show what a transform does to a value. Used by the profile editor."""
    return {"result": apply_transform(value, transform)}


# --- templates ------------------------------------------------------------


@frappe.whitelist()
def list_templates() -> dict:
    """Templates available on the platform, for the scan widget's picker."""
    return client.list_templates()


@frappe.whitelist()
def pull_templates() -> dict:
    """Import templates the platform offers, so the Desk can use them.

    Sync was one-way until now: Frappe pushed what it drew, and never saw the
    templates the platform ships. That made the built-in identity-document
    templates invisible here even though they were ready to use.

    Built-ins arrive read-only — they are vendor content, edited upstream.
    """
    payload = client.list_templates()
    created = updated = 0

    for item in payload.get("templates", []):
        platform_id = item.get("id")
        if not platform_id:
            continue

        name = frappe.db.get_value("OCR Template", {"platform_template_id": platform_id})
        doc = (
            frappe.get_doc("OCR Template", name)
            if name
            else frappe.new_doc("OCR Template")
        )

        if not name:
            # Names must be unique; a built-in and a local draft can collide.
            base = item.get("name") or f"Template {platform_id}"
            candidate, suffix = base, 1
            while frappe.db.exists("OCR Template", candidate):
                suffix += 1
                candidate = f"{base} ({suffix})"
            doc.template_name = candidate
            created += 1
        else:
            updated += 1

        doc.platform_template_id = platform_id
        doc.document_type = item.get("document_type")
        doc.is_builtin = 1 if item.get("builtin") else 0
        doc.version = item.get("version") or 1
        doc.lang = item.get("lang") or "en"
        doc.alignment = item.get("alignment") or "reference"
        doc.side = item.get("side") or "single"
        size = item.get("reference_size") or [0, 0]
        doc.reference_width, doc.reference_height = size[0], size[1]
        doc.synced_on = now_datetime()
        doc.flags.ignore_mandatory = True
        doc.save(ignore_permissions=True)

    frappe.db.commit()
    return {
        "created": created,
        "updated": updated,
        "message": _("Imported {0} new and refreshed {1} existing template(s).").format(created, updated),
    }


@frappe.whitelist()
def sync_template(template: str) -> dict:
    """Push an OCR Template to the platform, creating or updating it.

    The platform is the system of record — it needs the reference image as
    pixels at alignment time — so Frappe holds the editable copy and pushes it.
    """
    doc = frappe.get_doc("OCR Template", template)
    doc.check_permission("write")

    payload = doc.as_platform_payload()

    if doc.platform_template_id:
        result = client.update_template(doc.platform_template_id, payload)
    else:
        file_doc = frappe.get_doc("File", {"file_url": doc.reference_image})
        result = client.create_template(
            payload, file_doc.get_content(), file_doc.file_name or "reference.png"
        )
        doc.platform_template_id = result.get("id")

    doc.version = result.get("version") or doc.version
    doc.synced_on = now_datetime()
    doc.save(ignore_permissions=True)
    frappe.db.commit()

    return {
        "platform_template_id": doc.platform_template_id,
        "version": doc.version,
        "message": _("Synced as template #{0} v{1}").format(doc.platform_template_id, doc.version),
    }


@frappe.whitelist()
def extract_with_template(file_url: str, template: str = None, template_id: int = None,
                          mode: str = "balanced") -> dict:
    """Template-driven extraction: named fields, table rows, validation.

    Returns the validation report alongside the data, so the review panel can
    show *why* a value is doubtful rather than only how confident OCR was.
    """
    if template and not template_id:
        template_id = frappe.db.get_value("OCR Template", template, "platform_template_id")
    if not template_id:
        frappe.throw(_("This template has not been synced to the platform yet."))

    file_doc = frappe.get_doc("File", {"file_url": file_url})
    file_doc.check_permission("read")

    result = client.extract_with_template(
        int(template_id), file_doc.get_content(), file_doc.file_name or "upload.jpg", mode
    )

    scan = frappe.new_doc("OCR Scan")
    scan.status = "Completed" if result.get("ok") else "Failed"
    scan.mode = mode
    scan.request_id = result.get("request_id")
    scan.document_type = result.get("document_type")
    scan.scanned_by = frappe.session.user
    scan.scanned_on = now_datetime()
    scan.scan_image = file_url if client.get_settings().store_scan_images else None
    scan.raw_response = json.dumps(result, indent=2)
    scan.credits_charged = (result.get("usage") or {}).get("credits_charged") or 0
    scan.duration_ms = int(result.get("duration_ms") or 0)
    if not result.get("ok"):
        scan.error_message = result.get("reason")

    for key, value in (result.get("fields") or {}).items():
        scan.append(
            "extracted_fields",
            {"field_name": key, "value": value.get("value"), "confidence": value.get("confidence")},
        )
    scan.insert(ignore_permissions=True)
    frappe.db.commit()

    result["scan"] = scan.name
    return result


# --- playground -----------------------------------------------------------
#
# Try a real document before committing a profile to it: what came back, how
# long it took, and whether the table reconciles against its own arithmetic.
#
# It compares the two paths this app actually uses. The geometric and ladder
# tiers were compared here too until a 563-invoice run settled the question
# (IMPROVEMENTS.md); keeping dead options in a chooser only invites someone to
# pick one.

PLAYGROUND_STRATEGIES = ("template", "vl")


def _playground_summary(result: dict) -> dict:
    """Flatten one analyze response into what the comparison table renders."""
    tables = result.get("tables") or []
    biggest = max(tables, key=lambda t: len(t.get("grid") or []), default=None)
    grid = (biggest or {}).get("grid") or []

    return {
        "ok": bool(result.get("ok")),
        # Reported separately from `ok` on purpose: a best-effort result is
        # returned when nothing reconciles, and showing that as a green tick is
        # how a wrong total reaches an invoice.
        "verified": bool(result.get("verified")),
        "tier": result.get("tier") or "",
        "rows": max((len(t.get("grid") or []) - 1 for t in tables), default=0),
        "cols": len(grid[0]) if grid else 0,
        "duration_ms": result.get("duration_ms") or 0,
        "attempts": result.get("attempts") or [],
        "fields": result.get("fields") or {},
        "grid": grid,
        "credits": (result.get("credits") or {}).get("charged") or 0,
        "reason": result.get("reason") or "",
    }


@frappe.whitelist()
def playground_run(file_url: str, strategy: str = "auto", mode: str = "balanced",
                   template: str = None, lang: str = None) -> dict:
    """Run one strategy against an attached file and return the full detail."""
    if strategy not in PLAYGROUND_STRATEGIES + ("auto",):
        frappe.throw(_("Unknown strategy {0}.").format(strategy))

    file_doc = frappe.get_doc("File", {"file_url": file_url})
    file_doc.check_permission("read")

    template_id = None
    if template:
        template_id = frappe.db.get_value("OCR Template", template, "platform_template_id")
        if not template_id and strategy == "template":
            frappe.throw(
                _("Template {0} has not been synced to the platform yet.").format(template)
            )

    result = client.analyze(
        file_doc.get_content(),
        file_doc.file_name or "upload.jpg",
        strategy=strategy,
        mode=mode,
        template_id=template_id,
        lang=lang,
    )
    result["summary"] = _playground_summary(result)
    return result


@frappe.whitelist()
def playground_compare(file_url: str, mode: str = "balanced", template: str = None,
                       lang: str = None) -> dict:
    """Run every strategy against the same file and return them side by side.

    Each strategy is charged, because each does the GPU work. That is the
    honest cost of finding out, and it is cheaper than deploying the wrong
    one across a supplier's whole document flow.

    A strategy that fails is reported, not raised: the comparison is only
    useful if one tier falling over still leaves the others visible.
    """
    strategies = list(PLAYGROUND_STRATEGIES)
    if not template:
        # Without a template the tier cannot run at all, and an empty column
        # labelled "template" reads as a failure rather than as not-applicable.
        strategies.remove("template")

    results = {}
    for strategy in strategies:
        try:
            results[strategy] = playground_run(
                file_url, strategy=strategy, mode=mode, template=template, lang=lang
            )["summary"]
        except Exception as exc:  # noqa: BLE001
            frappe.log_error(
                title=f"OCR playground: {strategy} failed",
                message=frappe.get_traceback(),
            )
            results[strategy] = {
                "ok": False,
                "verified": False,
                "error": str(exc)[:300],
                "tier": "",
                "rows": 0,
                "cols": 0,
                "duration_ms": 0,
                "attempts": [],
                "fields": {},
                "grid": [],
                "credits": 0,
            }

    verified = [name for name, r in results.items() if r.get("verified")]
    fastest = min(
        (r for r in results.values() if r.get("verified")),
        key=lambda r: r["duration_ms"],
        default=None,
    )

    return {
        "results": results,
        "verified": verified,
        # The recommendation is "cheapest thing that proved itself", never
        # "whichever returned the most rows" — rows are easy to invent.
        "recommended": next(
            (name for name, r in results.items() if r is fastest), ""
        ),
    }


@frappe.whitelist()
def playground_templates() -> list:
    """Synced templates, for the playground's template picker."""
    return frappe.get_all(
        "OCR Template",
        filters={"platform_template_id": ["is", "set"]},
        fields=["name", "template_name", "document_type", "platform_template_id"],
        order_by="modified desc",
    )


# --- annotator: binding boxes to real fields -------------------------------
#
# The annotator used to ask for a name and take whatever was typed, which made
# the template's output keys a matter of spelling. Offering the target
# DocType's own fields instead means a drawn box carries a real fieldname, so
# an extracted value either lands on a field or is visibly unclaimed — there is
# no third state where it lands on a field that does not exist.

# Fieldtypes that hold no value: layout furniture, or content the user cannot
# fill from a scanned document.
_NON_VALUE_FIELDTYPES = {
    "Section Break", "Column Break", "Tab Break", "HTML", "Heading",
    "Button", "Image", "Fold", "Barcode", "Signature",
}

# Frappe fieldtype -> the platform's validation types. Anything unlisted is
# read as text, which validates nothing rather than validating wrongly.
_FIELD_TYPE_BY_FIELDTYPE = {
    "Currency": "currency",
    "Float": "number",
    "Int": "number",
    "Percent": "number",
    "Date": "date",
    "Datetime": "date",
    "Barcode": "code",
}


def _visible_fields(meta) -> list[dict]:
    """User-visible, value-carrying fields of one DocType."""
    fields = []
    for df in meta.fields:
        if df.fieldtype in _NON_VALUE_FIELDTYPES or df.fieldtype == "Table":
            continue
        # `hidden` is the explicit intent; a read-only field is still shown to
        # the user, but nothing scanned should be written into one.
        if df.hidden or df.read_only:
            continue
        fields.append(
            {
                "fieldname": df.fieldname,
                "label": df.label or df.fieldname,
                "fieldtype": df.fieldtype,
                "field_type": _FIELD_TYPE_BY_FIELDTYPE.get(df.fieldtype, "text"),
                "required": bool(df.reqd),
            }
        )
    return fields


@frappe.whitelist()
def get_doctype_layout(doctype: str) -> dict:
    """The draggable palette: a DocType's visible fields, plus its child tables.

    Child tables are returned whole rather than flattened, because a column
    belongs to a table region and dropping `qty` outside one would have no
    meaning — the row extent it measures against would not exist.
    """
    if not doctype:
        return {"doctype": None, "fields": [], "child_tables": []}

    frappe.has_permission(doctype, throw=True)
    meta = frappe.get_meta(doctype)

    child_tables = []
    for df in meta.fields:
        if df.fieldtype != "Table" or df.hidden or not df.options:
            continue
        child_tables.append(
            {
                "fieldname": df.fieldname,
                "label": df.label or df.fieldname,
                "child_doctype": df.options,
                "fields": _visible_fields(frappe.get_meta(df.options)),
            }
        )

    return {
        "doctype": doctype,
        # `Meta.get_label` takes a fieldname and labels that field, not the
        # DocType. The DocType's own display name is its name.
        "label": doctype,
        "fields": _visible_fields(meta),
        "child_tables": child_tables,
    }


def _template_regions(profile) -> dict | None:
    """The annotated boxes for this profile's template, sized to the reference.

    Returns None when there is no template, which is a normal state: a profile
    can rely entirely on the vision model and map at review time.
    """
    if not getattr(profile, "template", None):
        return None

    row = frappe.db.get_value(
        "OCR Template",
        profile.template,
        ["regions", "reference_width", "reference_height"],
        as_dict=True,
    )
    if not row or not row.regions:
        return None

    try:
        regions = json.loads(row.regions)
    except (TypeError, ValueError):
        frappe.log_error(
            title=f"OCR template {profile.template}: regions are not valid JSON",
            message=row.regions[:2000] if row.regions else "",
        )
        return None

    # The reference size travels with the boxes: without it the coordinates
    # cannot be scaled onto a scan rendered at a different size, and every
    # positional match would silently miss.
    regions["reference_width"] = row.reference_width
    regions["reference_height"] = row.reference_height
    return regions


def _match_against_template(result: dict, profile) -> list[dict]:
    regions = _template_regions(profile)
    if not regions:
        return []
    layout = (
        get_doctype_layout(profile.target_doctype) if profile.target_doctype else None
    )
    return match_extracted_fields(result, regions, layout)


def _column_choices(result: dict, profile, line_items: dict) -> dict | None:
    """What the review panel needs to map table columns by hand.

    Offered only when the columns are not already mapped — either the table
    was too unusual to annotate, or this is a supplier nobody has configured
    yet. Returning the child tables alongside the extracted columns is what
    lets that mapping happen against the real document instead of from memory.
    """
    if line_items.get("rows"):
        return None

    tables = result.get("tables") or []
    if not tables:
        return None

    table = max(tables, key=lambda t: len(t.get("rows") or []))
    columns = list(table.get("columns") or [])
    if not columns:
        return None

    layout = (
        get_doctype_layout(profile.target_doctype) if profile.target_doctype else None
    )
    return {
        "columns": columns,
        "sample": (table.get("rows") or [])[:3],
        "row_count": len(table.get("rows") or []),
        "child_tables": (layout or {}).get("child_tables") or [],
    }


@frappe.whitelist()
def save_column_mappings(profile: str, target_field: str, mappings: str) -> dict:
    """Remember a mapping made during review, so the next scan is automatic.

    Mapping the same supplier's columns at every scan would make the review
    panel a data-entry form. Saved once on the profile, it becomes what the
    user described: map it once, and the extractor does the rest.
    """
    doc = frappe.get_doc("OCR Profile", profile)
    doc.check_permission("write")

    rows = json.loads(mappings) if isinstance(mappings, str) else (mappings or [])
    doc.table_target_field = target_field
    doc.set("column_mappings", [])
    for row in rows:
        if not row.get("source_column") or not row.get("target_field"):
            continue
        doc.append(
            "column_mappings",
            {
                "source_column": row["source_column"],
                "target_field": row["target_field"],
                "transform": row.get("transform") or "None",
            },
        )
    doc.save(ignore_permissions=False)
    frappe.db.commit()
    return {"saved": len(doc.column_mappings), "target_field": target_field}
