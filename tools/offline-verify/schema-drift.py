#!/usr/bin/env python3
"""
Structural diff: prisma/schema.prisma  <->  a database built purely from
prisma/migrations.

`prisma migrate diff` needs the schema engine binary, which is not always
downloadable (restricted networks return 403 for binaries.prisma.sh). This
checker needs nothing but psql, and answers the question that actually
matters: does applying the migrations in order produce the tables and columns
the schema declares?

Usage:
    python3 tools/offline-verify/schema-drift.py "postgresql://.../edu"

Exit code 0 = no drift.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = ROOT / "prisma" / "schema.prisma"

SCALAR_TYPES = {
    "String", "Boolean", "Int", "BigInt", "Float", "Decimal",
    "DateTime", "Json", "Bytes",
}


def psql(dsn: str, sql: str) -> list[list[str]]:
    out = subprocess.run(
        ["psql", dsn, "-tAF", "\x1f", "-c", sql],
        capture_output=True, text=True, check=True,
    ).stdout
    return [line.split("\x1f") for line in out.splitlines() if line.strip()]


def parse_schema() -> tuple[dict[str, dict[str, str]], set[str]]:
    """Returns {table: {column: prisma_type}} and the set of enum names."""
    text = SCHEMA.read_text(encoding="utf-8")
    enums = set(re.findall(r"^enum\s+(\w+)\s*\{", text, re.M))

    models: dict[str, dict[str, str]] = {}
    for match in re.finditer(r"^model\s+(\w+)\s*\{(.*?)^\}", text, re.M | re.S):
        name, body = match.group(1), match.group(2)
        table = name
        mapped = re.search(r'@@map\("([^"]+)"\)', body)
        if mapped:
            table = mapped.group(1)

        columns: dict[str, str] = {}
        for line in body.splitlines():
            line = line.strip()
            if not line or line.startswith(("//", "///", "@@")):
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            field, ftype = parts[0], parts[1]
            if not re.fullmatch(r"\w+", field):
                continue

            base = ftype.rstrip("?").removesuffix("[]")
            is_list = ftype.endswith("[]")

            # Relation fields are not columns; their scalar FK fields are
            # declared separately and picked up on their own line.
            if base not in SCALAR_TYPES and base not in enums:
                continue
            # A list of a relation type is not a column either; a list of a
            # scalar/enum is (Postgres array).
            if is_list and base not in SCALAR_TYPES and base not in enums:
                continue

            column = field
            mapping = re.search(r'@map\("([^"]+)"\)', line)
            if mapping:
                column = mapping.group(1)
            columns[column] = base

        models[table] = columns

    return models, enums


def main() -> int:
    dsn = sys.argv[1] if len(sys.argv) > 1 else "postgresql://postgres@/edu"
    models, enums = parse_schema()

    db_tables = {row[0] for row in psql(dsn, """
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    """)}

    db_columns: dict[str, set[str]] = {}
    for table, column in psql(dsn, """
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
    """):
        db_columns.setdefault(table, set()).add(column)

    db_enums = {row[0] for row in psql(dsn, """
        SELECT typname FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typtype = 'e' AND n.nspname = 'public'
    """)}

    problems: list[str] = []

    ignored = {"_prisma_migrations"}
    for table in sorted(set(models) - db_tables):
        problems.append(f"table declared in schema but missing from migrations: {table}")
    for table in sorted(db_tables - set(models) - ignored):
        problems.append(f"table created by migrations but absent from schema: {table}")

    for table, columns in sorted(models.items()):
        if table not in db_tables:
            continue
        present = db_columns.get(table, set())
        for column in sorted(set(columns) - present):
            problems.append(f"{table}.{column}: in schema, not in database")
        for column in sorted(present - set(columns)):
            problems.append(f"{table}.{column}: in database, not in schema")

    for name in sorted(enums - db_enums):
        problems.append(f"enum declared in schema but missing from migrations: {name}")
    for name in sorted(db_enums - enums):
        problems.append(f"enum created by migrations but absent from schema: {name}")

    if problems:
        print(f"DRIFT — {len(problems)} problem(s):")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    print(
        f"No drift. {len(models)} tables, "
        f"{sum(len(c) for c in models.values())} columns, {len(enums)} enums."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
