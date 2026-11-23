from datetime import date
from decimal import Decimal

import pytest

from app.normalize import clean_invoice_number, clean_text, normalize_currency, normalize_invoice, parse_amount, parse_date
from tests.conftest import load_raw


def test_parse_amount_reads_thousands_separators():
    assert parse_amount("1,250.00") == Decimal("1250.00")
    assert parse_amount("1,18,000.00") == Decimal("118000.00")


def test_parse_amount_ignores_currency_text_around_the_number():
    assert parse_amount("Rs. 9,000.00") == Decimal("9000.00")
    assert parse_amount("$ 80.00") == Decimal("80.00")


def test_parse_amount_treats_empty_text_as_zero():
    assert parse_amount("") == Decimal("0")
    assert parse_amount("-") == Decimal("0")


def test_parse_amount_rejects_text_without_a_number():
    with pytest.raises(ValueError):
        parse_amount("n/a")


def test_parse_date_reads_written_month_names():
    assert parse_date("14 Nov 2026") == date(2026, 11, 14)
    assert parse_date("5 November 2026") == date(2026, 11, 5)
    assert parse_date("Oct 28, 2026") == date(2026, 10, 28)


def test_parse_date_reads_iso_and_dotted_dates():
    assert parse_date("2026-11-20") == date(2026, 11, 20)
    assert parse_date("12.11.2026") == date(2026, 11, 12)


def test_parse_date_reads_slash_dates_in_the_requested_order():
    assert parse_date("03/04/2026", day_first=True) == date(2026, 4, 3)
    assert parse_date("03/04/2026", day_first=False) == date(2026, 3, 4)


def test_parse_date_falls_back_when_the_requested_order_is_impossible():
    assert parse_date("11/20/2026", day_first=True) == date(2026, 11, 20)


def test_parse_date_treats_empty_text_as_no_date():
    assert parse_date("  ") is None


def test_parse_date_rejects_text_that_is_not_a_date():
    with pytest.raises(ValueError):
        parse_date("next week")


def test_normalize_currency_maps_symbols_to_iso_codes():
    assert normalize_currency("$") == "USD"
    assert normalize_currency("Rs.") == "INR"
    assert normalize_currency(" eur ") == "EUR"


def test_clean_invoice_number_removes_a_leading_label():
    assert clean_invoice_number("No. ZC-2026-118") == "ZC-2026-118"
    assert clean_invoice_number("# INV-10021 ") == "INV-10021"


def test_clean_text_collapses_whitespace():
    assert clean_text("  Acme   Cloud\nServices ") == "Acme Cloud Services"


def test_normalize_invoice_converts_every_field():
    invoice = normalize_invoice(load_raw("zenith-inr"))
    assert invoice.invoice_number == "ZC-2026-118"
    assert invoice.vendor_name == "Zenith Consulting Pvt. Ltd."
    assert invoice.invoice_date == date(2026, 11, 14)
    assert invoice.due_date == date(2026, 12, 14)
    assert invoice.currency == "INR"
    assert invoice.line_items[0].quantity == Decimal("2")
    assert invoice.line_items[0].amount == Decimal("50000.00")
    assert invoice.discount == Decimal("0")
    assert invoice.total == Decimal("59000.00")
