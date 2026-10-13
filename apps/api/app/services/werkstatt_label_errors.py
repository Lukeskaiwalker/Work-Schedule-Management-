"""Every exception of the Werkstatt label printer, in one leaf module.

The label services import each other in a web (renderers, materials, jobs,
session, transport, calibration). Exceptions that lived in one of them made
every other module import it just to name an error, and the first cycle
would have been an ImportError at startup. This module imports nothing from
the label services — only the standard library — so any of them can raise or
catch any of these without an import order to get right.

``werkstatt_labels`` and ``werkstatt_label_materials`` re-export the classes
they used to define, so ``wl.LabelPrinterUnreachable`` and
``from …werkstatt_label_materials import MaterialValidationError`` keep naming
the very same objects.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any


class LabelPrinterNotConfigured(RuntimeError):
    """No printer address configured — label printing is off for this deployment."""


class LabelPrinterUnreachable(RuntimeError):
    """Connecting or sending to the printer failed; str() is the address."""


class LabelFormatUnsupported(RuntimeError):
    """The requested format does not fit the material; str() is German."""


class LabelLayoutOutOfBounds(LabelFormatUnsupported):
    """An element would print outside the material (the coordinate guard)."""


class LabelPrinterBusy(RuntimeError):
    """The printer cannot take this job right now; str() is German.

    The base class is what the workflow and admin print routes catch: for the
    person printing a label the two reasons below read the same ("wait").
    """


class LabelPrinterSessionBusy(LabelPrinterBusy):
    """Another calibration session holds the printer."""

    def __init__(self, message: str, *, holder_name: str, since: datetime) -> None:
        super().__init__(message)
        self.holder_name = holder_name
        self.since = since  # the holder's acquired_at, aware UTC


class LabelPrinterIoBusy(LabelPrinterBusy):
    """The one-connection-at-a-time lock timed out."""


class DisallowedPrinterCommand(RuntimeError):
    """A calibration send contained a line outside the allow-list.

    A programming error, never a user error: every user-supplied text is
    mapped into the allowed character class before it reaches a command.
    """


class PatternUnsupported(ValueError):
    """The measuring pattern cannot be printed on this material (multi-lane)."""


class StaleRevision(RuntimeError):
    """The configuration changed since the caller read it."""

    def __init__(self, revision: int) -> None:
        super().__init__("Einstellungen wurden inzwischen geändert – bitte neu laden")
        self.revision = revision  # the current revision


class MaterialValidationError(ValueError):
    """Admin payload describes materials the printer cannot have; str() is German."""


class PrinterSettingsValidationError(ValueError):
    """Printer-level settings (baseline, row offset, staff switch) are invalid."""


class LabelRequestRefused(RuntimeError):
    """A request the label-printer endpoints refuse, with its HTTP answer attached.

    The calibration endpoints answer every refusal as
    ``{"detail": {"code", "message", …extra}}``; carrying status and code on
    the exception keeps that shape in one place (the router) instead of every
    service function building HTTP errors.
    """

    def __init__(self, status: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra

    def detail(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, **self.extra}
