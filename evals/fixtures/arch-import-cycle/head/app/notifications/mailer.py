"""Outbound transactional email."""

from __future__ import annotations

import logging
from functools import lru_cache

from app.billing.invoices import Invoice, format_amount
from app.config import load_settings
from app.notifications.transport import EmailTransport, SmtpTransport

log = logging.getLogger(__name__)


class Mailer:
    def __init__(self, transport: EmailTransport, sender: str) -> None:
        self._transport = transport
        self._sender = sender

    def send_receipt(self, invoice: Invoice, to: str) -> None:
        subject = f"Receipt for invoice {invoice.number}"
        body = f"We received your payment of {format_amount(invoice.total, invoice.currency)}."
        self._transport.send(self._sender, to, subject, body)
        log.info("receipt sent", extra={"invoice": invoice.number})

    def send_invoice_issued(self, invoice: Invoice, to: str) -> None:
        subject = f"Invoice {invoice.number}"
        body = (
            f"Invoice {invoice.number} for {format_amount(invoice.total, invoice.currency)} "
            f"was issued on {invoice.issued_on:%d %B %Y}."
        )
        self._transport.send(self._sender, to, subject, body)
        log.info("invoice issued email sent", extra={"invoice": invoice.number})


@lru_cache(maxsize=1)
def get_mailer() -> Mailer:
    settings = load_settings()
    return Mailer(SmtpTransport(settings.smtp_url), settings.mail_sender)
