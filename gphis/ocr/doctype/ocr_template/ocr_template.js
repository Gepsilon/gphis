frappe.ui.form.on("OCR Template", {
	refresh(frm) {
		if (frm.is_new()) return;

		if (frm.doc.is_builtin) {
			// Vendor content: edited upstream, imported here. Making that
			// obvious avoids someone drawing over it and losing the work on
			// the next pull.
			frm.set_read_only();
			frm.dashboard.add_comment(
				__("Built-in template shipped by the OCR platform. Use it in an OCR Profile; edit it upstream."),
				"blue",
				true
			);
			frm.dashboard.add_indicator(
				__("{0} · {1}", [frm.doc.alignment || "reference", frm.doc.side || "single"]),
				"blue"
			);
			return;
		}

		frm.add_custom_button(__("Open Annotator"), () => {
			if (!frm.doc.reference_image) {
				frappe.msgprint(__("Attach a reference image first."));
				return;
			}
			frappe.set_route("ocr-annotator").then(() => {
				// Route args survive the navigation; the annotator reads them.
				window.location.href = `/app/ocr-annotator?template=${encodeURIComponent(frm.doc.name)}`;
			});
		}).addClass("btn-primary");

		frm.add_custom_button(__("Sync to Platform"), () => {
			frappe.call({
				method: "gphis.ocr.api.sync_template",
				args: { template: frm.doc.name },
				freeze: true,
				freeze_message: __("Sending template to the OCR platform..."),
				callback: (r) => {
					if (r.message) {
						frappe.show_alert({ message: r.message.message, indicator: "green" });
						frm.reload_doc();
					}
				},
			});
		});

		if (frm.doc.platform_template_id) {
			frm.dashboard.add_indicator(
				__("Synced as #{0} v{1}", [frm.doc.platform_template_id, frm.doc.version]),
				"green"
			);
		} else {
			frm.dashboard.add_indicator(__("Not yet synced to the platform"), "orange");
		}

		// A count is more useful at a glance than the raw JSON below it.
		try {
			const root = JSON.parse(frm.doc.regions || "{}");
			const subs = root.subregions || [];
			const tables = subs.filter((r) => r.type === "table");
			const columns = tables.reduce((n, t) => n + (t.columns || []).length, 0);
			if (subs.length) {
				frm.dashboard.add_indicator(
					__("{0} regions · {1} table(s) · {2} columns", [
						subs.length,
						tables.length,
						columns,
					]),
					"blue"
				);
			}
		} catch (e) {
			frm.dashboard.add_indicator(__("Regions JSON is invalid"), "red");
		}
	},
});
