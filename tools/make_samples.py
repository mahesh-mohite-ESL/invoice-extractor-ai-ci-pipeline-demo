"""Generates the synthetic sample invoices in samples/ (PDF, index.json and seed cache).

    python tools/make_samples.py

All vendors and figures are invented. The seed cache holds the values exactly as printed, so the
service works without an API key; `tools/refresh_cache.py` replaces it with real Claude output.
"""

import json
import sys
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.extractor import write_cache  # noqa: E402
from app.models import RawInvoice  # noqa: E402

SAMPLES = [
    {
        "id": "acme-usd",
        "title": "Acme Cloud Services (USD)",
        "address": "500 Harbor Street, Seattle, WA 98101, USA",
        "labels": ("INVOICE", "Invoice No:", "Invoice date:", "Due date:", "Currency:", "Subtotal", "Discount", "Sales tax (8%)", "Total"),
        "raw": {
            "invoice_number": "INV-10021",
            "vendor_name": "Acme Cloud Services Inc.",
            "invoice_date": "11/20/2026",
            "due_date": "12/20/2026",
            "currency": "USD",
            "line_items": [
                {"description": "Cloud hosting - November", "quantity": "1", "unit_price": "1,250.00", "amount": "1,250.00"},
                {"description": "Support plan", "quantity": "2", "unit_price": "150.00", "amount": "300.00"},
            ],
            "subtotal": "1,550.00",
            "discount": "",
            "tax": "124.00",
            "total": "1,674.00",
        },
    },
    {
        "id": "bharat-inr",
        "title": "Bharat Office Supplies (INR)",
        "address": "14 MG Road, Pune 411001, India",
        "labels": ("TAX INVOICE", "Invoice No:", "Invoice date:", "Due date:", "Currency:", "Subtotal", "Discount", "GST (18%)", "Total"),
        "raw": {
            "invoice_number": "BOS/2026/0457",
            "vendor_name": "Bharat Office Supplies Pvt. Ltd.",
            "invoice_date": "03/04/2026",
            "due_date": "03/05/2026",
            "currency": "INR",
            "line_items": [
                {"description": "Laser printer", "quantity": "2", "unit_price": "45,000.00", "amount": "90,000.00"},
                {"description": "Toner cartridge", "quantity": "10", "unit_price": "1,000.00", "amount": "10,000.00"},
            ],
            "subtotal": "1,00,000.00",
            "discount": "",
            "tax": "18,000.00",
            "total": "1,18,000.00",
        },
    },
    {
        "id": "muller-eur",
        "title": "Müller Maschinenbau (EUR)",
        "address": "Industriestraße 7, 70565 Stuttgart, Deutschland",
        "labels": ("RECHNUNG", "Rechnungsnr.:", "Rechnungsdatum:", "Fällig am:", "Währung:", "Zwischensumme", "Rabatt", "MwSt. (19%)", "Gesamtbetrag"),
        "raw": {
            "invoice_number": "RE-2026-0193",
            "vendor_name": "Müller Maschinenbau GmbH",
            "invoice_date": "12.11.2026",
            "due_date": "12.12.2026",
            "currency": "EUR",
            "line_items": [
                {"description": "Wartung Fräsmaschine", "quantity": "1", "unit_price": "1.250,00", "amount": "1.250,00"},
                {"description": "Ersatzteile", "quantity": "4", "unit_price": "87,50", "amount": "350,00"},
            ],
            "subtotal": "1.600,00",
            "discount": "",
            "tax": "304,00",
            "total": "1.904,00",
        },
    },
    {
        "id": "nova-gbp",
        "title": "Nova Analytics (GBP)",
        "address": "22 Castle Lane, Leeds LS1 4AP, United Kingdom",
        "labels": ("INVOICE", "Invoice No:", "Invoice date:", "Due date:", "Currency:", "Subtotal", "Discount", "VAT (20%)", "Total"),
        "raw": {
            "invoice_number": "NOVA-2041",
            "vendor_name": "Nova Analytics Ltd",
            "invoice_date": "5 November 2026",
            "due_date": "5 December 2026",
            "currency": "GBP",
            "line_items": [
                {"description": "Data audit (days)", "quantity": "3", "unit_price": "400.00", "amount": "1,200.00"},
            ],
            "subtotal": "1,200.00",
            "discount": "",
            "tax": "240.00",
            "total": "1,440.00",
        },
    },
    {
        "id": "orbit-discount",
        "title": "Orbit Logistics (USD, with discount)",
        "address": "910 Freight Avenue, Dallas, TX 75201, USA",
        "labels": ("INVOICE", "Invoice No:", "Invoice date:", "Due date:", "Currency:", "Subtotal", "Discount (10%)", "Sales tax (5%)", "Total"),
        "raw": {
            "invoice_number": "OL-88310",
            "vendor_name": "Orbit Logistics LLC",
            "invoice_date": "Oct 28, 2026",
            "due_date": "Nov 27, 2026",
            "currency": "USD",
            "line_items": [
                {"description": "Freight - pallet", "quantity": "8", "unit_price": "125.00", "amount": "1,000.00"},
                {"description": "Insurance", "quantity": "1", "unit_price": "80.00", "amount": "80.00"},
            ],
            "subtotal": "1,080.00",
            "discount": "108.00",
            "tax": "48.60",
            "total": "1,020.60",
        },
    },
    {
        "id": "pioneer-qty",
        "title": "Pioneer Fabrics (USD, fractional quantity)",
        "address": "37 Mill Road, Charlotte, NC 28202, USA",
        "labels": ("INVOICE", "Invoice No:", "Invoice date:", "Due date:", "Currency:", "Subtotal", "Discount", "Sales tax (0%)", "Total"),
        "raw": {
            "invoice_number": "PF-5572",
            "vendor_name": "Pioneer Fabrics Co.",
            "invoice_date": "November 3, 2026",
            "due_date": "December 3, 2026",
            "currency": "USD",
            "line_items": [
                {"description": "Cotton twill (metres)", "quantity": "2.5", "unit_price": "19.99", "amount": "49.98"},
                {"description": "Thread spool", "quantity": "12", "unit_price": "1.25", "amount": "15.00"},
            ],
            "subtotal": "64.98",
            "discount": "",
            "tax": "0.00",
            "total": "64.98",
        },
    },
    {
        "id": "zenith-inr",
        "title": "Zenith Consulting (INR)",
        "address": "8 Residency Road, Bengaluru 560025, India",
        "labels": ("TAX INVOICE", "Invoice No:", "Invoice date:", "Due date:", "Currency:", "Subtotal", "Discount", "GST (18%)", "Total"),
        "raw": {
            "invoice_number": "ZC-2026-118",
            "vendor_name": "Zenith Consulting Pvt. Ltd.",
            "invoice_date": "14 Nov 2026",
            "due_date": "14 Dec 2026",
            "currency": "INR",
            "line_items": [
                {"description": "Process review workshop", "quantity": "2", "unit_price": "25,000.00", "amount": "50,000.00"},
            ],
            "subtotal": "50,000.00",
            "discount": "",
            "tax": "9,000.00",
            "total": "59,000.00",
        },
    },
]


def draw(sample: dict, path: Path) -> None:
    raw = sample["raw"]
    heading, l_no, l_date, l_due, l_cur, l_sub, l_disc, l_tax, l_total = sample["labels"]
    width, height = A4
    c = canvas.Canvas(str(path), pagesize=A4, invariant=1)
    c.setTitle(f"{heading} {raw['invoice_number']}")

    c.setFont("Helvetica-Bold", 18)
    c.drawString(50, height - 60, raw["vendor_name"])
    c.setFont("Helvetica", 10)
    c.drawString(50, height - 76, sample["address"])
    c.setFont("Helvetica-Bold", 16)
    c.drawRightString(width - 50, height - 60, heading)

    c.setFont("Helvetica", 11)
    y = height - 120
    for label, value in ((l_no, raw["invoice_number"]), (l_date, raw["invoice_date"]), (l_due, raw["due_date"]), (l_cur, raw["currency"])):
        c.drawString(50, y, label)
        c.drawString(170, y, value)
        y -= 16

    y -= 20
    c.setFont("Helvetica-Bold", 11)
    c.drawString(50, y, "Description")
    c.drawRightString(340, y, "Qty")
    c.drawRightString(440, y, "Unit price")
    c.drawRightString(width - 50, y, "Amount")
    c.line(50, y - 5, width - 50, y - 5)
    c.setFont("Helvetica", 11)
    y -= 22
    for item in raw["line_items"]:
        c.drawString(50, y, item["description"])
        c.drawRightString(340, y, item["quantity"])
        c.drawRightString(440, y, item["unit_price"])
        c.drawRightString(width - 50, y, item["amount"])
        y -= 18
    c.line(50, y + 6, width - 50, y + 6)

    y -= 14
    totals = [(l_sub, raw["subtotal"])]
    if raw["discount"]:
        totals.append((l_disc, f"-{raw['discount']}"))
    totals.append((l_tax, raw["tax"]))
    for label, value in totals:
        c.drawRightString(440, y, label)
        c.drawRightString(width - 50, y, value)
        y -= 18
    c.setFont("Helvetica-Bold", 12)
    c.drawRightString(440, y, l_total)
    c.drawRightString(width - 50, y, f"{raw['currency']} {raw['total']}")

    c.setFont("Helvetica", 9)
    c.drawString(50, 50, "Synthetic sample invoice for demonstration. Not a real document.")
    c.save()


def main() -> None:
    out = ROOT / "samples"
    out.mkdir(exist_ok=True)
    for sample in SAMPLES:
        draw(sample, out / f"{sample['id']}.pdf")
        write_cache(out / "cache" / f"{sample['id']}.json", sample["id"], RawInvoice.model_validate(sample["raw"]), source="seed")
        print(f"wrote {sample['id']}")
    index = {sample["id"]: sample["title"] for sample in SAMPLES}
    (out / "index.json").write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
