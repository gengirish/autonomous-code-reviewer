"""Parse and validate contact CSV uploads before anything is written to the database."""

from __future__ import annotations

import csv
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field

REQUIRED_COLUMNS = ("email", "first_name", "last_name")
OPTIONAL_COLUMNS = ("company", "phone")
MAX_ROWS = 10_000


@dataclass(frozen=True)
class Contact:
    email: str
    first_name: str
    last_name: str
    company: str | None = None
    phone: str | None = None


@dataclass(frozen=True)
class RowError:
    line: int
    message: str


@dataclass
class ImportResult:
    contacts: list[Contact] = field(default_factory=list)
    errors: list[RowError] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


class ImportFormatError(ValueError):
    """The file as a whole is unusable (missing columns, too many rows)."""


def parse_contacts(lines: Iterable[str], max_rows: int = MAX_ROWS) -> ImportResult:
    """Validates every row and collects all errors, so the user can fix the file in one go.

    ``lines`` is a text stream (for example ``io.TextIOWrapper`` over the upload).
    Line numbers in errors are 1-based and count the header line, matching what a
    spreadsheet shows.
    """
    reader = csv.DictReader(lines)
    missing = [column for column in REQUIRED_COLUMNS if column not in (reader.fieldnames or [])]
    if missing:
        raise ImportFormatError(f"missing required columns: {', '.join(missing)}")

    result = ImportResult()
    seen_emails: dict[str, int] = {}
    for row in _limited(reader, max_rows):
        line = reader.line_num
        contact_or_error = _validate_row(row, line)
        if isinstance(contact_or_error, RowError):
            result.errors.append(contact_or_error)
            continue
        first_line = seen_emails.setdefault(contact_or_error.email, line)
        if first_line != line:
            result.errors.append(RowError(line, f"duplicate email, first seen on line {first_line}"))
            continue
        result.contacts.append(contact_or_error)
    return result


def _limited(reader: csv.DictReader[str], max_rows: int) -> Iterator[dict[str, str]]:
    for count, row in enumerate(reader, start=1):
        if count > max_rows:
            raise ImportFormatError(f"file has more than {max_rows} rows")
        yield row


def _validate_row(row: dict[str, str], line: int) -> Contact | RowError:
    values = {key: (row.get(key) or "").strip() for key in (*REQUIRED_COLUMNS, *OPTIONAL_COLUMNS)}
    empty = [column for column in REQUIRED_COLUMNS if not values[column]]
    if empty:
        return RowError(line, f"empty required field: {', '.join(empty)}")

    email = values["email"].lower()
    local, _, domain = email.partition("@")
    if not local or "." not in domain or " " in email:
        return RowError(line, f"not an email address: {values['email']!r}")

    return Contact(
        email=email,
        first_name=values["first_name"],
        last_name=values["last_name"],
        company=values["company"] or None,
        phone=values["phone"] or None,
    )
