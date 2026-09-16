import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime, today

class WaitingRoomEntry(Document):
    def before_insert(self):
        self.checked_in_on = now_datetime()
        self.status = "Waiting"
        self.token_no = self.get_next_token()

    def get_next_token(self):
        prefix_field = frappe.db.get_single_value(
            "Cura advanced settings", "waiting_room_token_prefix"
        ) or ""
        count = frappe.db.count(
            "Waiting Room Entry",
            {"creation": [">=", today()], "department": self.department},
        )
        return f"{prefix_field}{count + 1}"
