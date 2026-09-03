# gphis/gphis/cura/boot.py

import frappe


def boot_session(bootinfo):
    """Runs on every Desk boot. Attaches Cura-specific config
    so the shell JS never needs a round-trip just to know what to show."""

    user_roles = frappe.get_roles(frappe.session.user)

    bootinfo.cura = {
        "licensed_modules": get_licensed_modules(),   # stub for now — Phase-later: real licensing
        "primary_role": get_primary_cura_role(user_roles),
        "branding": {
            "app_name": "Cura",
            # logo/favicon already handled via Website Settings per your intro
        },
    }


def get_licensed_modules():
    # Placeholder until the licensing system exists (your future phase).
    # Returning "all" for now so Phase 1 isn't blocked on it.
    return ["patients", "appointments", "billing", "laboratory", "radiology", "pharmacy"]


def get_primary_cura_role(user_roles):
    priority = ["System Manager", "Doctor", "Lab Technician", "Receptionist"]
    for role in priority:
        if role in user_roles:
            return role
    return None
