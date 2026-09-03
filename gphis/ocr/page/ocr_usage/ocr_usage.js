/**
 * OCR Usage and Billing.
 *
 * Reads live from the OCR Platform rather than from anything cached in Frappe:
 * the platform is the billing authority, and a stale local copy of a credit
 * balance is worse than no copy at all.
 */

frappe.pages["ocr-usage"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("OCR Usage and Billing"),
		single_column: true,
	});

	const view = new OCRUsage(page);
	page.set_primary_action(__("Refresh"), () => view.load(), "refresh");
	view.load();
};

class OCRUsage {
	constructor(page) {
		this.page = page;
		this.$body = $('<div class="ocr-usage"></div>').appendTo(page.main);
	}

	load() {
		this.$body.html(`<div class="text-muted" style="padding:40px;text-align:center;">
			${__("Contacting the OCR platform...")}</div>`);

		Promise.all([
			frappe.call({ method: "gphis.ocr.api.get_quota" }),
			frappe.call({ method: "gphis.ocr.api.get_usage" }),
		])
			.then(([quota, usage]) => this.render(quota.message, usage.message))
			.catch(() => this.render_unreachable());
	}

	render_unreachable() {
		// The server-side client already produced a specific reason (bad key,
		// unreachable host, OCR disabled) via msgprint. Do not restate it
		// vaguely here — just say what this page cannot do and where to fix it.
		this.$body.html(`
			<div class="alert alert-warning" style="margin-top:20px;">
				<b>${__("Could not load usage data.")}</b><br>
				${__("Check the connection in")}
				<a href="/app/ocr-settings">${__("OCR Settings")}</a>.
			</div>`);
	}

	render(quota, usage) {
		const included = quota.credits_included || 0;
		const used = quota.credits_used || 0;
		const remaining = quota.credits_remaining || 0;
		const pct = included ? Math.min(100, Math.round((used / included) * 100)) : 0;

		// Warn before the customer is surprised by a 402, not after.
		const bar_colour = pct >= 90 ? "#e24c4c" : pct >= 70 ? "#f5a623" : "#29cd42";
		const days_left = moment(quota.period_end).diff(moment(), "days");

		this.$body.html(`
			${this.tiles(quota, remaining, days_left)}
			<div class="frappe-card" style="padding:16px 20px;margin-bottom:16px;">
				<div style="display:flex;justify-content:space-between;margin-bottom:8px;">
					<b>${__("Credits this period")}</b>
					<span class="text-muted">${used} / ${included} (${pct}%)</span>
				</div>
				<div style="background:var(--gray-200);border-radius:6px;height:12px;overflow:hidden;">
					<div style="width:${pct}%;height:100%;background:${bar_colour};transition:width .3s;"></div>
				</div>
				<div class="text-muted small" style="margin-top:8px;">
					${__("Renews")} ${frappe.datetime.str_to_user(quota.period_end)}
					${days_left >= 0 ? `· ${__("{0} days left", [days_left])}` : ""}
				</div>
			</div>
			<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
				${this.breakdown(__("By Processing Mode"), usage.by_mode, __("No requests yet this period."))}
				${this.breakdown(
					__("By Document Type"),
					usage.by_document_type,
					__("Document types appear once extractors are configured.")
				)}
			</div>
			${this.requests(usage)}
		`);
	}

	tiles(quota, remaining, days_left) {
		const tile = (label, value, sub, colour) => `
			<div class="frappe-card" style="padding:16px 20px;flex:1;">
				<div class="text-muted small">${label}</div>
				<div style="font-size:24px;font-weight:600;${colour ? `color:${colour};` : ""}">${value}</div>
				<div class="text-muted small">${sub || "&nbsp;"}</div>
			</div>`;

		const low = remaining <= 0 ? "#e24c4c" : remaining < 50 ? "#f5a623" : "";

		return `<div style="display:flex;gap:16px;margin-bottom:16px;">
			${tile(__("Plan"), frappe.utils.escape_html(quota.plan || "—"), "")}
			${tile(__("Credits Remaining"), remaining, remaining <= 0 ? __("Scans are blocked") : "", low)}
			${tile(__("Period Ends"), frappe.datetime.str_to_user(quota.period_end), days_left >= 0 ? __("{0} days", [days_left]) : "")}
		</div>`;
	}

	breakdown(title, data, empty_message) {
		const entries = Object.entries(data || {});
		const total = entries.reduce((sum, [, count]) => sum + count, 0);

		const body = entries.length
			? entries
					.sort((a, b) => b[1] - a[1])
					.map(([key, count]) => {
						const pct = total ? Math.round((count / total) * 100) : 0;
						return `
						<div style="margin-bottom:10px;">
							<div style="display:flex;justify-content:space-between;font-size:13px;">
								<span>${frappe.utils.escape_html(key)}</span>
								<span class="text-muted">${count}</span>
							</div>
							<div style="background:var(--gray-200);border-radius:4px;height:6px;margin-top:4px;">
								<div style="width:${pct}%;height:100%;background:var(--blue-500);border-radius:4px;"></div>
							</div>
						</div>`;
					})
					.join("")
			: `<div class="text-muted small">${empty_message}</div>`;

		return `<div class="frappe-card" style="padding:16px 20px;">
			<b style="display:block;margin-bottom:12px;">${title}</b>${body}</div>`;
	}

	requests(usage) {
		const rejected = usage.requests_rejected || 0;
		// Rejections are the upgrade signal — surfaced, not buried.
		const rejected_note = rejected
			? `<span style="color:#e24c4c;"> · ${rejected} ${__("blocked by quota")}</span>`
			: "";

		return `<div class="frappe-card" style="padding:16px 20px;margin-top:16px;">
			<b>${__("Requests this period")}</b>: ${usage.requests_total || 0}${rejected_note}
			<div class="text-muted small" style="margin-top:6px;">
				${__("Full history is in")}
				<a href="/app/ocr-scan">${__("OCR Scan")}</a>.
			</div>
		</div>`;
	}
}
