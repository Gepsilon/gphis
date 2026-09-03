# Copyright (c) 2026, Cura and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class OCRColumnMapping(Document):
	"""One extracted table column bound to a field on the target child table.

	Separate from OCR Field Mapping because the two answer different questions:
	a field mapping says "this value goes in that box", a column mapping says
	"this column becomes this field on every line item".
	"""

	pass
