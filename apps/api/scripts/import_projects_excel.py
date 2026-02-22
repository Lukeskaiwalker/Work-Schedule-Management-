from __future__ import annotations

import argparse
from pathlib import Path

from app.core.db import SessionLocal
from app.services.project_import import import_projects_from_excel


def main() -> None:
    parser = argparse.ArgumentParser(description="Import projects from an Excel file into the SMPL database")
    parser.add_argument("--file", required=True, help="Path to .xlsx file")
    parser.add_argument("--sheet", default=None, help="Optional sheet name")
    parser.add_argument("--source-label", default=None, help="Optional source label stored in project.extra_attributes")
    args = parser.parse_args()

    file_path = Path(args.file)
    if not file_path.exists():
        raise SystemExit(f"File not found: {file_path}")

    db = SessionLocal()
    try:
        stats = import_projects_from_excel(
            db,
            str(file_path),
            sheet_name=args.sheet,
            source_label=args.source_label or file_path.name,
        )
    finally:
        db.close()

    print(
        "Import completed: "
        f"processed={stats.processed_rows}, created={stats.created}, "
        f"updated={stats.updated}, temporary_numbers={stats.temporary_numbers}, "
        f"duplicates_skipped={stats.duplicates_skipped}"
    )


if __name__ == "__main__":
    main()
