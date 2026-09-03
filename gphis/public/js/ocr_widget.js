/**
 * OCR scan widget.
 *
 * Renders a floating button on any DocType that has an enabled OCR Profile,
 * opens a capture/upload dialog, and shows a review panel before anything is
 * written to the form. Nothing is ever saved automatically — the user applies.
 *
 * Which DocTypes get the button comes from `frappe.boot.ocr`, populated by
 * gphis/ocr/boot.py, so no server call is needed to decide whether to render.
 */

frappe.provide("gphis.ocr");

const BUTTON_ID = "ocr-scan-fab";
// Below this the value is shown as questionable in the review panel. Matching
// the platform's own notion of "worth a second look".
const LOW_CONFIDENCE = 0.85;

gphis.ocr.Widget = class OCRWidget {
	constructor() {
		this.bind_route_change();
	}

	get config() {
		return (frappe.boot && frappe.boot.ocr) || { enabled: false, profiles: {} };
	}

	bind_route_change() {
		// Re-evaluate on every navigation: the button belongs to a DocType, not
		// to the page shell.
		$(document).on("form-refresh", () => this.sync());
		frappe.router.on("change", () => setTimeout(() => this.sync(), 300));
	}

	profiles_for_current_form() {
		const config = this.config;
		if (!config.enabled) return [];

		const route = frappe.get_route();
		if (!route || route[0] !== "Form") return [];

		return config.profiles[route[1]] || [];
	}

	sync() {
		const profiles = this.profiles_for_current_form();
		if (!profiles.length) {
			this.remove_button();
			return;
		}
		this.render_button(profiles);
	}

	remove_button() {
		$(`#${BUTTON_ID}`).remove();
	}

	render_button(profiles) {
		if ($(`#${BUTTON_ID}`).length) return;

		const side = this.config.position === "Bottom Left" ? "left: 24px;" : "right: 24px;";
		const $button = $(`
			<button id="${BUTTON_ID}" class="btn btn-primary"
				title="${__("Scan a document to fill this form")}"
				style="position: fixed; bottom: 24px; ${side} z-index: 1030;
				       border-radius: 999px; padding: 12px 20px;
				       box-shadow: 0 4px 14px rgba(0,0,0,.25);">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
					stroke="currentColor" stroke-width="2" style="vertical-align: -3px;">
					<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2
					         M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/>
					<line x1="3" y1="12" x2="21" y2="12"/>
				</svg>
				${__("Scan")}
			</button>
		`);

		$button.on("click", () => this.open_scan_dialog(profiles));
		$("body").append($button);
	}

	open_scan_dialog(profiles) {
		const fields = [];

		// Only ask which profile when there is a genuine choice.
		if (profiles.length > 1) {
			fields.push({
				fieldname: "profile",
				fieldtype: "Select",
				label: __("Profile"),
				options: profiles.map((p) => p.name),
				default: profiles[0].name,
				reqd: 1,
			});
		}

		fields.push({
			fieldname: "file",
			fieldtype: "Attach",
			label: __("Document Image"),
			reqd: 1,
			description: __("On a phone this opens the camera."),
		});

		const dialog = new frappe.ui.Dialog({
			title: __("Scan Document"),
			fields: fields,
			primary_action_label: __("Run OCR"),
			primary_action: (values) => {
				const profile = profiles.length > 1 ? values.profile : profiles[0].name;
				this.run_scan(dialog, profile, values.file);
			},
		});

		dialog.show();
	}

	run_scan(dialog, profile, file_url) {
		// Kept for the review panel: saving a column mapping writes it back to
		// the profile that produced the scan.
		this.profile_name = profile;
		dialog.set_primary_action(__("Scanning..."), null);
		dialog.disable_primary_action();

		frappe.call({
			method: "gphis.ocr.api.scan",
			args: { profile: profile, file_url: file_url },
			freeze: true,
			freeze_message: __("Reading the document..."),
			callback: (response) => {
				dialog.hide();
				if (response.message) this.show_review(response.message);
			},
			error: () => {
				// The server already surfaced a specific message (quota, key,
				// unreachable). Just restore the dialog so the user can retry.
				dialog.enable_primary_action();
				dialog.set_primary_action(__("Run OCR"), () =>
					this.run_scan(dialog, profile, file_url)
				);
			},
		});
	}

	show_review(result) {
		const mapped = result.fields.filter((f) => f.target_field);
		const unmapped = result.fields.filter((f) => !f.target_field);

		const dialog = new frappe.ui.Dialog({
			title: __("Review Extracted Data"),
			size: "large",
			fields: [
				{ fieldname: "summary", fieldtype: "HTML" },
				{ fieldname: "table", fieldtype: "HTML" },
			],
			primary_action_label: mapped.length ? __("Apply to Form") : __("Close"),
			primary_action: () => {
				if (mapped.length) this.apply(dialog, result);
				else dialog.hide();
			},
		});

		dialog.fields_dict.summary.$wrapper.html(
			this.render_validation(result) +
				this.render_summary(result, mapped.length, unmapped.length)
		);
		dialog.fields_dict.table.$wrapper.html(
			this.render_matches(result) +
				this.render_table(result.fields) +
				this.render_column_mapper(result) +
				this.render_tables(result)
		);
		dialog.show();
		this.bind_column_mapper(dialog, result);

		this.dialog = dialog;
	}

	render_matches(result) {
		const rows = result.matched || [];
		if (!rows.length) return "";

		// Three states, and the difference between them is the whole point of
		// annotating a template. A value read from inside the box someone drew
		// for `bill_no` is that field. A value whose printed label merely
		// resembles a field name is a guess — presenting the two identically
		// is how a guess gets applied without anyone deciding to.
		const badge = (row) => {
			if (row.certain)
				return `<span class="indicator-pill green">${__("matched by position")}</span>`;
			if (row.match === "name")
				return `<span class="indicator-pill orange">${__("guessed by name — check")}</span>`;
			if (row.empty_region)
				return `<span class="indicator-pill red">${__("box found nothing")}</span>`;
			return `<span class="indicator-pill gray">${__("unclaimed")}</span>`;
		};

		const body = rows
			.map(
				(row) => `<tr>
					<td>${frappe.utils.escape_html(row.field_name)}</td>
					<td>${frappe.utils.escape_html(String(row.value ?? ""))}</td>
					<td>${
						row.target_field
							? `<code>${frappe.utils.escape_html(row.target_field)}</code>`
							: `<span class="text-muted">—</span>`
					}</td>
					<td>${badge(row)}</td>
				</tr>`
			)
			.join("");

		const certain = rows.filter((r) => r.certain).length;
		const guesses = rows.filter((r) => r.match === "name").length;
		const open = rows.length - certain - guesses;

		return `<div style="margin-bottom:14px;">
			<h5 style="font-size:13px;">${__("Template match")}
				<span class="text-muted" style="font-weight:400">
					(${certain} ${__("certain")}, ${guesses} ${__("to check")}, ${open} ${__(
			"unclaimed"
		)})</span>
			</h5>
			<div style="overflow-x:auto;">
				<table class="table table-bordered" style="font-size:12px;margin:0;">
					<thead><tr>
						<th>${__("Extracted")}</th><th>${__("Value")}</th>
						<th>${__("Field")}</th><th>${__("How")}</th>
					</tr></thead>
					<tbody>${body}</tbody>
				</table>
			</div>
		</div>`;
	}

	render_column_mapper(result) {
		const choices = result.column_choices;
		if (!choices || !(choices.columns || []).length) return "";

		const tables = choices.child_tables || [];
		if (!tables.length) return "";

		const table_options = tables
			.map(
				(t) =>
					`<option value="${frappe.utils.escape_html(t.fieldname)}">${frappe.utils.escape_html(
						t.label
					)}</option>`
			)
			.join("");

		const rows = choices.columns
			.map(
				(column, index) => `<tr>
					<td><code>${frappe.utils.escape_html(column)}</code></td>
					<td class="text-muted small">${frappe.utils.escape_html(
						String((choices.sample || []).map((r) => r[column]).find((v) => v) || "")
					).slice(0, 40)}</td>
					<td><select class="form-control input-sm ocr-colmap"
						data-column="${frappe.utils.escape_html(column)}" data-index="${index}"></select></td>
				</tr>`
			)
			.join("");

		return `<div style="margin-bottom:14px;">
			<h5 style="font-size:13px;">${__("Line items — not yet mapped")}
				<span class="text-muted" style="font-weight:400">
					(${choices.row_count} ${__("rows found")})</span>
			</h5>
			<p class="text-muted small">
				${__(
					"This table was not annotated, so its columns need matching to a child table once. Saved on the profile, the next scan maps itself."
				)}
			</p>
			<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
				<label class="small" style="margin:0;">${__("Child table")}</label>
				<select class="form-control input-sm ocr-colmap-table" style="width:auto;">
					${table_options}
				</select>
				<button class="btn btn-xs btn-default ocr-colmap-save">${__("Save mapping")}</button>
			</div>
			<div style="overflow-x:auto;">
				<table class="table table-bordered" style="font-size:12px;margin:0;">
					<thead><tr>
						<th>${__("Extracted column")}</th><th>${__("Sample")}</th><th>${__("Maps to")}</th>
					</tr></thead>
					<tbody>${rows}</tbody>
				</table>
			</div>
		</div>`;
	}

	bind_column_mapper(dialog, result) {
		const choices = result.column_choices;
		if (!choices || !(choices.child_tables || []).length) return;

		const $wrapper = dialog.fields_dict.table.$wrapper;
		const fill_targets = () => {
			const fieldname = $wrapper.find(".ocr-colmap-table").val();
			const table = choices.child_tables.find((t) => t.fieldname === fieldname);
			const options = [`<option value="">${__("— ignore —")}</option>`].concat(
				(table ? table.fields : []).map(
					(f) =>
						`<option value="${frappe.utils.escape_html(f.fieldname)}">${frappe.utils.escape_html(
							f.label
						)}</option>`
				)
			);
			$wrapper.find(".ocr-colmap").html(options.join(""));
		};

		$wrapper.find(".ocr-colmap-table").on("change", fill_targets);
		fill_targets();

		$wrapper.find(".ocr-colmap-save").on("click", () => {
			const mappings = [];
			$wrapper.find(".ocr-colmap").each(function () {
				const target = $(this).val();
				if (target) {
					mappings.push({ source_column: $(this).data("column"), target_field: target });
				}
			});
			if (!mappings.length) {
				frappe.msgprint(__("Map at least one column first."));
				return;
			}
			frappe.call({
				method: "gphis.ocr.api.save_column_mappings",
				args: {
					profile: this.profile_name,
					target_field: $wrapper.find(".ocr-colmap-table").val(),
					mappings: JSON.stringify(mappings),
				},
				freeze: true,
				callback: () => {
					frappe.show_alert({
						message: __("Mapping saved. Scan again to fill the line items."),
						indicator: "green",
					});
				},
			});
		});
	}

	render_validation(result) {
		// Only the template path returns a validation report. Confidence says
		// how sure the engine was about pixels; validation says whether the
		// answer is consistent with the document's own arithmetic and types —
		// a far stronger signal, so it goes at the top.
		const v = result.validation;
		if (!v) return "";

		const errors = v.errors || [];
		const warnings = v.warnings || [];

		if (!errors.length && !warnings.length) {
			return `<div class="alert alert-success" style="padding:8px 12px;margin-bottom:8px;">
				✓ ${__("All checks passed")} — ${__(
					"values match their declared types and the document's own totals."
				)}
			</div>`;
		}

		const row = (i, colour) =>
			`<div style="margin:2px 0;"><span class="text-muted small">${frappe.utils.escape_html(
				i.location || ""
			)}</span> — <span style="color:${colour};">${frappe.utils.escape_html(
				i.message
			)}</span></div>`;

		let html = "";
		if (errors.length) {
			html += `<div class="alert alert-danger" style="padding:8px 12px;margin-bottom:8px;">
				<b>${__("{0} check(s) failed", [errors.length])}</b>
				${errors.slice(0, 6).map((i) => row(i, "#b02a2a")).join("")}
			</div>`;
		}
		if (warnings.length) {
			html += `<details style="margin-bottom:8px;">
				<summary class="text-muted small" style="cursor:pointer;">
					${__("{0} warning(s)", [warnings.length])}
				</summary>
				<div style="padding:6px 4px;">
					${warnings.slice(0, 10).map((i) => row(i, "#a06000")).join("")}
				</div>
			</details>`;
		}
		return html;
	}

	render_tables(result) {
		// Line items have no target field to map onto a form, but hiding them
		// would make an invoice scan look empty when it succeeded.
		const tables = result.tables || [];
		if (!tables.length) return "";

		return tables
			.map((t) => {
				const head = (t.columns || [])
					.map((c) => `<th class="small">${frappe.utils.escape_html(c)}</th>`)
					.join("");
				const body = (t.rows || [])
					.slice(0, 25)
					.map(
						(r) =>
							`<tr>${(t.columns || [])
								.map(
									(c) =>
										`<td class="small">${frappe.utils.escape_html(
											String(r[c] || "")
										)}</td>`
								)
								.join("")}</tr>`
					)
					.join("");
				return `<div style="margin-top:12px;">
					<b>${frappe.utils.escape_html(t.name)}</b>
					<span class="text-muted small"> — ${t.row_count} ${__("row(s)")}</span>
					<div style="max-height:240px;overflow:auto;margin-top:6px;">
						<table class="table table-bordered" style="margin-bottom:0;">
							<thead><tr>${head}</tr></thead><tbody>${body}</tbody>
						</table>
					</div>
				</div>`;
			})
			.join("");
	}

	render_summary(result, mapped_count, unmapped_count) {
		const warnings = [];

		if (result.missing_required && result.missing_required.length) {
			warnings.push(`
				<div class="alert alert-warning" style="padding:8px 12px;margin-bottom:8px;">
					${__("Required fields not found")}: ${frappe.utils.escape_html(
						result.missing_required.join(", ")
					)}
				</div>`);
		}

		if (!mapped_count) {
			warnings.push(`
				<div class="alert alert-info" style="padding:8px 12px;margin-bottom:8px;">
					${__(
						"No field mappings configured for this profile, so nothing will be filled in. Add mappings on the OCR Profile to enable that."
					)}
				</div>`);
		}

		return `
			${warnings.join("")}
			<div class="text-muted small" style="margin-bottom:10px;">
				${__("Scan")}: <b>${result.scan}</b> &nbsp;·&nbsp;
				${result.source === "template" ? __("template") : __("raw OCR")}
				${result.pages && result.pages.count > 1
					? ` (${result.pages.used}/${result.pages.count} ${__("pages")})`
					: ""} &nbsp;·&nbsp;
				${__("Credits charged")}: <b>${result.credits_charged}</b> &nbsp;·&nbsp;
				${__("Remaining")}: <b>${result.credits_remaining}</b> &nbsp;·&nbsp;
				${mapped_count} ${__("mapped")}, ${unmapped_count} ${__("unmapped")}
			</div>`;
	}

	render_table(fields) {
		const rows = fields
			.map((field, index) => {
				const low = field.confidence && field.confidence < LOW_CONFIDENCE;
				const confidence = field.confidence
					? (field.confidence * 100).toFixed(1) + "%"
					: "—";
				const target = field.target_field
					? `<code>${frappe.utils.escape_html(field.target_field)}</code>`
					: `<span class="text-muted">${__("not mapped")}</span>`;

				return `
					<tr>
						<td class="text-muted small">${frappe.utils.escape_html(field.field_name)}</td>
						<td>
							<input type="text" class="form-control input-sm ocr-value"
								data-index="${index}"
								value="${frappe.utils.escape_html(field.mapped_value || "")}">
						</td>
						<td class="${low ? "text-danger" : "text-muted"} small" style="white-space:nowrap;">
							${low ? "⚠ " : ""}${confidence}
						</td>
						<td class="small">${target}</td>
					</tr>`;
			})
			.join("");

		return `
			<div style="max-height: 420px; overflow-y: auto;">
				<table class="table table-bordered" style="margin-bottom:0;">
					<thead>
						<tr>
							<th style="width:22%">${__("Field")}</th>
							<th style="width:44%">${__("Value")}</th>
							<th style="width:12%">${__("Confidence")}</th>
							<th style="width:22%">${__("Fills")}</th>
						</tr>
					</thead>
					<tbody>${rows}</tbody>
				</table>
			</div>
			<p class="text-muted small" style="margin-top:8px;">
				${__("Values are editable. Low-confidence reads are flagged — check them before applying.")}
			</p>`;
	}

	apply(dialog, result) {
		const frm = cur_frm;
		if (!frm) {
			frappe.msgprint(__("No form is open to fill."));
			return;
		}

		// Read back whatever the user edited rather than the original OCR values.
		const edited = {};
		dialog.$wrapper.find(".ocr-value").each(function () {
			edited[$(this).data("index")] = $(this).val();
		});

		const applied = [];
		let skipped = 0;

		result.fields.forEach((field, index) => {
			if (!field.target_field) return;

			const value = edited[index] !== undefined ? edited[index] : field.mapped_value;
			if (!value) return;

			const existing = frm.doc[field.target_field];
			if (existing && !field.overwrite_existing) {
				skipped += 1;
				return;
			}

			frm.set_value(field.target_field, value);
			applied.push(field.field_name);
		});

		const lineItems = this.apply_line_items(frm, result);

		frappe.call({
			method: "gphis.ocr.api.mark_applied",
			args: {
				scan: result.scan,
				applied_fields: JSON.stringify(applied),
				target_doctype: frm.doctype,
				target_name: frm.doc.name,
			},
		});

		dialog.hide();
		frappe.show_alert({
			message: __("Filled {0} field(s){1}{2}. Review and save.", [
				applied.length,
				lineItems ? __(" and {0} line item(s)", [lineItems]) : "",
				skipped ? __(", {0} kept existing values", [skipped]) : "",
			]),
			indicator: applied.length || lineItems ? "green" : "orange",
		});
	}

	apply_line_items(frm, result) {
		const items = result.line_items;
		if (!items || !items.target_field || !(items.rows || []).length) return 0;

		const table_field = frm.get_docfield(items.target_field);
		if (!table_field) {
			frappe.msgprint(
				__("This profile maps line items to <code>{0}</code>, which {1} does not have.", [
					items.target_field,
					frm.doctype,
				])
			);
			return 0;
		}

		// Appending to a table that already has rows would interleave a second
		// invoice's items into the first. Replacing silently would throw away
		// work someone typed. So: ask.
		const existing = (frm.doc[items.target_field] || []).length;
		if (existing) {
			const keep = !confirm(
				__("{0} already has {1} row(s). Replace them with the {2} scanned row(s)?", [
					items.target_field,
					existing,
					items.rows.length,
				])
			);
			if (keep) return 0;
			frm.clear_table(items.target_field);
		}

		items.rows.forEach((row) => {
			const child = frm.add_child(items.target_field);
			Object.keys(row).forEach((fieldname) => {
				// Only fields the child DocType actually has: a mapping typed
				// against the wrong table would otherwise write keys that
				// vanish on save with no warning.
				if (frappe.meta.get_docfield(child.doctype, fieldname)) {
					child[fieldname] = row[fieldname];
				}
			});
		});
		frm.refresh_field(items.target_field);

		if ((items.unmapped || []).length) {
			frappe.msgprint({
				title: __("Some columns were not mapped"),
				indicator: "orange",
				message: __("The document has no column matching: {0}", [
					items.unmapped.join(", "),
				]),
			});
		}
		return items.rows.length;
	}
};

$(document).on("app_ready", () => {
	if (!gphis.ocr._widget) {
		gphis.ocr._widget = new gphis.ocr.Widget();
	}
});
