// gphis/gphis/cura/page/cura_home/cura_home.js

frappe.pages["cura-home"].on_page_load = function (wrapper) {
    const page = frappe.ui.make_app_page({
        parent: wrapper,
        title: "",          // no page title chrome — Cura owns its own header
        single_column: true,
    });

    const cura = frappe.boot.cura || {};

    $(wrapper).find(".layout-main-section").html(`
        <div class="cura-home">
            <h2>Welcome to Cura</h2>
            <p>Signed in as: ${frappe.session.user} — role: ${cura.primary_role || "unknown"}</p>
        </div>
    `);
};
