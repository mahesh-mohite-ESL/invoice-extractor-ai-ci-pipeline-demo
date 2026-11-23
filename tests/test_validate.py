from datetime import date
from decimal import Decimal

from app.normalize import normalize_invoice
from app.validate import validate_invoice
from tests.conftest import load_raw


def consistent_invoice():
    return normalize_invoice(load_raw("acme-usd"))


def test_consistent_invoice_has_no_warnings():
    assert validate_invoice(consistent_invoice()) == []


def test_missing_invoice_number_is_reported():
    invoice = consistent_invoice().model_copy(update={"invoice_number": ""})
    assert "Invoice number is missing." in validate_invoice(invoice)


def test_due_date_before_invoice_date_is_reported():
    invoice = consistent_invoice().model_copy(update={"due_date": date(2026, 1, 1)})
    assert "Due date is before the invoice date." in validate_invoice(invoice)


def test_wrong_line_amount_is_reported():
    invoice = consistent_invoice()
    invoice.line_items[1].amount = Decimal("310.00")
    warnings = validate_invoice(invoice)
    assert any(w.startswith("Line 2:") for w in warnings)


def test_subtotal_that_differs_from_the_line_items_is_reported():
    invoice = consistent_invoice().model_copy(update={"subtotal": Decimal("1500.00"), "total": Decimal("1624.00")})
    warnings = validate_invoice(invoice)
    assert any(w.startswith("Line items add up to 1,550.00") for w in warnings)


def test_wrong_total_is_reported():
    invoice = consistent_invoice().model_copy(update={"total": Decimal("1700.00")})
    warnings = validate_invoice(invoice)
    assert any("the total is 1,700.00" in w for w in warnings)
