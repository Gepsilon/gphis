frappe.provide("frappe.ui.form");

class CustomPatientQuickEntryForm extends frappe.ui.form.PatientQuickEntryForm {
	get_standard_fields() {
		console.log("override running");
		let fields = super.get_standard_fields();
		console.log("override running");

		let first_idx = fields.findIndex(f => f.fieldname === "first_name");
		let last_idx = fields.findIndex(f => f.fieldname === "last_name");

		// swap positions so Last Name renders before First Name
		[fields[first_idx], fields[last_idx]] = [fields[last_idx], fields[first_idx]];

		return fields;
	}
};

frappe.ui.form.PatientQuickEntryForm = CustomPatientQuickEntryForm;
