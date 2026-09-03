"""Scheduled maintenance for OCR data."""

import frappe
from frappe.utils import add_days, now_datetime


def purge_expired_scans() -> int:
    """Delete OCR Scan records past the retention window.

    Scanned identity documents are personal data. Keeping them indefinitely by
    default would be a liability, so retention is enforced rather than merely
    documented. `retention_days = 0` opts out explicitly.
    """
    settings = frappe.get_cached_doc("OCR Settings")
    retention_days = int(settings.retention_days or 0)

    if retention_days <= 0:
        return 0

    cutoff = add_days(now_datetime(), -retention_days)
    expired = frappe.get_all(
        "OCR Scan", filters={"creation": ["<", cutoff]}, pluck="name"
    )

    for name in expired:
        # delete_doc removes attached files along with the record, which is the
        # point — purging the row but leaving the image on disk would defeat it.
        frappe.delete_doc("OCR Scan", name, force=True, delete_permanently=True)

    if expired:
        frappe.db.commit()
        frappe.logger().info(f"Purged {len(expired)} OCR Scan record(s) older than {cutoff}")

    return len(expired)
