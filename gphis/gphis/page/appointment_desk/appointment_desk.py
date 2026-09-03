import frappe


def get_context(context):
	# Runs once when the page HTML is rendered (before any JS executes).
	# We just confirm the user has read access to Patient Appointment;
	# actual row-level permissions still apply on every frappe.call below.
	if not frappe.has_permission("Patient Appointment", "read"):
		frappe.throw(frappe._("Not permitted to access the appointment desk"), frappe.PermissionError)
