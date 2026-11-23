"""HTTP API of the invoice extraction service."""

import json
import os
import re
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse

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

app = FastAPI(title="Invoice extractor", version="1.0.0")


def get_extractor() -> Extractor:
    live = ClaudeExtractor() if os.environ.get("ANTHROPIC_API_KEY") else None
    return CachedExtractor(CACHE_DIR, live=live)


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


@app.get("/debug/cache/{name:path}")
def debug_cache(name: str) -> FileResponse:
    """Returns a cached extraction file, for troubleshooting."""
    return FileResponse(CACHE_DIR / name)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html", media_type="text/html")
