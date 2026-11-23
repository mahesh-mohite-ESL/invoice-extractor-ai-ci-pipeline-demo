"""Re-extracts every sample invoice with Claude and overwrites samples/cache/*.json.

    ANTHROPIC_API_KEY=... python tools/refresh_cache.py [sample-id ...]

Costs a few cents per run. Compare the result with the PDFs before committing it.
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.extractor import ClaudeExtractor, ExtractionUnavailable, write_cache  # noqa: E402


def main() -> int:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY is not set.", file=sys.stderr)
        return 1
    wanted = set(sys.argv[1:])
    extractor = ClaudeExtractor()
    failed = 0
    for pdf in sorted((ROOT / "samples").glob("*.pdf")):
        if wanted and pdf.stem not in wanted:
            continue
        try:
            raw = extractor.extract_pdf(pdf.read_bytes())
        except ExtractionUnavailable as exc:
            print(f"{pdf.stem}: FAILED - {exc}", file=sys.stderr)
            failed += 1
            continue
        write_cache(ROOT / "samples" / "cache" / f"{pdf.stem}.json", pdf.stem, raw, source="claude", model=extractor.model)
        print(f"{pdf.stem}: {raw.invoice_number} / {raw.total}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
