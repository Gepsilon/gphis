"""Push OCR configuration into the Desk boot payload.

The widget needs to decide whether to render on every form load. Doing that
with a server call would put an HTTP round trip in front of every navigation,
so the profile map ships once with the boot info instead.
"""

import frappe


def boot_session(bootinfo):
    """Attach `bootinfo.ocr` — enabled profiles keyed by target DocType."""
    bootinfo.ocr = {"enabled": False, "profiles": {}}

    try:
        settings = frappe.get_cached_doc("OCR Settings")
    except Exception:
        # Before the first migrate the Single does not exist yet. The Desk must
        # still boot.
        return

    if not settings.enabled or not settings.show_widget:
        return

    profiles = frappe.get_all(
        "OCR Profile",
        filters={"enabled": 1},
        fields=["name", "profile_name", "document_type", "target_doctype", "on_apply", "template"],
    )

    by_doctype: dict[str, list] = {}
    for profile in profiles:
        by_doctype.setdefault(profile.target_doctype, []).append(
            {
                "name": profile.name,
                "label": profile.profile_name,
                "document_type": profile.document_type,
                "on_apply": profile.on_apply,
                "template": profile.template,
            }
        )

    bootinfo.ocr = {
        "enabled": True,
        "position": settings.widget_position or "Bottom Right",
        "profiles": by_doctype,
    }
