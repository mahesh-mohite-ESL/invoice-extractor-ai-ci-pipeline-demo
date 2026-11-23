def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_samples_are_listed_with_titles_and_pdf_links(client):
    samples = client.get("/samples").json()
    by_id = {s["id"]: s for s in samples}
    assert "zenith-inr" in by_id
    assert by_id["zenith-inr"]["title"] == "Zenith Consulting (INR)"
    assert by_id["zenith-inr"]["pdf_url"] == "/samples/zenith-inr.pdf"


def test_sample_pdf_is_served(client):
    response = client.get("/samples/zenith-inr.pdf")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.content.startswith(b"%PDF")


def test_extract_returns_raw_and_normalised_invoice(client):
    response = client.post("/extract/zenith-inr")
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "fixture"
    assert body["raw"]["total"] == "59,000.00"
    assert body["invoice"]["total"] == "59000.00"
    assert body["invoice"]["invoice_date"] == "2026-11-14"
    assert body["warnings"] == []


def test_extract_rejects_ids_that_are_not_plain_names(client):
    assert client.post("/extract/Zenith_INR").status_code == 400
    assert client.post("/extract/..%2Fpyproject").status_code in (400, 404)
    assert client.get("/samples/..%5Csecret.pdf").status_code in (400, 404)


def test_extract_unknown_sample_is_404(client):
    assert client.post("/extract/no-such-invoice").status_code == 404


def test_extract_without_a_result_is_503(client):
    # The sample exists, but the fake extractor has no fixture for it.
    assert client.post("/extract/nova-gbp").status_code == 503


def test_index_page_is_served(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "Invoice extractor" in response.text
