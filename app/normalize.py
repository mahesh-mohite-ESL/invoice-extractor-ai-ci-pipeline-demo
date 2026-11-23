"""Turns the strings printed on an invoice into typed values. Pure functions, no I/O."""

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from app.models import Invoice, LineItem, RawInvoice

_CURRENCY_ALIASES = {
    "$": "USD",
    "US$": "USD",
    "€": "EUR",
    "£": "GBP",
    "₹": "INR",
    "RS": "INR",
    "RS.": "INR",
}

_TEXT_DATE_FORMATS = ["%Y-%m-%d", "%d.%m.%Y", "%d %B %Y", "%d %b %Y", "%B %d, %Y", "%b %d, %Y"]
_NUMBER = re.compile(r"-?\d[\d.,]*")


def normalize_currency(text: str) -> str:
    """Returns the ISO 4217 code for a currency symbol or code as printed on the invoice."""
    value = text.strip().upper()
    return _CURRENCY_ALIASES.get(value, value)


def parse_amount(text: str) -> Decimal:
    """Parses a printed number such as "1,250.00" or "Rs. 1,18,000.00". Empty text means zero."""
    match = _NUMBER.search(text)
    if match is None:
        if text.strip() in ("", "-"):
            return Decimal("0")
        raise ValueError(f"not an amount: {text!r}")
    digits = match.group(0).rstrip(".,").replace(",", "")
    try:
        return Decimal(digits)
    except InvalidOperation as exc:
        raise ValueError(f"not an amount: {text!r}") from exc


def parse_date(text: str, day_first: bool = False) -> date | None:
    """Parses a printed date. `day_first` decides how 03/04/2026 is read. Empty text means no date."""
    value = text.strip()
    if not value:
        return None
    numeric = ["%d/%m/%Y", "%m/%d/%Y"] if day_first else ["%m/%d/%Y", "%d/%m/%Y"]
    numeric += [fmt.replace("/", "-") for fmt in numeric]
    for fmt in numeric + _TEXT_DATE_FORMATS:
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"not a date: {text!r}")


def clean_invoice_number(text: str) -> str:
    """Removes a leading label such as "No." or "#" that was captured with the number."""
    return text.strip().lstrip("#No.: ")


def clean_text(text: str) -> str:
    return " ".join(text.split())


def normalize_invoice(raw: RawInvoice) -> Invoice:
    currency = normalize_currency(raw.currency)
    return Invoice(
        invoice_number=clean_invoice_number(raw.invoice_number),
        vendor_name=clean_text(raw.vendor_name),
        invoice_date=parse_date(raw.invoice_date),
        due_date=parse_date(raw.due_date),
        currency=currency,
        line_items=[
            LineItem(
                description=clean_text(item.description),
                quantity=parse_amount(item.quantity),
                unit_price=parse_amount(item.unit_price),
                amount=parse_amount(item.amount),
            )
            for item in raw.line_items
        ],
        subtotal=parse_amount(raw.subtotal),
        discount=parse_amount(raw.discount),
        tax=parse_amount(raw.tax),
        total=parse_amount(raw.total),
    )
