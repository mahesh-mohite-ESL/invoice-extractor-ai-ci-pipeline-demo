"""Arithmetic and consistency checks on a normalised invoice. Pure functions, no I/O."""

from decimal import Decimal

from app.models import Invoice


def _money(value: Decimal) -> str:
    return f"{value:,.2f}"


def validate_invoice(invoice: Invoice) -> list[str]:
    """Returns human-readable warnings; an empty list means the invoice is consistent."""
    warnings: list[str] = []

    if not invoice.invoice_number:
        warnings.append("Invoice number is missing.")
    if invoice.invoice_date is None:
        warnings.append("Invoice date is missing.")
    if invoice.invoice_date and invoice.due_date and invoice.due_date < invoice.invoice_date:
        warnings.append("Due date is before the invoice date.")

    for index, item in enumerate(invoice.line_items, start=1):
        expected = item.quantity * item.unit_price
        if expected != item.amount:
            warnings.append(
                f"Line {index}: {item.quantity} x {item.unit_price} = {expected}, but the invoice says {_money(item.amount)}."
            )

    line_total = sum((item.amount for item in invoice.line_items), Decimal("0"))
    if invoice.line_items and line_total != invoice.subtotal:
        warnings.append(f"Line items add up to {_money(line_total)}, but the subtotal is {_money(invoice.subtotal)}.")

    expected_total = invoice.subtotal + invoice.tax
    if expected_total != invoice.total:
        warnings.append(f"Subtotal and tax give {_money(expected_total)}, but the total is {_money(invoice.total)}.")

    return warnings
