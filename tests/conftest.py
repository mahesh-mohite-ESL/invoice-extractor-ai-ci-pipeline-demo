"""Shared test helpers. Tests never call the Claude API: the fake extractor reads tests/fixtures."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.extractor import ExtractionUnavailable
from app.main import app, get_extractor
from app.models import RawInvoice

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def load_raw(name: str) -> RawInvoice:
    return RawInvoice.model_validate(json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8")))


class FakeExtractor:
    def extract(self, sample_id: str, pdf: bytes, refresh: bool = False) -> tuple[RawInvoice, str]:
        path = FIXTURES / f"{sample_id}.json"
        if not path.is_file():
            raise ExtractionUnavailable(f"No fixture for {sample_id}.")
        return load_raw(sample_id), "fixture"


@pytest.fixture
def client():
    app.dependency_overrides[get_extractor] = FakeExtractor
    yield TestClient(app)
    app.dependency_overrides.clear()
