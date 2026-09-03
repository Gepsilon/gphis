import frappe
from frappe import _
from frappe.model.document import Document


class OCRProfile(Document):
    def validate(self):
        self.validate_target_fields()

        if self.min_confidence and not 0 <= self.min_confidence <= 1:
            frappe.throw(_("Minimum confidence must be between 0 and 1."))

    def validate_target_fields(self):
        """Reject mappings that point at fields the target DocType does not have.

        Caught here rather than at scan time: a typo in a fieldname would
        otherwise surface as data silently not being filled in, which is far
        harder to diagnose than a validation error while editing the profile.
        """
        if not self.target_doctype or not self.field_mappings:
            return

        meta = frappe.get_meta(self.target_doctype)
        for row in self.field_mappings:
            if not row.target_field:
                continue
            if not meta.get_field(row.target_field):
                frappe.throw(
                    _("Row {0}: {1} has no field named {2}.").format(
                        row.idx, frappe.bold(self.target_doctype), frappe.bold(row.target_field)
                    )
                )
