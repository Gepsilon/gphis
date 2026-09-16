# gphis/healthcare/waiting_room.py
import frappe
from frappe.utils import today, now_datetime


def get_permission_query_conditions(user):
    return f"`tabWaiting Room Entry`.`checked_in_on` >= '{today()} 00:00:00'"


@frappe.whitelist()
def update_entry_status(entry, new_status):
    frappe.only_for("Reception")
    doc = frappe.get_doc("Waiting Room Entry", entry)
    doc.status = new_status
    if new_status == "Called":
        doc.called_on = now_datetime()
    if new_status == "In Consultation":
        doc.consultation_started_on = now_datetime()
    doc.save(ignore_permissions=True)
    frappe.publish_realtime("waiting_room_update", {"entry": entry}, after_commit=True)
    return doc.status


@frappe.whitelist(allow_guest=True)
def get_display_list():
    return frappe.get_list(
        "Waiting Room Entry",
        filters={"status": ["not in", ["Completed", "Cancelled"]]},
        fields=["token_no", "patient_name", "status", "department"],
        order_by="checked_in_on asc",
        ignore_permissions=True,
    )
