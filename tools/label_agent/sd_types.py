"""The one value object :mod:`sd_formats` and :mod:`sd_parsers` both need.

Its own module so the two can import it without importing each other, which
is the shortest way to keep "what is this file?" and "what is inside it?"
genuinely separable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List

__all__ = ["ParseOutcome"]


@dataclass
class ParseOutcome:
    """The result of trying to read a file's structure.

    ``ok`` false is not an error condition. By the time any parser runs, the
    file it describes has already been copied byte-for-byte and hashed, so
    "we could not read this" costs a note in the manifest and nothing else.
    """

    ok: bool
    note: str = ""
    records: List[Dict[str, Any]] = field(default_factory=list)
