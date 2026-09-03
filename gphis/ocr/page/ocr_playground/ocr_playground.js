// OCR Playground — try a real document before committing a profile to it.
//
// Two paths, and which is right depends on the supplier's paperwork rather
// than on a preference:
//
//   Template     the page is aligned to a reference image, then read from the
//                boxes drawn on it. Exact, but only for a design annotated
//                first, and only when alignment succeeds.
//   Vision model reads the page directly, returning the line-item table and
//                the key/value blocks around it in one pass. Needs nothing
//                prepared.
//
// The verdict shown is the arithmetic check — whether the table reconciles
// against its own quantity x price = amount — because it is the only measure
// of correctness that does not need a human to look.

frappe.pages["ocr-playground"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("OCR Playground"),
		single_column: true,
	});
	new OCRPlayground(page);
};

const STRATEGY_META = {
	template: {
		label: __("Template"),
		blurb: __("Aligned to the reference, then read from the drawn regions."),
	},
	vl: {
		label: __("Vision model"),
		blurb: __("PaddleOCR-VL reads the page. Handles unruled layouts, ~2-4s."),
	},
};

class OCRPlayground {
	constructor(page) {
		this.page = page;
		this.file_url = null;
		this.templates = [];
		this.last = null;
		this.render_shell();
		this.load_templates();
	}

	// --- layout -----------------------------------------------------------

	render_shell() {
		this.page.main.html(`
			<div class="ocr-pg">
				<div class="ocr-pg-controls">
					<div class="ocr-pg-row">
						<div class="ocr-pg-field">
							<label>${__("Document")}</label>
							<div class="ocr-pg-file">
								<button class="btn btn-default btn-sm" data-act="pick">
									${__("Choose file")}
								</button>
								<span class="ocr-pg-filename text-muted">${__("No file selected")}</span>
							</div>
						</div>
						<div class="ocr-pg-field">
							<label>${__("Mode")}</label>
							<select class="form-control input-sm" data-field="mode">
								<option value="fast">fast</option>
								<option value="balanced" selected>balanced</option>
								<option value="accurate">accurate</option>
							</select>
						</div>
						<div class="ocr-pg-field">
							<label>${__("Template")}</label>
							<select class="form-control input-sm" data-field="template">
								<option value="">${__("None")}</option>
							</select>
						</div>
						<div class="ocr-pg-field">
							<label>${__("Language")}</label>
							<input class="form-control input-sm" data-field="lang" placeholder="en">
						</div>
					</div>

					<div class="ocr-pg-strategies"></div>

					<div class="ocr-pg-actions">
						<button class="btn btn-primary btn-sm" data-act="compare" disabled>
							${__("Compare all strategies")}
						</button>
						<span class="ocr-pg-hint text-muted">
							${__("Each strategy runs on the GPU and is charged separately.")}
						</span>
					</div>
				</div>

				<div class="ocr-pg-status"></div>
				<div class="ocr-pg-results"></div>
			</div>
		`);

		this.render_strategy_buttons();
		this.bind();
		this.inject_styles();
	}

	render_strategy_buttons() {
		const html = Object.keys(STRATEGY_META)
			.map(
				(key) => `
				<div class="ocr-pg-strategy" data-strategy="${key}">
					<div class="ocr-pg-strategy-head">
						<strong>${STRATEGY_META[key].label}</strong>
						<button class="btn btn-xs btn-default" data-act="run" data-strategy="${key}" disabled>
							${__("Run")}
						</button>
					</div>
					<div class="ocr-pg-strategy-blurb">${STRATEGY_META[key].blurb}</div>
					<div class="ocr-pg-strategy-result"></div>
				</div>`
			)
			.join("");
		this.page.main.find(".ocr-pg-strategies").html(html);
	}

	bind() {
		const main = this.page.main;
		main.on("click", '[data-act="pick"]', () => this.pick_file());
		main.on("click", '[data-act="run"]', (event) => {
			this.run_one($(event.currentTarget).data("strategy"));
		});
		main.on("click", '[data-act="compare"]', () => this.compare());
	}

	inject_styles() {
		if (document.getElementById("ocr-pg-styles")) return;
		$(`<style id="ocr-pg-styles">
			.ocr-pg-controls { background: var(--fg-color); border: 1px solid var(--border-color);
				border-radius: var(--border-radius-md); padding: 12px 14px; margin-bottom: 14px; }
			.ocr-pg-row { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-end; }
			.ocr-pg-field { display: flex; flex-direction: column; gap: 4px; min-width: 150px; }
			.ocr-pg-field label { font-size: 11px; text-transform: uppercase;
				letter-spacing: .04em; color: var(--text-muted); margin: 0; }
			.ocr-pg-file { display: flex; align-items: center; gap: 8px; }
			.ocr-pg-filename { font-size: 12px; max-width: 260px; overflow: hidden;
				text-overflow: ellipsis; white-space: nowrap; }
			.ocr-pg-strategies { display: grid; gap: 10px; margin-top: 14px;
				grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
			.ocr-pg-strategy { border: 1px solid var(--border-color); border-radius: var(--border-radius-md);
				padding: 10px; background: var(--card-bg); }
			.ocr-pg-strategy-head { display: flex; justify-content: space-between;
				align-items: center; gap: 8px; }
			.ocr-pg-strategy-blurb { font-size: 11px; color: var(--text-muted);
				margin-top: 4px; line-height: 1.4; }
			.ocr-pg-strategy-result { margin-top: 8px; font-size: 12px; }
			.ocr-pg-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
			.ocr-pg-hint { font-size: 11px; }
			.ocr-pg-verdict { display: inline-flex; align-items: center; gap: 5px;
				font-weight: 600; font-size: 12px; }
			.ocr-pg-verified { color: var(--green-600); }
			.ocr-pg-unverified { color: var(--orange-600); }
			.ocr-pg-failed { color: var(--red-600); }
			.ocr-pg-meta { color: var(--text-muted); font-size: 11px; margin-top: 3px; }
			.ocr-pg-tiers { margin-top: 6px; font-size: 11px; color: var(--text-muted); }
			.ocr-pg-tier { display: flex; justify-content: space-between; gap: 6px; }
			.ocr-pg-section { margin-top: 18px; }
			.ocr-pg-section h5 { font-size: 13px; margin-bottom: 8px; }
			.ocr-pg-grid-wrap { overflow-x: auto; border: 1px solid var(--border-color);
				border-radius: var(--border-radius-md); }
			.ocr-pg-grid { border-collapse: collapse; font-size: 11px; width: 100%; }
			.ocr-pg-grid th, .ocr-pg-grid td { border: 1px solid var(--border-color);
				padding: 4px 7px; text-align: left; white-space: nowrap; }
			.ocr-pg-grid th { background: var(--subtle-fg); font-weight: 600; position: sticky; top: 0; }
			.ocr-pg-compare { width: 100%; border-collapse: collapse; font-size: 12px; }
			.ocr-pg-compare th, .ocr-pg-compare td { border-bottom: 1px solid var(--border-color);
				padding: 7px 9px; text-align: left; }
			.ocr-pg-compare th { font-size: 11px; text-transform: uppercase;
				letter-spacing: .04em; color: var(--text-muted); }
			.ocr-pg-recommended { background: var(--subtle-accent); }
			.ocr-pg-running { opacity: .55; }
		</style>`).appendTo(document.head);
	}

	// --- inputs -----------------------------------------------------------

	load_templates() {
		frappe.call({ method: "gphis.ocr.api.playground_templates" }).then((r) => {
			this.templates = r.message || [];
			const select = this.page.main.find('[data-field="template"]');
			this.templates.forEach((t) => {
				select.append(
					$("<option>").val(t.name).text(t.template_name || t.name)
				);
			});
		});
	}

	pick_file() {
		new frappe.ui.FileUploader({
			// Private: scanned documents are customer paperwork, and the
			// retention job that cleans up OCR Scan images does not know about
			// anything a user drops here.
			is_private: 1,
			folder: "Home/Attachments",
			on_success: (file_doc) => {
				this.file_url = file_doc.file_url;
				this.page.main
					.find(".ocr-pg-filename")
					.text(file_doc.file_name || file_doc.file_url)
					.removeClass("text-muted");
				this.page.main.find("[data-act]").prop("disabled", false);
				this.page.main.find(".ocr-pg-strategy-result").empty();
				this.page.main.find(".ocr-pg-results").empty();
			},
		});
	}

	options() {
		const main = this.page.main;
		return {
			file_url: this.file_url,
			mode: main.find('[data-field="mode"]').val(),
			template: main.find('[data-field="template"]').val() || null,
			lang: main.find('[data-field="lang"]').val() || null,
		};
	}

	// --- running ----------------------------------------------------------

	run_one(strategy) {
		if (!this.file_url) return;
		const card = this.page.main.find(`.ocr-pg-strategy[data-strategy="${strategy}"]`);
		const slot = card.find(".ocr-pg-strategy-result");
		card.addClass("ocr-pg-running");
		slot.html(`<span class="text-muted">${__("Running…")}</span>`);

		frappe
			.call({
				method: "gphis.ocr.api.playground_run",
				args: Object.assign({ strategy }, this.options()),
			})
			.then((r) => {
				card.removeClass("ocr-pg-running");
				const result = r.message;
				if (!result) return;
				slot.html(this.verdict_html(result.summary));
				this.render_detail(strategy, result);
			})
			.catch((error) => {
				card.removeClass("ocr-pg-running");
				slot.html(
					`<span class="ocr-pg-failed">${__("Failed")}</span>
					 <div class="ocr-pg-meta">${frappe.utils.escape_html(
							(error && error.message) || __("See the error log.")
						)}</div>`
				);
			});
	}

	compare() {
		if (!this.file_url) return;
		const status = this.page.main.find(".ocr-pg-status");
		status.html(
			`<div class="text-muted">${__(
				"Running every strategy on this document. The vision model takes a few seconds per page."
			)}</div>`
		);
		this.page.main.find(".ocr-pg-strategy-result").empty();
		this.page.main.find(".ocr-pg-results").empty();

		frappe
			.call({
				method: "gphis.ocr.api.playground_compare",
				args: this.options(),
			})
			.then((r) => {
				status.empty();
				if (r.message) this.render_comparison(r.message);
			})
			.catch(() => {
				status.html(
					`<div class="ocr-pg-failed">${__("The comparison did not finish.")}</div>`
				);
			});
	}

	// --- rendering --------------------------------------------------------

	verdict_html(summary) {
		if (!summary) return "";
		if (summary.error) {
			return `<span class="ocr-pg-verdict ocr-pg-failed">${__("Failed")}</span>
				<div class="ocr-pg-meta">${frappe.utils.escape_html(summary.error)}</div>`;
		}

		// Three states, not two. "Produced a table" and "the table's own
		// arithmetic reconciles" are different claims, and collapsing them is
		// how an unverified total gets treated as a checked one.
		let verdict;
		if (summary.verified) {
			verdict = `<span class="ocr-pg-verdict ocr-pg-verified">✓ ${__("Reconciled")}</span>`;
		} else if (summary.ok && summary.rows) {
			verdict = `<span class="ocr-pg-verdict ocr-pg-unverified">~ ${__(
				"Extracted, unverified"
			)}</span>`;
		} else {
			verdict = `<span class="ocr-pg-verdict ocr-pg-failed">✗ ${__("Nothing usable")}</span>`;
		}

		const tiers = (summary.attempts || [])
			.map(
				(a) => `<div class="ocr-pg-tier">
					<span>${a.tier}${a.verified ? " ✓" : ""}</span>
					<span>${a.seconds != null ? a.seconds + "s" : ""}${
						a.reason ? " · " + frappe.utils.escape_html(a.reason) : ""
					}</span>
				</div>`
			)
			.join("");

		return `${verdict}
			<div class="ocr-pg-meta">
				${summary.rows} ${__("rows")} × ${summary.cols} ${__("cols")} ·
				${Math.round(summary.duration_ms)} ms ·
				${summary.credits} ${__("credits")}
				${summary.tier ? " · " + __("won by") + " " + summary.tier : ""}
			</div>
			<div class="ocr-pg-tiers">${tiers}</div>`;
	}

	render_comparison(payload) {
		const results = payload.results || {};
		const names = Object.keys(results);

		const rows = names
			.map((name) => {
				const r = results[name];
				const recommended = name === payload.recommended;
				const state = r.error
					? `<span class="ocr-pg-failed">${__("failed")}</span>`
					: r.verified
					? `<span class="ocr-pg-verified">${__("reconciled")}</span>`
					: r.ok && r.rows
					? `<span class="ocr-pg-unverified">${__("unverified")}</span>`
					: `<span class="ocr-pg-failed">${__("nothing")}</span>`;
				return `<tr class="${recommended ? "ocr-pg-recommended" : ""}">
					<td><strong>${STRATEGY_META[name] ? STRATEGY_META[name].label : name}</strong>
						${recommended ? ` <span class="text-muted">— ${__("recommended")}</span>` : ""}</td>
					<td>${state}</td>
					<td>${r.rows} × ${r.cols}</td>
					<td>${Math.round(r.duration_ms)} ms</td>
					<td>${r.credits}</td>
				</tr>`;
			})
			.join("");

		const verified = payload.verified || [];
		let advice;
		if (!verified.length) {
			advice = __(
				"No strategy reconciled this document's arithmetic. That usually means the page has no quantity × price = amount relation to check — not that extraction failed. Compare the tables below by eye."
			);
		} else if (payload.recommended) {
			const meta = STRATEGY_META[payload.recommended];
			advice = __("{0} is the cheapest strategy that proved itself on this document.", [
				`<strong>${meta ? meta.label : payload.recommended}</strong>`,
			]);
		}

		let html = `<div class="ocr-pg-section">
			<h5>${__("Comparison")}</h5>
			<table class="ocr-pg-compare">
				<thead><tr>
					<th>${__("Strategy")}</th><th>${__("Result")}</th>
					<th>${__("Table")}</th><th>${__("Time")}</th><th>${__("Credits")}</th>
				</tr></thead>
				<tbody>${rows}</tbody>
			</table>
			${advice ? `<div class="ocr-pg-meta" style="margin-top:8px">${advice}</div>` : ""}
		</div>`;

		names.forEach((name) => {
			const r = results[name];
			this.page.main
				.find(`.ocr-pg-strategy[data-strategy="${name}"] .ocr-pg-strategy-result`)
				.html(this.verdict_html(r));
			const label = STRATEGY_META[name] ? STRATEGY_META[name].label : name;
			if (r.grid && r.grid.length) {
				html += this.grid_section(`${label} — ${__("table")}`, r.grid);
			}
			// The key/value blocks printed around the table — client, dates,
			// totals. They arrive in the same pass as the table, so a profile
			// can map them without a second scan.
			html += this.fields_section(`${label} — ${__("fields")}`, r.fields);
		});

		this.page.main.find(".ocr-pg-results").html(html);
	}

	render_detail(strategy, result) {
		const summary = result.summary || {};
		const label = STRATEGY_META[strategy] ? STRATEGY_META[strategy].label : strategy;
		let html = "";
		if (summary.grid && summary.grid.length) {
			html += this.grid_section(`${label} — ${__("table")}`, summary.grid);
		}
		html += this.fields_section(__("Fields"), summary.fields);
		this.page.main.find(".ocr-pg-results").html(html);
	}

	fields_section(title, fields) {
		const keys = Object.keys(fields || {});
		if (!keys.length) return "";

		const rows = keys
			.map((key) => {
				const field = fields[key] || {};
				// A VLM reports no per-value confidence, so showing 0% would
				// read as "certainly wrong" rather than "not measured".
				const confidence = field.confidence
					? `${(field.confidence * 100).toFixed(0)}%`
					: `<span class="text-muted">—</span>`;
				return `<tr>
					<td>${frappe.utils.escape_html(key)}</td>
					<td>${frappe.utils.escape_html(String(field.value ?? ""))}</td>
					<td>${confidence}</td>
				</tr>`;
			})
			.join("");

		return `<div class="ocr-pg-section">
			<h5>${title} <span class="text-muted" style="font-weight:400">
				(${keys.length})</span></h5>
			<div class="ocr-pg-grid-wrap"><table class="ocr-pg-grid">
				<thead><tr><th>${__("Field")}</th><th>${__("Value")}</th><th>${__(
			"Confidence"
		)}</th></tr></thead>
				<tbody>${rows}</tbody>
			</table></div>
		</div>`;
	}

	grid_section(title, grid) {
		const header = (grid[0] || [])
			.map((cell) => `<th>${frappe.utils.escape_html(String(cell ?? ""))}</th>`)
			.join("");
		const body = grid
			.slice(1)
			.map(
				(row) =>
					`<tr>${row
						.map((cell) => `<td>${frappe.utils.escape_html(String(cell ?? ""))}</td>`)
						.join("")}</tr>`
			)
			.join("");
		return `<div class="ocr-pg-section">
			<h5>${title} <span class="text-muted" style="font-weight:400">
				(${grid.length - 1} ${__("rows")})</span></h5>
			<div class="ocr-pg-grid-wrap">
				<table class="ocr-pg-grid"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>
			</div>
		</div>`;
	}
}
