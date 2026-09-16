import frappe
from frappe.utils import flt

def guard_status_change(doc, method):
    if doc.is_new():
        return
    old_status = doc.get_doc_before_save().status if doc.get_doc_before_save() else None
    if old_status != "Confirmed" and doc.status == "Confirmed":
        if not frappe.flags.in_confirm_hook:
            frappe.throw("Status can only move to Confirmed automatically once payment is completed.")



def check_appointment_paid(doc, method):
	print("1111111111111111111111199999999999999999999999999999999999999999999999999999999999999999999")
	"""Runs on Payment Entry / Sales Invoice submit."""
	appointment = get_linked_appointment(doc)
	print(appointment)
	if not appointment:
		return

	print("1111111111111111111111")

	if is_fully_paid(appointment):
		print("22222222222222222222222")
		frappe.db.set_value(
			"Patient Appointment", appointment, "status", "Confirmed"
		)
		if frappe.db.get_single_value("Cura advanced settings", "enable_waiting_room"):
			create_waiting_room_entry(appointment)
		frappe.publish_realtime(
			"waiting_room_update", {"appointment": appointment}, after_commit=True
		)


def get_linked_appointment(doc):
    if doc.doctype == "Payment Entry":
        for ref in doc.references:
            if ref.reference_doctype == "Sales Order":
                return frappe.db.get_value(
                    "Sales Order", ref.reference_name, "custom_patient_appointment"
                )
    return None


def is_fully_paid(appointment):
    order = frappe.db.get_value(
        "Sales Order",
        {"custom_patient_appointment": appointment, "docstatus": 1},
        ["grand_total", "rounded_total", "advance_paid"],
        as_dict=True,
    )
    if not order:
        return False

    total = flt(order.rounded_total) or flt(order.grand_total)
    outstanding = total - flt(order.advance_paid)
    return outstanding <= 0

def create_waiting_room_entry(appointment):
    if frappe.db.exists("Waiting Room Entry", {"appointment": appointment, "status": ["!=", "Cancelled"]}):
        return  # avoid duplicates on repeated triggers
    appt = frappe.get_doc("Patient Appointment", appointment)
    entry = frappe.get_doc({
        "doctype": "Waiting Room Entry",
        "patient": appt.patient,
        "patient_name": appt.patient_name,
        "appointment": appt.name,
        "practitioner": appt.practitioner,
        "department": appt.department,
        "service_unit": appt.service_unit,
    }).insert(ignore_permissions=True)
    frappe.db.set_value("Patient Appointment", appointment, "custom_waiting_room_entry", entry.name)


def close_appointment_and_waiting_entry(doc, method):
    """Runs on Patient Encounter / Clinical Procedure submit."""
    appointment = doc.get("appointment")
    if not appointment:
        return
    entry = frappe.db.get_value(
        "Waiting Room Entry", {"appointment": appointment, "status": ["not in", ["Completed", "Cancelled"]]}
    )
    if entry:
        frappe.db.set_value("Waiting Room Entry", entry, {
            "status": "Completed",
            "consultation_ended_on": frappe.utils.now_datetime(),
        })
        frappe.publish_realtime("waiting_room_update", {"appointment": appointment}, after_commit=True)
