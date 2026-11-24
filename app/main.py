"""HTTP API of the invoice extraction service."""

import json
import os
import re
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from app.extractor import CachedExtractor, ClaudeExtractor, ExtractionUnavailable, Extractor
from app.models import ExtractionResult, SampleInfo
from app.normalize import normalize_invoice
from app.validate import validate_invoice

ROOT = Path(__file__).resolve().parent.parent
SAMPLES_DIR = ROOT / "samples"
CACHE_DIR = SAMPLES_DIR / "cache"
STATIC_DIR = Path(__file__).resolve().parent / "static"

# Sample ids become file names, so anything but lower-case letters, digits and dashes is rejected.
SAMPLE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

# Uploaded invoices are held in memory only and never written to disk.
MAX_UPLOAD_BYTES = 5 * 1024 * 1024
PDF_MAGIC = b"%PDF-"

app = FastAPI(title="Invoice extractor", version="1.0.0")


def get_extractor() -> Extractor:
    live = ClaudeExtractor() if os.environ.get("ANTHROPIC_API_KEY") else None
    return CachedExtractor(CACHE_DIR, live=live)


def get_live_extractor() -> ClaudeExtractor | None:
    """The extractor for uploaded invoices: always Claude, never the cache. None without an API key."""
    return ClaudeExtractor() if os.environ.get("ANTHROPIC_API_KEY") else None


async def read_upload(request: Request) -> bytes:
    """Reads the request body and stops as soon as it exceeds MAX_UPLOAD_BYTES."""
    too_large = HTTPException(status_code=413, detail=f"The file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES:
        raise too_large
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_UPLOAD_BYTES:
            raise too_large
    return bytes(body)


def sample_path(sample_id: str) -> Path:
    if not SAMPLE_ID.fullmatch(sample_id):
        raise HTTPException(status_code=400, detail="Invalid sample id.")
    path = SAMPLES_DIR / f"{sample_id}.pdf"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Unknown sample.")
    return path


def sample_titles() -> dict[str, str]:
    index = SAMPLES_DIR / "index.json"
    return json.loads(index.read_text(encoding="utf-8")) if index.is_file() else {}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/config")
def config() -> dict[str, str]:
    """Settings the page needs. REPO_URL (e.g. https://github.com/you/repo) enables the bug link."""
    return {"repo_url": os.environ.get("REPO_URL", "").rstrip("/")}


@app.get("/samples")
def list_samples() -> list[SampleInfo]:
    titles = sample_titles()
    return [
        SampleInfo(id=path.stem, title=titles.get(path.stem, path.stem), pdf_url=f"/samples/{path.stem}.pdf")
        for path in sorted(SAMPLES_DIR.glob("*.pdf"))
    ]


@app.get("/samples/{sample_id}.pdf")
def sample_pdf(sample_id: str) -> FileResponse:
    return FileResponse(sample_path(sample_id), media_type="application/pdf")


@app.post("/extract/{sample_id}")
def extract(sample_id: str, refresh: bool = False, extractor: Extractor = Depends(get_extractor)) -> ExtractionResult:
    """Extracts a sample invoice. `refresh=true` calls Claude again instead of using the cached result."""
    path = sample_path(sample_id)
    try:
        raw, source = extractor.extract(sample_id, path.read_bytes(), refresh=refresh)
    except ExtractionUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    try:
        invoice = normalize_invoice(raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"The extracted invoice could not be normalised: {exc}") from exc
    return ExtractionResult(sample_id=sample_id, source=source, raw=raw, invoice=invoice, warnings=validate_invoice(invoice))


@app.post("/extract-upload")
async def extract_upload(request: Request, live: ClaudeExtractor | None = Depends(get_live_extractor)) -> ExtractionResult:
    """Extracts an uploaded invoice. The request body is the PDF itself (Content-Type: application/pdf).

    The file always goes to Claude; it is not cached and not stored in samples/.
    """
    pdf = await read_upload(request)
    if not pdf.startswith(PDF_MAGIC):
        raise HTTPException(status_code=400, detail="The uploaded file is not a PDF.")
    if live is None:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY is not set, so uploaded invoices cannot be extracted.")
    try:
        raw = await run_in_threadpool(live.extract_pdf, pdf)
    except ExtractionUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    try:
        invoice = normalize_invoice(raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"The extracted invoice could not be normalised: {exc}") from exc
    return ExtractionResult(sample_id="upload", source="claude", raw=raw, invoice=invoice, warnings=validate_invoice(invoice))


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html", media_type="text/html")
