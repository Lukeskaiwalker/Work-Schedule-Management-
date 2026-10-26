"""The label exceptions live in one leaf module.

Every label service raises or catches the same exceptions; if they lived in
one of the services, the first import cycle would be an ImportError at
startup. What must hold: the leaf module imports no label service, the old
import paths name the very same classes, and the two "busy" situations share
the base class the print routes catch.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from app.services import werkstatt_label_errors as errors
from app.services import werkstatt_label_materials as materials
from app.services import werkstatt_labels as wl

API_ROOT = Path(__file__).resolve().parents[1]


def test_errors_module_imports_no_label_service() -> None:
    probe = (
        "import sys\n"
        "import app.services.werkstatt_label_errors\n"
        "loaded = sorted(m for m in sys.modules if m.startswith('app.services.werkstatt_label') and m != 'app.services.werkstatt_label_errors')\n"
        "print(','.join(loaded))\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], cwd=API_ROOT, capture_output=True, text=True, check=True
    )
    assert result.stdout.strip() == ""


def test_old_import_paths_name_the_same_classes() -> None:
    assert wl.LabelPrinterUnreachable is errors.LabelPrinterUnreachable
    assert wl.LabelPrinterNotConfigured is errors.LabelPrinterNotConfigured
    assert wl.LabelFormatUnsupported is errors.LabelFormatUnsupported
    assert wl.LabelLayoutOutOfBounds is errors.LabelLayoutOutOfBounds
    assert wl.LabelPrinterBusy is errors.LabelPrinterBusy
    assert materials.MaterialValidationError is errors.MaterialValidationError
    assert materials.StaleRevision is errors.StaleRevision


def test_busy_subclasses_share_the_base_the_routes_catch() -> None:
    assert issubclass(errors.LabelPrinterSessionBusy, errors.LabelPrinterBusy)
    assert issubclass(errors.LabelPrinterIoBusy, errors.LabelPrinterBusy)
    assert issubclass(errors.LabelLayoutOutOfBounds, errors.LabelFormatUnsupported)
