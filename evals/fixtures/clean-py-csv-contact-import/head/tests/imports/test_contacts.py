import io

import pytest

from app.imports.contacts import Contact, ImportFormatError, RowError, parse_contacts


def _csv(text: str) -> io.StringIO:
    return io.StringIO(text.strip() + "\n")


def test_valid_rows_become_contacts():
    result = parse_contacts(
        _csv(
            """
email,first_name,last_name,company
Ada@Example.com,Ada,Lovelace,Analytical Engines
grace@example.org,Grace,Hopper,
"""
        )
    )

    assert result.ok
    assert result.contacts == [
        Contact("ada@example.com", "Ada", "Lovelace", company="Analytical Engines"),
        Contact("grace@example.org", "Grace", "Hopper"),
    ]


def test_all_row_errors_are_reported_with_spreadsheet_line_numbers():
    result = parse_contacts(
        _csv(
            """
email,first_name,last_name
ada@example.com,Ada,Lovelace
not-an-email,Bob,Smith
,Carol,Jones
ADA@example.com,Ada,Again
"""
        )
    )

    assert [c.email for c in result.contacts] == ["ada@example.com"]
    assert result.errors == [
        RowError(3, "not an email address: 'not-an-email'"),
        RowError(4, "empty required field: email"),
        RowError(5, "duplicate email, first seen on line 2"),
    ]


def test_missing_required_columns_reject_the_whole_file():
    with pytest.raises(ImportFormatError, match="missing required columns: last_name"):
        parse_contacts(_csv("email,first_name\nada@example.com,Ada"))


def test_row_limit():
    rows = "\n".join(f"user{i}@example.com,U,{i}" for i in range(3))
    with pytest.raises(ImportFormatError, match="more than 2 rows"):
        parse_contacts(_csv("email,first_name,last_name\n" + rows), max_rows=2)
