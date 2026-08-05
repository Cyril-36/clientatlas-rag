#!/usr/bin/env python3
"""Validate an evaluation dataset.

    python evals/validate_dataset.py evals/datasets/gitlab-handbook-v1

Standard library only, so anyone can run it without installing the project.

The checks exist because of one failure mode. Expectations are anchors —
verbatim substrings of the corpus — rather than chunk ids, since chunk ids are
regenerated on every ingest and a dataset pinning them would break the first
time anyone re-indexed. Anchors bring their own risk: one that matches nothing
fails silently, and that question then scores against an empty expectation for
ever, quietly flattering whatever retrieval does.

Exit code 0 when the dataset is sound, 1 otherwise.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

# Anchors shorter than this tend not to be unique in a large corpus; longer ones
# tend to straddle a chunk boundary and match nothing. Advisory, because
# uniqueness is the property that actually matters and is checked separately.
ANCHOR_MIN = 20
ANCHOR_MAX = 120

FORBIDDEN_IN_REAL_CORPUS = {"prompt_injection", "cross_tenant"}


def load(path: Path) -> dict[str, Any]:
    parsed: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return parsed


def document_texts(corpus: dict[str, Any]) -> dict[str, str]:
    """One searchable blob per document."""
    texts: dict[str, str] = {}

    for document in corpus["documents"]:
        parts = [
            paragraph for section in document["sections"] for paragraph in section["paragraphs"]
        ]
        texts[document["slug"]] = "\n".join(parts)

    return texts


def validate(directory: Path) -> tuple[list[str], list[str], dict[str, int]]:
    """Returns (errors, warnings, category counts)."""
    errors: list[str] = []
    warnings: list[str] = []

    corpus = load(directory / "corpus.json")
    questions_file = load(directory / "questions.json")
    questions = questions_file["questions"]

    texts = document_texts(corpus)
    is_real_corpus = any(document.get("sourceUrl") for document in corpus["documents"])

    seen_ids: set[str] = set()

    for question in questions:
        qid = question["id"]

        if qid in seen_ids:
            errors.append(f"{qid}: duplicate question id")
        seen_ids.add(qid)

        category = question["category"]
        answerable = question["answerable"]
        expected = question["expected"]

        if is_real_corpus and category in FORBIDDEN_IN_REAL_CORPUS:
            errors.append(
                f"{qid}: category '{category}' cannot come from an unmodified real corpus"
            )

        if not answerable and expected:
            errors.append(f"{qid}: unanswerable but carries expected evidence")

        if answerable and not expected and not question.get("askAsNonMember"):
            errors.append(f"{qid}: answerable but carries no expected evidence")

        if category == "multi_document":
            documents = {expectation["document"] for expectation in expected}
            if len(documents) < 2:
                errors.append(
                    f"{qid}: multi_document references {len(documents)} document(s), needs 2+"
                )

        for expectation in expected:
            slug = expectation["document"]
            anchor = expectation["mustContain"]

            if slug not in texts:
                errors.append(f"{qid}: no such document '{slug}'")
                continue

            if anchor not in texts[slug]:
                errors.append(f"{qid}: anchor not found in '{slug}': {anchor!r}")
                continue

            matches = [other for other, text in texts.items() if anchor in text]
            if len(matches) > 1:
                errors.append(
                    f"{qid}: anchor appears in {len(matches)} documents "
                    f"({', '.join(sorted(matches))}), so it identifies no single "
                    f"passage: {anchor!r}"
                )

            if not ANCHOR_MIN <= len(anchor) <= ANCHOR_MAX:
                warnings.append(
                    f"{qid}: anchor is {len(anchor)} characters, outside the "
                    f"{ANCHOR_MIN}-{ANCHOR_MAX} guidance: {anchor!r}"
                )

    counts = Counter(question["category"] for question in questions)

    paragraph_count = sum(
        len(section["paragraphs"])
        for document in corpus["documents"]
        for section in document["sections"]
    )

    minimum_documents = corpus.get("minDocuments")
    if minimum_documents and len(corpus["documents"]) < minimum_documents:
        errors.append(
            f"corpus has {len(corpus['documents'])} documents, "
            f"expected at least {minimum_documents}"
        )

    minimum_paragraphs = corpus.get("minParagraphs")
    if minimum_paragraphs and paragraph_count < minimum_paragraphs:
        errors.append(
            f"corpus has {paragraph_count} paragraphs, expected at least {minimum_paragraphs}"
        )

    return errors, warnings, dict(counts)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2

    directory = Path(sys.argv[1])

    if not (directory / "corpus.json").exists():
        print(f"no corpus.json in {directory}")
        return 2

    errors, warnings, counts = validate(directory)

    corpus = load(directory / "corpus.json")
    paragraphs = sum(
        len(section["paragraphs"])
        for document in corpus["documents"]
        for section in document["sections"]
    )

    print(f"dataset:    {directory.name}")
    print(f"documents:  {len(corpus['documents'])}")
    print(f"paragraphs: {paragraphs}")
    print("questions:")
    for category, count in sorted(counts.items()):
        print(f"  {category:22} {count}")

    for warning in warnings:
        print(f"WARN  {warning}")

    for error in errors:
        print(f"ERROR {error}")

    if errors:
        print(f"\n{len(errors)} error(s). The dataset is not usable as it stands.")
        return 1

    print(f"\nok — {sum(counts.values())} questions, {len(warnings)} warning(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
