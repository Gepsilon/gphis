from frappe.model.document import Document


class OCRDocumentType(Document):
    def before_save(self):
        if not self.title:
            self.title = self.document_type.replace("_", " ").title()
