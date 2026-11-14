"""Invoice model and lifecycle."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from app.billing.numbering import next_invoice_number


@dataclass
class Invoice:
    customer_id: str
    currency: str
    lines: list[tuple[str, Decimal]] = field(default_factory=list)
    number: str | None = None
    issued_on: date | None = None

    @property
    def total(self) -> Decimal:
        return sum((amount for _, amount in self.lines), Decimal("0"))


def format_amount(amount: Decimal, currency: str) -> str:
    return f"{amount:,.2f} {currency}"


def finalize(invoice: Invoice, today: date, notify_email: str | None = None) -> Invoice:
    """Assigns the invoice number and issue date. An invoice can be finalized once.

    When ``notify_email`` is given, the customer is emailed that the invoice was issued.
    """
    if invoice.number is not None:
        raise ValueError("invoice already finalized")
    if not invoice.lines:
        raise ValueError("cannot finalize an empty invoice")
    invoice.number = next_invoice_number(today)
    invoice.issued_on = today
    if notify_email is not None:
        from app.notifications.mailer import get_mailer

        get_mailer().send_invoice_issued(invoice, notify_email)
    return invoice
