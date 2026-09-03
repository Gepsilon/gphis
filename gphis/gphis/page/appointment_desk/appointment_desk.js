frappe.pages['appointment-desk'].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Appointment Desk',
		single_column: true,
	});

	// Frappe's page toolbar still gives us a natural home for a
	// "switch to classic list view" escape hatch during rollout.
	page.set_secondary_action(__('Classic view'), () => {
		frappe.set_route('List', 'Patient Appointment');
	});

	const mountPoint = $('<div id="appointment-desk-root"></div>').appendTo(page.body);
	mountPoint.css({ margin: '-15px' }); // cancel Desk's default page padding, component manages its own

	frappe.require('appointment_desk.bundle.js').then(() => {
		wrapper.appointment_desk_app = new appointment_desk.AppointmentDeskApp(mountPoint.get(0));
	});
};

frappe.pages['appointment-desk'].on_page_show = function (wrapper) {
	// refetch today's data whenever the user navigates back to this page
	if (wrapper.appointment_desk_app) {
		wrapper.appointment_desk_app.refresh();
	}
};
