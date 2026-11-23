"""Data models.

`RawInvoice` is what the extractor returns: every value as a string, exactly as printed on the
invoice. `Invoice` is the normalised form the API returns (dates, decimals, ISO currency code).
"""

from datetime import date
from decimal import Decimal

from pydantic import BaseModel, ConfigDict


class RawLineItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    description: str
    quantity: str
    unit_price: str
    amount: str


class RawInvoice(BaseModel):
    model_config = ConfigDict(extra="forbid")

    invoice_number: str
    vendor_name: str
    invoice_date: str
    due_date: str
    currency: str
    line_items: list[RawLineItem]
    subtotal: str
    discount: str
    tax: str
    total: str


class LineItem(BaseModel):
    description: str
    quantity: Decimal
    unit_price: Decimal
    amount: Decimal


class Invoice(BaseModel):
    invoice_number: str
    vendor_name: str
    invoice_date: date | None
    due_date: date | None
    currency: str
    line_items: list[LineItem]
    subtotal: Decimal
    discount: Decimal
    tax: Decimal
    total: Decimal


class ExtractionResult(BaseModel):
    sample_id: str
    source: str
    raw: RawInvoice
    invoice: Invoice
    warnings: list[str]


class SampleInfo(BaseModel):
    id: str
    title: str
    pdf_url: str
