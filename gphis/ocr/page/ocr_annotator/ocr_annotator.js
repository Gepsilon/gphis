/**
 * OCR Annotator — bind the target DocType's own fields to places on the page.
 *
 * Open with ?template=<OCR Template name>. The reference image is displayed at
 * a fitted scale; every box is stored in the image's own pixel coordinates so
 * the template stays valid regardless of how it was viewed while drawing.
 *
 * Boxes are never named by hand. The palette offers the target DocType's
 * visible fields — and its child tables' fields — and a box is created by
 * dragging one onto the image. The box then carries that *fieldname* as its
 * output key, which is what makes extraction self-mapping: a value read from
 * this box is already addressed to `bill_no`, so nothing has to guess later
 * what "Invoice No" was supposed to mean.
 *
 * Two region kinds, because they answer different questions:
 *   static  — a fixed box. Always in the same place: an invoice number, a
 *             date, a name on an ID card.
 *   table   — a child table's area. Its columns are dragged in from that
 *             child DocType's fields; rows are found at extraction time by
 *             clustering text, because no template can know how many line
 *             items a document has.
 */

frappe.pages["ocr-annotator"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("OCR Annotator"),
		single_column: true,
	});
	new Annotator(page);
};

// A dropped box has to start somewhere. These are image pixels, sized for a
// value on an A4 scan — large enough to grab and resize, small enough not to
// swallow its neighbours.
const DEFAULT_BOX = { w: 220, h: 44 };
const DEFAULT_COLUMN_WIDTH = 120;
const MIN_SIZE = 12;
const HANDLE = 10;

class Annotator {
	constructor(page) {
		this.page = page;
		this.regions = []; // top level: static fields and tables
		this.scale = 1;
		this.layout = null; // the target DocType's fields
		this.drag = null; // move/resize in progress
		// When set, dropped child fields become columns of that table.
		this.active_table = null;

		this.build();
		this.load_from_route();
	}

	// --- layout ---------------------------------------------------------

	build() {
		this.page.set_primary_action(__("Save"), () => this.save(), "check");
		this.page.add_menu_item(__("Sync to Platform"), () => this.sync());
		this.page.add_menu_item(__("Clear All Regions"), () => this.clear_all());

		this.$body = $(`
			<div class="ocr-annotator">
				<div class="annot-col">
					<div class="frappe-card annot-card">
						<b>${__("Fields")}</b>
						<div class="text-muted small annot-palette-hint" style="margin-top:4px;">
							${__("Drag a field onto the page.")}
						</div>
						<div class="annot-palette"></div>
					</div>
				</div>
				<div>
					<div class="frappe-card annot-card" style="margin-bottom:10px;">
						<span class="text-muted small annot-hint"></span>
					</div>
					<div class="annot-stage frappe-card">
						<img class="annot-img" draggable="false">
						<div class="annot-overlay"></div>
					</div>
				</div>
				<div class="annot-col">
					<div class="frappe-card annot-card" style="margin-bottom:10px;">
						<b>${__("Placed")}</b>
						<div class="annot-list"></div>
					</div>
					<div class="frappe-card annot-card">
						<div class="annot-mode small"></div>
					</div>
				</div>
			</div>
		`).appendTo(this.page.main);

		this.$img = this.$body.find(".annot-img");
		this.$overlay = this.$body.find(".annot-overlay");
		this.inject_styles();
		this.bind_drop();
		this.bind_box_editing();
		this.set_hint(__("Load a template to begin."));
	}

	inject_styles() {
		if (document.getElementById("ocr-annot-styles")) return;
		$(`<style id="ocr-annot-styles">
			.ocr-annotator { display:grid; grid-template-columns:270px 1fr 290px; gap:14px; }
			.annot-card { padding:12px; }
			.annot-stage { padding:0; position:relative; overflow:auto; max-height:74vh; }
			.annot-img { display:block; max-width:100%; user-select:none; }
			.annot-overlay { position:absolute; inset:0; }
			.annot-palette { margin-top:10px; max-height:66vh; overflow:auto; }
			.annot-group { border:1px solid var(--border-color); border-radius:var(--border-radius-md);
				margin-bottom:6px; overflow:hidden; }
			.annot-group-head { display:flex; justify-content:space-between; align-items:center;
				gap:6px; padding:7px 9px; cursor:pointer; background:var(--subtle-fg); font-size:12px; }
			.annot-group-head:hover { background:var(--fg-hover-color); }
			.annot-group-body { padding:6px; display:none; }
			.annot-group.open .annot-group-body { display:block; }
			.annot-chip { display:flex; justify-content:space-between; align-items:center; gap:6px;
				padding:4px 7px; margin:2px 0; font-size:11px; border-radius:var(--border-radius-sm);
				border:1px solid var(--border-color); background:var(--card-bg); cursor:grab; }
			.annot-chip:hover { border-color:var(--primary); }
			.annot-chip.placed { opacity:.45; cursor:default; }
			.annot-chip .annot-chip-type { color:var(--text-muted); font-size:10px; }
			.annot-chip-reqd { color:var(--red-500); }
			.annot-box { position:absolute; box-sizing:border-box; cursor:move; }
			.annot-box-label { position:absolute; top:-17px; left:0; font-size:10px; color:#fff;
				padding:0 4px; white-space:nowrap; border-radius:2px 2px 0 0; }
			.annot-handle { position:absolute; right:-5px; bottom:-5px; width:${HANDLE}px;
				height:${HANDLE}px; background:#fff; border:2px solid currentColor;
				border-radius:2px; cursor:nwse-resize; }
			.annot-drop { outline:2px dashed var(--primary); outline-offset:-4px; }
			.annot-list { margin-top:8px; max-height:52vh; overflow:auto; }
			.annot-row { padding:6px 0; border-bottom:1px solid var(--border-color); }
		</style>`).appendTo(document.head);
	}

	set_hint(text) {
		this.$body.find(".annot-hint").text(text);
	}

	render_mode() {
		const $mode = this.$body.find(".annot-mode");
		if (this.active_table) {
			$mode.html(`
				<span class="indicator-pill orange">${__("Columns")}</span>
				<div class="text-muted" style="margin-top:6px;">
					${__("Fields you drag from")} <b>${frappe.utils.escape_html(this.active_table.name)}</b>
					${__("become its columns.")}
				</div>
				<button class="btn btn-xs btn-default" style="margin-top:8px;">${__("Done")}</button>
			`);
			$mode.find("button").on("click", () => {
				this.active_table = null;
				this.render();
			});
		} else {
			$mode.html(`
				<span class="indicator-pill blue">${__("Placing fields")}</span>
				<div class="text-muted" style="margin-top:6px;">
					${__(
						"Drag a field onto the page. Drag a child table first, then drag its fields inside it."
					)}
				</div>
			`);
		}
	}

	// --- loading --------------------------------------------------------

	load_from_route() {
		const name = frappe.utils.get_url_arg("template");
		if (!name) {
			frappe.msgprint({
				title: __("No template selected"),
				message: __("Open this page from an OCR Template using <b>Open Annotator</b>."),
				indicator: "orange",
			});
			return;
		}
		frappe.db.get_doc("OCR Template", name).then((doc) => this.load(doc));
	}

	load(doc) {
		this.doc = doc;
		this.page.set_title(__("Annotator — {0}", [doc.template_name]));

		if (!doc.reference_image) {
			frappe.msgprint(__("This template has no reference image."));
			return;
		}

		this.load_palette(doc.target_doctype);

		this.$img.attr("src", doc.reference_image).on("load", () => {
			// Natural size is authoritative: boxes are stored in image pixels,
			// so a browser-scaled display never changes what gets saved.
			this.natural = {
				w: this.$img[0].naturalWidth,
				h: this.$img[0].naturalHeight,
			};
			this.scale = this.$img.width() / this.natural.w;
			this.import_regions(doc.regions);
			this.set_hint(
				__("Reference {0}x{1}px, shown at {2}%.", [
					this.natural.w,
					this.natural.h,
					Math.round(this.scale * 100),
				])
			);
			this.render();
		});
	}

	load_palette(doctype) {
		if (!doctype) {
			this.$body
				.find(".annot-palette")
				.html(
					`<div class="text-muted small">${__(
						"Set <b>Target DocType</b> on this template to get its fields here."
					)}</div>`
				);
			return;
		}
		frappe
			.call({ method: "gphis.ocr.api.get_doctype_layout", args: { doctype } })
			.then((r) => {
				this.layout = r.message;
				this.render_palette();
			});
	}

	import_regions(raw) {
		this.regions = [];
		if (!raw) return;
		let root;
		try {
			root = typeof raw === "string" ? JSON.parse(raw) : raw;
		} catch (e) {
			frappe.msgprint(__("Stored regions are not valid JSON; starting empty."));
			return;
		}
		(root.subregions || []).forEach((r) => {
			this.regions.push({
				name: r.name,
				// Templates drawn before fields were bindable have no key; the
				// name was the output key then, so it still is.
				key: r.key || r.name,
				type: r.type || "static",
				field_type: r.field_type || "text",
				required: !!r.required,
				box: r.box,
				child_doctype: r.child_doctype || null,
				columns: (r.columns || []).map((c) => ({
					name: c.name,
					key: c.key || c.name,
					type: "column",
					field_type: c.field_type || "text",
					box: c.box,
				})),
			});
		});
	}

	// --- palette --------------------------------------------------------

	render_palette() {
		const $palette = this.$body.find(".annot-palette").empty();
		if (!this.layout) return;

		const placed = new Set(this.regions.map((r) => r.key));
		const placed_columns = new Set();
		this.regions.forEach((r) =>
			(r.columns || []).forEach((c) => placed_columns.add(`${r.key}::${c.key}`))
		);

		$palette.append(
			this.group_html(
				this.layout.doctype,
				this.layout.label || this.layout.doctype,
				this.layout.fields.map((f) => this.chip_html(f, placed.has(f.fieldname))),
				true
			)
		);

		(this.layout.child_tables || []).forEach((table) => {
			const region = this.regions.find((r) => r.key === table.fieldname);
			const chips = table.fields.map((f) =>
				this.chip_html(
					f,
					region ? placed_columns.has(`${table.fieldname}::${f.fieldname}`) : false,
					table.fieldname
				)
			);
			// The table's own area must exist before its columns mean anything,
			// so it is offered as a draggable chip of its own.
			const head = region
				? `<span class="indicator-pill green">${__("placed")}</span>`
				: `<span class="text-muted" style="font-size:10px;">${__("drag me first")}</span>`;
			$palette.append(
				this.group_html(
					table.fieldname,
					`${table.label} <span class="text-muted">(${table.fields.length})</span>`,
					[
						`<div class="annot-chip" draggable="true"
							data-kind="table" data-fieldname="${frappe.utils.escape_html(table.fieldname)}"
							data-label="${frappe.utils.escape_html(table.label)}"
							data-child="${frappe.utils.escape_html(table.child_doctype)}">
							<span><b>${__("Table area")}</b></span>${head}
						</div>`,
					].concat(region ? chips : [])
				)
			);
		});

		$palette.find(".annot-group-head").on("click", (event) => {
			$(event.currentTarget).closest(".annot-group").toggleClass("open");
		});
		$palette.find(".annot-chip[draggable=true]").on("dragstart", (event) => {
			const data = $(event.currentTarget).data();
			event.originalEvent.dataTransfer.setData("text/plain", JSON.stringify(data));
			event.originalEvent.dataTransfer.effectAllowed = "copy";
		});
	}

	group_html(key, title, items, open) {
		return `<div class="annot-group ${open ? "open" : ""}" data-group="${frappe.utils.escape_html(
			key
		)}">
			<div class="annot-group-head"><span>${title}</span><span class="text-muted">▾</span></div>
			<div class="annot-group-body">${items.join("") || `<div class="text-muted small">${__(
			"No visible fields."
		)}</div>`}</div>
		</div>`;
	}

	chip_html(field, placed, table) {
		return `<div class="annot-chip ${placed ? "placed" : ""}"
			${placed ? "" : 'draggable="true"'}
			data-kind="${table ? "column" : "field"}"
			${table ? `data-table="${frappe.utils.escape_html(table)}"` : ""}
			data-fieldname="${frappe.utils.escape_html(field.fieldname)}"
			data-label="${frappe.utils.escape_html(field.label)}"
			data-field-type="${frappe.utils.escape_html(field.field_type)}"
			data-required="${field.required ? 1 : 0}">
			<span>${frappe.utils.escape_html(field.label)}${
			field.required ? ' <span class="annot-chip-reqd">*</span>' : ""
		}</span>
			<span class="annot-chip-type">${frappe.utils.escape_html(field.field_type)}</span>
		</div>`;
	}

	// --- placing --------------------------------------------------------

	bind_drop() {
		this.$overlay.on("dragover", (event) => {
			event.preventDefault();
			event.originalEvent.dataTransfer.dropEffect = "copy";
			this.$overlay.addClass("annot-drop");
		});
		this.$overlay.on("dragleave drop", () => this.$overlay.removeClass("annot-drop"));

		this.$overlay.on("drop", (event) => {
			event.preventDefault();
			if (!this.natural) return;
			let data;
			try {
				data = JSON.parse(event.originalEvent.dataTransfer.getData("text/plain"));
			} catch (e) {
				return;
			}
			const point = this.to_image(event.originalEvent);
			this.place(data, point);
		});
	}

	to_image(event) {
		const rect = this.$img[0].getBoundingClientRect();
		return {
			x: Math.round((event.clientX - rect.left) / this.scale),
			y: Math.round((event.clientY - rect.top) / this.scale),
		};
	}

	place(data, point) {
		const clamp = (box) => [
			Math.max(0, Math.min(box[0], this.natural.w - MIN_SIZE)),
			Math.max(0, Math.min(box[1], this.natural.h - MIN_SIZE)),
			box[2],
			box[3],
		];

		if (data.kind === "column") {
			return this.place_column(data, point);
		}

		if (this.regions.some((r) => r.key === data.fieldname)) {
			frappe.show_alert({
				message: __("{0} is already placed.", [data.label]),
				indicator: "orange",
			});
			return;
		}

		const box = clamp([
			point.x - DEFAULT_BOX.w / 2,
			point.y - DEFAULT_BOX.h / 2,
			DEFAULT_BOX.w,
			DEFAULT_BOX.h,
		]);

		if (data.kind === "table") {
			const region = {
				name: data.label,
				key: data.fieldname,
				type: "table",
				field_type: "text",
				required: false,
				child_doctype: data.child,
				// A table's default area is deliberately larger: it has to hold
				// rows, and a value-sized box would have to be resized before
				// a single column could sit inside it.
				box: clamp([point.x - 300, point.y - 60, 600, 240]),
				columns: [],
			};
			this.regions.push(region);
			this.active_table = region;
			frappe.show_alert(__("Now drag {0} fields inside it.", [data.label]));
		} else {
			this.regions.push({
				name: data.label,
				key: data.fieldname,
				type: "static",
				field_type: data.fieldType || data["field-type"] || "text",
				required: !!Number(data.required),
				box: box,
				columns: [],
			});
		}
		this.render();
	}

	place_column(data, point) {
		const table =
			this.regions.find((r) => r.key === data.table) || this.active_table;
		if (!table || table.type !== "table") {
			frappe.msgprint(__("Place the table area first, then drag its fields inside."));
			return;
		}
		if ((table.columns || []).some((c) => c.key === data.fieldname)) {
			frappe.show_alert({
				message: __("{0} is already a column.", [data.label]),
				indicator: "orange",
			});
			return;
		}

		// Columns are stored relative to the table's origin and carry no
		// height — they span the table body, whose extent is only known once
		// rows are found.
		const x = Math.max(
			0,
			Math.min(point.x - table.box[0] - DEFAULT_COLUMN_WIDTH / 2, table.box[2] - MIN_SIZE)
		);
		table.columns.push({
			name: data.label,
			key: data.fieldname,
			type: "column",
			field_type: data.fieldType || data["field-type"] || "text",
			box: [Math.round(x), 0, DEFAULT_COLUMN_WIDTH],
		});
		table.columns.sort((a, b) => a.box[0] - b.box[0]);
		this.active_table = table;
		this.render();
	}

	// --- moving and resizing ---------------------------------------------

	bind_box_editing() {
		this.$overlay.on("mousedown", ".annot-box", (event) => {
			if (!this.natural) return;
			event.preventDefault();
			event.stopPropagation();

			const $box = $(event.currentTarget);
			const path = $box.data("path");
			const target = this.resolve(path);
			if (!target) return;

			this.drag = {
				target,
				path,
				mode: $(event.target).hasClass("annot-handle") ? "resize" : "move",
				origin: this.to_image(event),
				box: target.box.slice(),
			};
		});

		$(document).on("mousemove.annot", (event) => {
			if (!this.drag || !this.natural) return;
			const now = this.to_image(event);
			const dx = now.x - this.drag.origin.x;
			const dy = now.y - this.drag.origin.y;
			const start = this.drag.box;
			const target = this.drag.target;

			if (this.drag.path.column === undefined) {
				if (this.drag.mode === "move") {
					target.box = [
						Math.max(0, Math.min(start[0] + dx, this.natural.w - start[2])),
						Math.max(0, Math.min(start[1] + dy, this.natural.h - start[3])),
						start[2],
						start[3],
					];
				} else {
					target.box = [
						start[0],
						start[1],
						Math.max(MIN_SIZE, Math.min(start[2] + dx, this.natural.w - start[0])),
						Math.max(MIN_SIZE, Math.min(start[3] + dy, this.natural.h - start[1])),
					];
				}
			} else {
				// A column has [x, width] only; vertical extent belongs to the
				// table, so dragging it up or down would mean nothing.
				const parent = this.resolve({ region: this.drag.path.region });
				if (this.drag.mode === "move") {
					target.box = [
						Math.max(0, Math.min(start[0] + dx, parent.box[2] - start[2])),
						0,
						start[2],
					];
				} else {
					target.box = [
						start[0],
						0,
						Math.max(MIN_SIZE, Math.min(start[2] + dx, parent.box[2] - start[0])),
					];
				}
			}
			this.render();
		});

		$(document).on("mouseup.annot", () => {
			if (!this.drag) return;
			const region = this.resolve({ region: this.drag.path.region });
			if (region && region.columns) {
				region.columns.sort((a, b) => a.box[0] - b.box[0]);
			}
			this.drag = null;
			this.render();
		});
	}

	resolve(path) {
		const region = this.regions[path.region];
		if (!region) return null;
		return path.column === undefined ? region : region.columns[path.column];
	}

	// --- rendering ------------------------------------------------------

	render() {
		this.$overlay.empty();
		const s = this.scale;

		const draw = (box, colour, label, path, dashed) => {
			const $box = $(`<div class="annot-box"></div>`)
				.css({
					left: box[0] * s + "px",
					top: box[1] * s + "px",
					width: box[2] * s + "px",
					height: box[3] * s + "px",
					border: `2px ${dashed ? "dashed" : "solid"} ${colour}`,
					background: colour + "18",
					color: colour,
				})
				.data("path", path)
				.append(
					$(`<div class="annot-box-label"></div>`)
						.text(label)
						.css({ background: colour })
				)
				.append($(`<div class="annot-handle"></div>`));
			$box.appendTo(this.$overlay);
		};

		this.regions.forEach((r, index) => {
			const colour = r.type === "table" ? "#e67e22" : "#2490ef";
			draw(r.box, colour, r.name, { region: index });
			(r.columns || []).forEach((c, position) => {
				draw(
					[r.box[0] + c.box[0], r.box[1], c.box[2], r.box[3]],
					"#16a085",
					c.name,
					{ region: index, column: position },
					true
				);
			});
		});

		this.render_list();
		this.render_mode();
		this.render_palette();
	}

	render_list() {
		const $list = this.$body.find(".annot-list").empty();
		if (!this.regions.length) {
			$list.html(`<div class="text-muted small">${__("Nothing placed yet.")}</div>`);
			return;
		}

		this.regions.forEach((r, index) => {
			const badge = r.type === "table" ? "orange" : "blue";
			const $row = $(`
				<div class="annot-row">
					<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
						<div>
							<span class="indicator-pill ${badge}">${r.type}</span>
							<b>${frappe.utils.escape_html(r.name)}</b>
							<div class="text-muted small">
								<code>${frappe.utils.escape_html(r.key)}</code>
								${r.type === "static" ? " · " + frappe.utils.escape_html(r.field_type) : ""}
								${r.required ? " · " + __("required") : ""}
							</div>
						</div>
						<div style="white-space:nowrap;">
							${
								r.type === "table"
									? `<button class="btn btn-xs btn-default annot-cols">${__(
											"Columns"
									  )}</button>`
									: ""
							}
							<button class="btn btn-xs btn-default annot-del">✕</button>
						</div>
					</div>
					${
						r.columns && r.columns.length
							? `<div class="text-muted small" style="margin-top:4px;">${r.columns
									.map((c) => frappe.utils.escape_html(c.name))
									.join(" · ")}</div>`
							: r.type === "table"
							? `<div class="text-danger small" style="margin-top:4px;">${__(
									"No columns yet — a table needs at least one."
							  )}</div>`
							: ""
					}
				</div>
			`);

			$row.find(".annot-del").on("click", () => {
				this.regions.splice(index, 1);
				if (this.active_table === r) this.active_table = null;
				this.render();
			});
			$row.find(".annot-cols").on("click", () => {
				this.active_table = r;
				this.render();
			});
			$list.append($row);
		});
	}

	clear_all() {
		frappe.confirm(__("Remove every region from this template?"), () => {
			this.regions = [];
			this.active_table = null;
			this.render();
		});
	}

	// --- saving ---------------------------------------------------------

	build_payload() {
		return {
			name: "page",
			type: "static",
			box: [0, 0, this.natural.w, this.natural.h],
			subregions: this.regions.map((r) => {
				const out = {
					name: r.name,
					// The output key is the target's fieldname, so an extracted
					// value arrives already addressed to the field it fills.
					key: r.key,
					type: r.type,
					box: r.box,
					field_type: r.field_type || "text",
				};
				if (r.required) out.required = true;
				if (r.child_doctype) out.child_doctype = r.child_doctype;
				if (r.type === "table") {
					out.columns = r.columns.map((c) => ({
						name: c.name,
						key: c.key,
						type: "column",
						field_type: c.field_type || "text",
						box: c.box,
					}));
				}
				return out;
			}),
		};
	}

	problems() {
		const issues = [];
		const keys = new Set();
		this.regions.forEach((r) => {
			if (keys.has(r.key)) issues.push(__("Duplicate field: {0}", [r.name]));
			keys.add(r.key);
			if (r.type === "table" && !(r.columns || []).length) {
				issues.push(__("Table {0} has no columns.", [r.name]));
			}
		});
		return issues;
	}

	save(then) {
		if (!this.doc || !this.natural) return;

		// Checked here rather than on the server so the message arrives while
		// the drawing is still on screen.
		const issues = this.problems();
		if (issues.length) {
			frappe.msgprint({
				title: __("Fix these first"),
				message: issues.map((i) => `• ${i}`).join("<br>"),
				indicator: "red",
			});
			return;
		}

		frappe.db
			.set_value("OCR Template", this.doc.name, {
				regions: JSON.stringify(this.build_payload(), null, 2),
				reference_width: this.natural.w,
				reference_height: this.natural.h,
			})
			.then(() => {
				frappe.show_alert({ message: __("Regions saved"), indicator: "green" });
				if (then) then();
			});
	}

	sync() {
		this.save(() => {
			frappe.call({
				method: "gphis.ocr.api.sync_template",
				args: { template: this.doc.name },
				freeze: true,
				freeze_message: __("Sending template to the OCR platform..."),
				callback: (r) => {
					if (r.message) {
						frappe.show_alert({ message: r.message.message, indicator: "green" });
					}
				},
			});
		});
	}
}
