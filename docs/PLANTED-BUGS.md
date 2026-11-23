# Planted bugs (spoilers)

The service ships with five deliberate defects so the bug auto-fix workflow has something real to
do. Each one is visible on exactly one sample invoice. The other two samples (`acme-usd`,
`zenith-inr`) are correct.

To try one: open **Issues > New issue > Bug report**, paste the text, add the label `claude-autofix`.

| # | Sample | What you see | What is right | Where |
|---|---|---|---|---|
| 1 | `bharat-inr` | Invoice date 2026-03-04, due date 2026-03-05 | 2026-04-03 and 2026-05-03: an Indian invoice prints day/month/year | `app/normalize.py` |
| 2 | `muller-eur` | Subtotal 1.60, total 1.90, two warnings | 1600.00 and 1904.00: `1.600,00` uses a decimal comma | `app/normalize.py` |
| 3 | `nova-gbp` | Invoice number `OVA-2041` | `NOVA-2041` | `app/normalize.py` |
| 4 | `orbit-discount` | Warning "Subtotal and tax give 1,128.60, but the total is 1,020.60" | No warning: 1,080.00 - 108.00 discount + 48.60 tax = 1,020.60 | `app/validate.py` |
| 5 | `pioneer-qty` | Warning "Line 1: 2.5 x 19.99 = 49.975, but the invoice says 49.98" | No warning: 49.975 rounds to 49.98 | `app/validate.py` |

## Ready-to-paste reports

**1 - Wrong invoice date on the Bharat Office Supplies invoice**

> Sample: bharat-inr. Field: Invoice date and due date.
> The service shows invoice date 2026-03-04 and due date 2026-03-05. The PDF prints 03/04/2026 and
> 03/05/2026, and this is an Indian invoice in INR, so the dates are 3 April 2026 and 3 May 2026.

**2 - Amounts on the Müller invoice are off by a factor of 1000**

> Sample: muller-eur. Field: Subtotal, tax, total and line amounts.
> The service shows subtotal 1.60 and total 1.90. The PDF says 1.600,00 and 1.904,00, which is the
> German way of writing 1600.00 and 1904.00. The unit price 87,50 is shown as 8750.

**3 - First letter of the invoice number is missing**

> Sample: nova-gbp. Field: Invoice number.
> The service shows OVA-2041. The PDF says NOVA-2041.

**4 - False total warning when an invoice has a discount**

> Sample: orbit-discount. Field: warning "Subtotal and tax give 1,128.60, but the total is 1,020.60".
> The invoice is correct: subtotal 1,080.00 minus discount 108.00 plus tax 48.60 is 1,020.60.
> The check seems to ignore the discount.

**5 - False line warning for a fractional quantity**

> Sample: pioneer-qty. Field: warning "Line 1: 2.5 x 19.99 = 49.975, but the invoice says 49.98".
> 49.975 rounded to cents is 49.98, so the invoice is correct and there should be no warning.

## A report that should be handed over

> Title: Extraction feels wrong
> (no further details)

Expected: no pull request, label `claude-needs-human`, and a comment asking what is wrong.
