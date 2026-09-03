"""HTTP client for the OCR Platform.

The only place in this app that knows the OCR service exists. Callers work with
dicts; if the platform's transport changes, this file changes and nothing else.

Configuration comes from the OCR Settings DocType, so the same code runs in
every topology — only the Base URL differs:

  · bench start on the host      ->  http://localhost:8080
  · Frappe in Docker, same box   ->  http://ocr-platform:8080
  · Remote or hosted platform    ->  https://ocr.example.com
"""

import frappe
import requests
from frappe import _

# An OCR call is a GPU round trip plus upload time over what may be a slow
# clinic connection. Generous, but not unbounded.
REQUEST_TIMEOUT = 60
# Metadata calls are cheap and should fail fast rather than hang a form.
META_TIMEOUT = 10
# The playground can ask for every strategy on a multi-page document, and the
# VL tier alone runs ~2-4s per page on a warm GPU — plus a cold sidecar's
# first inference, which is minutes. A scan timing out is an annoyance; a
# comparison run timing out halfway is useless data.
ANALYZE_TIMEOUT = 300


class OCRError(frappe.ValidationError):
    """Any failure talking to the OCR platform."""


class OCRQuotaExceeded(OCRError):
    """Account is out of credits. Distinct so the UI can offer an upgrade."""


def get_settings():
    return frappe.get_cached_doc("OCR Settings")


def get_connection() -> tuple[str, str]:
    """Return (base_url, api_key) or raise with an actionable message."""
    settings = get_settings()

    if not settings.enabled:
        frappe.throw(_("OCR is disabled in OCR Settings."), exc=OCRError)

    if not settings.base_url:
        frappe.throw(_("Set the Base URL in OCR Settings."), exc=OCRError)

    api_key = settings.get_password("api_key", raise_exception=False)
    if not api_key:
        frappe.throw(_("Set the API Key in OCR Settings."), exc=OCRError)

    return settings.base_url.rstrip("/"), api_key


def handle_error(response: requests.Response) -> None:
    """Turn an HTTP error into a message a user can act on."""
    if response.status_code == 402:
        try:
            detail = response.json().get("detail", {})
        except Exception:
            detail = {}
        frappe.throw(
            _("OCR quota exhausted: {0} credits left, this scan needs {1}. Renews {2}.").format(
                detail.get("credits_remaining", "?"),
                detail.get("credits_required", "?"),
                (detail.get("period_end") or "")[:10] or _("unknown"),
            ),
            exc=OCRQuotaExceeded,
        )

    if response.status_code == 401:
        frappe.throw(_("The OCR API key was rejected. Check it in OCR Settings."), exc=OCRError)

    if response.status_code == 413:
        frappe.throw(_("That image is too large for the OCR service."), exc=OCRError)

    try:
        detail = response.json().get("detail")
    except Exception:
        detail = response.text[:200]

    frappe.throw(
        _("OCR request failed ({0}): {1}").format(response.status_code, detail), exc=OCRError
    )


def _request(method: str, path: str, timeout: int, **kwargs) -> dict:
    base_url, api_key = get_connection()
    url = f"{base_url}{path}"

    try:
        response = requests.request(
            method, url, headers={"X-API-Key": api_key}, timeout=timeout, **kwargs
        )
    except requests.Timeout:
        frappe.throw(_("The OCR service did not respond in time."), exc=OCRError)
    except requests.ConnectionError:
        frappe.throw(_("Could not reach the OCR service at {0}.").format(base_url), exc=OCRError)

    if not response.ok:
        handle_error(response)

    return response.json()


def run_ocr(
    file_content: bytes,
    filename: str = "upload.jpg",
    lang: str = "en",
    mode: str = "balanced",
    min_confidence: float = 0.0,
) -> dict:
    """Send an image to the platform and return the parsed response."""
    return _request(
        "POST",
        "/v1/ocr",
        REQUEST_TIMEOUT,
        files={"file": (filename, file_content)},
        params={"lang": lang, "mode": mode, "min_confidence": min_confidence},
    )


def get_account() -> dict:
    """Plan and credit balance."""
    return _request("GET", "/v1/account", META_TIMEOUT)


# --- templates ------------------------------------------------------------


def list_templates() -> dict:
    """Templates this account may use: platform built-ins plus its own."""
    return _request("GET", "/v1/templates", META_TIMEOUT)


def create_template(payload: dict, image_bytes: bytes, filename: str = "reference.png") -> dict:
    import json as _json

    return _request(
        "POST",
        "/v1/templates",
        REQUEST_TIMEOUT,
        files={"file": (filename, image_bytes)},
        data={"template": _json.dumps(payload, ensure_ascii=False)},
    )


def update_template(template_id: int, payload: dict) -> dict:
    import json as _json

    return _request(
        "PUT",
        f"/v1/templates/{template_id}",
        REQUEST_TIMEOUT,
        data={"template": _json.dumps(payload, ensure_ascii=False)},
    )


def extract_with_template(
    template_id: int, file_content: bytes, filename: str = "upload.jpg", mode: str = "balanced"
) -> dict:
    """Run template-driven extraction: named fields plus table rows."""
    return _request(
        "POST",
        "/v1/documents/extract",
        REQUEST_TIMEOUT,
        files={"file": (filename, file_content)},
        params={"template_id": template_id, "mode": mode},
    )


def analyze(
    file_content: bytes,
    filename: str = "upload.jpg",
    strategy: str = "auto",
    mode: str = "balanced",
    template_id: int = None,
    lang: str = None,
) -> dict:
    """Run one extraction strategy and get back every tier's outcome.

    `/v1/documents/extract` applies a template and reports what it found.
    This reports *how* — which rungs of the ladder ran, which produced a
    table, which reconciled arithmetically, and what each cost. That is what
    the playground needs to compare strategies rather than just display one.

    A VL run is slower than a template run by seconds, not milliseconds, so
    this deliberately does not share REQUEST_TIMEOUT's assumptions.
    """
    params = {"strategy": strategy, "mode": mode}
    if template_id:
        params["template_id"] = int(template_id)
    if lang:
        params["lang"] = lang

    return _request(
        "POST",
        "/v1/documents/analyze",
        ANALYZE_TIMEOUT,
        files={"file": (filename, file_content)},
        params=params,
    )


def get_usage() -> dict:
    """Usage for the current billing period."""
    return _request("GET", "/v1/account/usage", META_TIMEOUT)


def ping() -> dict:
    """Unauthenticated liveness check.

    Deliberately does not go through _request: this is what "Test Connection"
    calls first, and it must be able to tell "the service is unreachable" apart
    from "the key is wrong".
    """
    settings = get_settings()
    base_url = (settings.base_url or "").rstrip("/")
    if not base_url:
        frappe.throw(_("Set the Base URL in OCR Settings."), exc=OCRError)

    try:
        response = requests.get(f"{base_url}/health", timeout=META_TIMEOUT)
    except requests.RequestException as exc:
        frappe.throw(
            _("Could not reach the OCR service at {0}: {1}").format(base_url, exc), exc=OCRError
        )

    if not response.ok:
        frappe.throw(
            _("OCR service at {0} returned {1}.").format(base_url, response.status_code),
            exc=OCRError,
        )

    return response.json()
