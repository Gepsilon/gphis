frappe.pages['waiting-room-manager'].on_page_load = function(wrapper) {
    const page = frappe.ui.make_app_page({
        parent: wrapper,
        title: 'Waiting Room Manager',
        single_column: true,
    });

    const list_wrapper = $('<div class="waiting-room-list">').appendTo(page.body);

    function load_entries() {
        frappe.call({
            method: 'frappe.client.get_list',
            args: {
                doctype: 'Waiting Room Entry',
                filters: { status: ['not in', ['Completed', 'Cancelled']] },
                fields: ['name', 'patient_name', 'token_no', 'status', 'department', 'practitioner'],
                order_by: 'checked_in_on asc',
            },
            callback: (r) => render(r.message || []),
        });
    }

    function render(entries) {
        list_wrapper.empty();
        entries.forEach((e) => {
            const row = $(`
                <div class="waiting-room-row" style="display:flex;gap:8px;padding:8px;border-bottom:1px solid #eee;">
                    <span>#${e.token_no}</span>
                    <span>${e.patient_name}</span>
                    <span class="text-muted">${e.status}</span>
                    <button class="btn btn-xs btn-default" data-action="Called">Call</button>
                    <button class="btn btn-xs btn-default" data-action="In Consultation">Start</button>
                    <button class="btn btn-xs btn-default" data-action="Completed">Complete</button>
                    <button class="btn btn-xs btn-default" data-action="No Show">No Show</button>
                </div>
            `).appendTo(list_wrapper);

            row.find('button').on('click', function () {
                frappe.call({
                    method: 'gphis.cura.waiting_room.update_entry_status',
                    args: { entry: e.name, new_status: $(this).data('action') },
                    callback: load_entries,
                });
            });
        });
    }

    frappe.realtime.on('waiting_room_update', load_entries);
    load_entries();
};
