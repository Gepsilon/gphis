import frappe
from frappe import _
from frappe.utils import flt, getdate
from frappe.model.mapper import get_mapped_doc

from healthcare.healthcare.doctype.fee_validity.fee_validity import (
	check_fee_validity, get_fee_validity,
)
from healthcare.healthcare.doctype.patient_appointment.patient_appointment import (
	update_fee_validity,
)
from healthcare.healthcare.utils import get_appointment_billing_item_and_rate


@frappe.whitelist()
def invoice_appointment(appointment_name, discount_percentage=0, discount_amount=0):
	"""Replaces core invoice_appointment: creates a Sales Order instead of a Sales Invoice."""
	appointment_doc = frappe.get_doc("Patient Appointment", appointment_name)
	settings = frappe.get_single("Healthcare Settings")

	if settings.enable_free_follow_ups:
		fee_validity = check_fee_validity(appointment_doc)
		if fee_validity and fee_validity.status != "Active":
			fee_validity = None
		elif not fee_validity:
			if get_fee_validity(appointment_doc.name, appointment_doc.appointment_date):
				return
	else:
		fee_validity = None

	if settings.show_payment_popup and not appointment_doc.invoiced and not fee_validity:
		create_sales_order(appointment_doc, discount_percentage, discount_amount)

	update_fee_validity(appointment_doc)


def create_sales_order(appointment_doc, discount_percentage=0, discount_amount=0):
	details = get_appointment_billing_item_and_rate(appointment_doc)
	charge = appointment_doc.paid_amount or details.get("practitioner_charge")

	so = frappe.new_doc("Sales Order")
	so.customer = frappe.get_value("Patient", appointment_doc.patient, "customer")
	so.company = appointment_doc.company
	so.transaction_date = getdate()
	so.delivery_date = appointment_doc.appointment_date
	so.custom_patient_appointment_ = appointment_doc.name

	item = so.append("items", {})
	item.item_code = details.get("service_item")
	item.description = _("Consulting Charges: {0}").format(appointment_doc.practitioner)
	item.qty = 1
	item.rate = charge
	item.delivery_date = appointment_doc.appointment_date

	paid_amount = charge
	if flt(discount_percentage):
		so.additional_discount_percentage = flt(discount_percentage)
		paid_amount = charge - (charge * flt(discount_percentage) / 100)
	if flt(discount_amount):
		so.discount_amount = flt(discount_amount)
		paid_amount = charge - flt(discount_amount)

	so.set_missing_values(for_validate=True)
	so.flags.ignore_mandatory = True
	so.save(ignore_permissions=True)
	so.submit()

	frappe.db.set_value(
		"Patient Appointment",
		appointment_doc.name,
		{
			"invoiced": 1,                      # keep core semantics: "billing doc exists"
			"custom_reference_sales_order": so.name,
			"custom_payment_status": "Unpaid",
			"paid_amount": paid_amount,
		},
	)
	appointment_doc.notify_update()
	frappe.msgprint(_("Sales Order {0} created").format(so.name), alert=True)

	# If mode_of_payment/amount were already collected in the payment popup,
	# take payment immediately — same UX as the original POS-style invoice flow.
	if appointment_doc.mode_of_payment and paid_amount:
		create_and_submit_payment_entry(
			appointment_doc.name, so.name, appointment_doc.mode_of_payment, paid_amount
		)

	return so


def create_and_submit_payment_entry(appointment_name, sales_order, mode_of_payment, amount):
	from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry

	pe = get_payment_entry("Sales Order", sales_order)
	print(mode_of_payment)
	pe.mode_of_payment = mode_of_payment
	pe.paid_amount = flt(amount)
	pe.received_amount = flt(amount)
	pe.reference_no = f"{mode_of_payment}-{appointment_name}"
	pe.reference_date = getdate()

	for ref in pe.references:
		ref.allocated_amount = flt(amount)

	pe.insert(ignore_permissions=True)
	pe.save()

	frappe.db.set_value(
		"Patient Appointment",
		appointment_name,
		{
			"custom_payment_status": "Paid",
			"custom_reference_payment_entry": pe.name,
			"status": "Open",   # your "approved" state
		},
	)
	frappe.msgprint(_("Payment Entry {0} created").format(pe.name), alert=True)
	return pe


@frappe.whitelist()
def collect_payment_for_appointment(appointment_name, mode_of_payment, amount=None):
	"""For deferred payment: SO already exists, patient pays later at a separate counter."""
	appointment_doc = frappe.get_doc("Patient Appointment", appointment_name)
	if not appointment_doc.custom_reference_sales_order:
		frappe.throw(_("No Sales Order linked to this appointment yet."))
	if appointment_doc.custom_payment_status == "Paid":
		frappe.throw(_("This appointment is already paid."))

	amount = flt(amount) or appointment_doc.paid_amount
	return create_and_submit_payment_entry(
		appointment_doc.name, appointment_doc.custom_reference_sales_order, mode_of_payment, amount
	)


@frappe.whitelist()
def update_status(appointment_id, status):
	"""Overrides core update_status so cancellation reverses SO + Payment Entry, not Sales Invoice."""
	frappe.db.set_value("Patient Appointment", appointment_id, "status", status)
	appointment_booked = True

	if status == "Cancelled":
		appointment_booked = False
		_cancel_appointment(appointment_id)

	procedure_prescription = frappe.db.get_value(
		"Patient Appointment", appointment_id, "procedure_prescription"
	)
	if procedure_prescription:
		frappe.db.set_value(
			"Procedure Prescription", procedure_prescription, "appointment_booked", appointment_booked
		)


def _cancel_appointment(appointment_id):
	appointment = frappe.get_doc("Patient Appointment", appointment_id)

	if appointment.service_request:
		frappe.db.set_value(
			"Service Request", appointment.service_request, "status", "active-Request Status"
		)

	msg = _("Appointment Cancelled.")
	if appointment.invoiced and appointment.custom_reference_sales_order:
		if appointment.custom_reference_payment_entry:
			pe = frappe.get_doc("Payment Entry", appointment.custom_reference_payment_entry)
			if pe.docstatus == 1:
				pe.cancel()
		so = frappe.get_doc("Sales Order", appointment.custom_reference_sales_order)
		if so.docstatus == 1:
			so.cancel()
		msg = _("Appointment, Payment Entry and Sales Order cancelled")

	if appointment.event:
		event_doc = frappe.get_doc("Event", appointment.event)
		event_doc.status = "Cancelled"
		event_doc.save(ignore_permissions=True)

	frappe.msgprint(msg)


@frappe.whitelist()
def make_encounter(source_name, target_doc=None):
	"""Overrides core make_encounter: gate check-in on payment status."""
	payment_status = frappe.db.get_value("Patient Appointment", source_name, "custom_payment_status")
	if payment_status != "Paid":
		frappe.throw(_("Payment must be completed before check-in."))

	doc = get_mapped_doc(
		"Patient Appointment",
		source_name,
		{
			"Patient Appointment": {
				"doctype": "Patient Encounter",
				"field_map": [
					["appointment", "name"],
					["patient", "patient"],
					["practitioner", "practitioner"],
					["medical_department", "department"],
					["patient_sex", "patient_sex"],
					["invoiced", "invoiced"],
					["company", "company"],
					["appointment_type", "appointment_type"],
					["insurance_policy", "insurance_policy"],
					["insurance_coverage", "insurance_coverage"],
				],
			}
		},
		target_doc,
	)
	return doc
