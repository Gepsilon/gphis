import frappe
from frappe import _
from frappe.model.document import Document


class OCRSettings(Document):
    def validate(self):
        if self.base_url:
            self.base_url = self.base_url.strip().rstrip("/")

        if self.enabled and not self.base_url:
            frappe.throw(_("Base URL is required when OCR is enabled."))

        if self.retention_days and self.retention_days < 0:
            frappe.throw(_("Retention days cannot be negative. Use 0 to keep scans forever."))

        if self.default_min_confidence and not 0 <= self.default_min_confidence <= 1:
            frappe.throw(_("Minimum confidence must be between 0 and 1."))
