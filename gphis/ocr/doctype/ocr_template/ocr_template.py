import json

import frappe
from frappe import _
from frappe.model.document import Document


class OCRTemplate(Document):
    def validate(self):
        self.validate_json()
        self.set_reference_size()

    def validate_json(self):
        """Reject malformed region trees before they reach the platform.

        The platform validates too, but catching it here means the error
        arrives while the user is on the form rather than as a sync failure
        later.
        """
        for fieldname, default in (("regions", "{}"), ("checks", "[]")):
            raw = (self.get(fieldname) or "").strip()
            if not raw:
                self.set(fieldname, default)
                continue
            try:
                json.loads(raw)
            except json.JSONDecodeError as exc:
                frappe.throw(_("{0} is not valid JSON: {1}").format(_(fieldname.title()), exc))

    def set_reference_size(self):
        """Record the reference image's pixel size.

        Region coordinates only mean anything relative to the image they were
        drawn on, so the size is stored alongside them.
        """
        if not self.reference_image:
            return
        if self.reference_width and self.reference_height:
            return

        try:
            from io import BytesIO

            from PIL import Image

            file_doc = frappe.get_doc("File", {"file_url": self.reference_image})
            with Image.open(BytesIO(file_doc.get_content())) as image:
                self.reference_width, self.reference_height = image.size
        except Exception as exc:  # noqa: BLE001
            frappe.log_error(f"Could not read reference image size: {exc}", "OCR Template")

    def as_platform_payload(self) -> dict:
        """Shape this record the way the platform's template API expects."""
        regions = json.loads(self.regions or "{}")
        if not regions:
            frappe.throw(_("Draw at least one region before syncing."))

        return {
            "name": self.template_name,
            "document_type": self.document_type,
            "version": self.version or 1,
            "reference_size": [self.reference_width, self.reference_height],
            "checks": json.loads(self.checks or "[]"),
            "root": regions,
        }
