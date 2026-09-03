frappe.ui.form.on("OCR Settings", {
	refresh(frm) {
		frm.add_custom_button(__("Test Connection"), () => {
			frappe.call({
				method: "gphis.ocr.api.test_connection",
				freeze: true,
				freeze_message: __("Contacting the OCR platform..."),
				callback: (r) => {
					if (!r.message) return;
					frappe.show_alert({
						message: __("{0} — plan {1}, {2} credits left", [
							r.message.status,
							r.message.plan,
							r.message.credits_remaining,
						]),
						indicator: "green",
					});
					frm.reload_doc();
				},
			});
		});

		frm.add_custom_button(__("Refresh Quota"), () => {
			frappe.call({
				method: "gphis.ocr.api.get_quota",
				freeze: true,
				callback: () => frm.reload_doc(),
			});
		});

		frm.add_custom_button(__("Pull Templates"), () => {
			frappe.call({
				method: "gphis.ocr.api.pull_templates",
				freeze: true,
				freeze_message: __("Importing templates from the platform..."),
				callback: (r) => {
					if (r.message) frappe.msgprint(r.message.message);
				},
			});
		}).addClass("btn-primary");

		frm.add_custom_button(__("Sync Document Types"), () => {
			frappe.call({
				method: "gphis.ocr.api.sync_document_types",
				freeze: true,
				callback: (r) => {
					if (r.message) frappe.msgprint(r.message.message);
				},
			});
		});

		if (frm.doc.credits_included) {
			const used = frm.doc.credits_included - (frm.doc.credits_remaining || 0);
			const pct = Math.min(100, Math.round((used / frm.doc.credits_included) * 100));
			// Red before the customer is surprised by a 402, not after.
			const colour = pct >= 90 ? "red" : pct >= 70 ? "orange" : "green";
			frm.dashboard.add_indicator(
				__("{0} of {1} credits used ({2}%)", [used, frm.doc.credits_included, pct]),
				colour
			);
		}
	},
});
