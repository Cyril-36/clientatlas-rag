"""The evaluation dataset, checked against itself.

Two jobs.

First, it keeps the dataset honest. Every `mustContain` anchor has to actually
appear in the chunked corpus. Anchors are how the dataset survives re-indexing —
chunk ids are regenerated on every ingest, so a dataset pinning literal UUIDs
would break the first time anyone re-indexed — but an anchor that matches
nothing is worse than a UUID, because it fails silently and the question then
scores against an empty expectation for ever.

Second, it establishes a vector-only baseline before retrieval exists. If a
question cannot be found by embeddings alone that is worth knowing now, while
the dataset can still be revised, rather than after hybrid retrieval has been
tuned to hit it.

The baseline is skipped unless the ML extra is installed. It is a measurement,
not a gate.
"""

from __future__ import annotations

import hashlib
import json
import sys
from importlib.util import find_spec
from pathlib import Path
from typing import Any

import pytest

from app.ingestion.chunking import chunk_blocks
from app.ingestion.parsing import ParsedBlock

ROOT = Path(__file__).resolve().parents[3]
DATASET = ROOT / "evals" / "datasets" / "onboarding-v1"

HAS_ML = find_spec("sentence_transformers") is not None


def load(name: str) -> dict[str, Any]:
    parsed: dict[str, Any] = json.loads((DATASET / name).read_text(encoding="utf-8"))
    return parsed


def corpus_chunks() -> list[tuple[str, str]]:
    """(document slug, chunk text) for the whole corpus.

    Chunked with the real chunker, so the anchors are checked against the text
    retrieval will actually see rather than against the source paragraphs.
    """
    corpus = load("corpus.json")
    out: list[tuple[str, str]] = []

    for document in corpus["documents"]:
        blocks: list[ParsedBlock] = []
        ordinal = 0

        for section in document["sections"]:
            for paragraph in section["paragraphs"]:
                ordinal += 1
                blocks.append(
                    ParsedBlock(
                        ordinal=ordinal,
                        text=paragraph,
                        page_number=1,
                        heading_path=(section["heading"],),
                    )
                )

        for chunk in chunk_blocks(blocks):
            out.append((document["slug"], chunk.text))

    return out


class TestDatasetIntegrity:
    def test_every_anchor_resolves_to_a_chunk(self) -> None:
        chunks = corpus_chunks()
        questions = load("questions.json")["questions"]

        unresolved: list[str] = []

        for question in questions:
            for expectation in question["expected"]:
                match = any(
                    slug == expectation["document"] and expectation["mustContain"] in text
                    for slug, text in chunks
                )
                if not match:
                    unresolved.append(f"{question['id']} -> {expectation}")

        assert not unresolved, f"anchors matching nothing in the corpus: {unresolved}"

    def test_every_referenced_document_exists(self) -> None:
        slugs = {document["slug"] for document in load("corpus.json")["documents"]}
        questions = load("questions.json")["questions"]

        for question in questions:
            for expectation in question["expected"]:
                assert expectation["document"] in slugs, question["id"]

    def test_unanswerable_questions_carry_no_expectations(self) -> None:
        # An unanswerable question with expected evidence is a contradiction:
        # abstention cannot be correct if there was something to cite.
        for question in load("questions.json")["questions"]:
            if not question["answerable"]:
                assert question["expected"] == [], question["id"]

    def test_answerable_questions_carry_expectations(self) -> None:
        for question in load("questions.json")["questions"]:
            if question["answerable"] and not question.get("askAsNonMember"):
                assert question["expected"], question["id"]

    def test_question_ids_are_unique(self) -> None:
        ids = [question["id"] for question in load("questions.json")["questions"]]
        assert len(ids) == len(set(ids))

    def test_covers_the_planned_categories(self) -> None:
        # The categories exist to stop the set drifting into "questions that
        # happen to work". Losing one silently is the failure mode.
        required = {
            "factual",
            "multi_document",
            "conflicting",
            "missing",
            "ambiguous",
            "prompt_injection",
            "citation_correctness",
            "cross_tenant",
        }
        present = {question["category"] for question in load("questions.json")["questions"]}

        assert required <= present, f"missing categories: {required - present}"

    def test_the_injection_payload_is_actually_in_the_corpus(self) -> None:
        # A prompt-injection question is worthless if the corpus never carries
        # the payload. This is exactly the kind of thing that rots unnoticed.
        chunks = corpus_chunks()
        assert any("ignore all previous instructions" in text.lower() for _, text in chunks)

    def test_the_conflict_is_actually_contradictory(self) -> None:
        chunks = corpus_chunks()
        three = any("three working days" in text for _, text in chunks)
        five = any("five working days" in text for _, text in chunks)

        assert three and five, "the conflicting-information question needs both figures present"


@pytest.mark.skipif(not HAS_ML, reason="requires `uv sync --extra ml`")
class TestVectorBaseline:
    """What MiniLM alone can find, before any hybrid retrieval exists."""

    def test_reports_recall(self, capsys: pytest.CaptureFixture[str]) -> None:
        from app.embedding.provider import MiniLMProvider

        provider = MiniLMProvider()
        chunks = corpus_chunks()
        chunk_vectors = provider.embed([text for _, text in chunks])

        questions = [
            question
            for question in load("questions.json")["questions"]
            if question["answerable"]
            and question["expected"]
            and not question.get("askAsNonMember")
        ]
        question_vectors = provider.embed([question["question"] for question in questions])

        def recall_at(k: int) -> tuple[float, list[str]]:
            hits = 0
            misses: list[str] = []

            for question, query_vector in zip(questions, question_vectors, strict=True):
                scored = sorted(
                    (
                        (sum(a * b for a, b in zip(query_vector, vector, strict=True)), index)
                        for index, vector in enumerate(chunk_vectors)
                    ),
                    reverse=True,
                )
                top = [chunks[index] for _, index in scored[:k]]

                found = any(
                    slug == expectation["document"] and expectation["mustContain"] in text
                    for expectation in question["expected"]
                    for slug, text in top
                )

                if found:
                    hits += 1
                else:
                    misses.append(question["id"])

            return hits / len(questions), misses

        recall_1, missed_1 = recall_at(1)
        recall_3, _ = recall_at(3)
        recall_5, _ = recall_at(5)

        with capsys.disabled():
            print(f"\n  corpus chunks: {len(chunks)}")
            print(f"  vector-only recall@1: {recall_1:.2f}")
            print(f"  vector-only recall@3: {recall_3:.2f}")
            print(f"  vector-only recall@5: {recall_5:.2f}")
            if missed_1:
                print(f"  not top-1 by embeddings alone: {', '.join(missed_1)}")

        recall = recall_1

        assert recall >= 0.5, f"recall@5 {recall:.2f} suggests the dataset is mismatched"


class TestValidator:
    """The standalone validator, run over every dataset that exists.

    The same script is handed to whoever builds a dataset, so what they check
    before delivery and what CI checks on arrival are the same code. A dataset
    dropped into evals/datasets/ is picked up here automatically — including one
    this repository has never seen.
    """

    def test_every_dataset_validates(self) -> None:
        import subprocess

        datasets = sorted(
            path.parent for path in (ROOT / "evals" / "datasets").glob("*/corpus.json")
        )

        assert datasets, "no datasets found"

        for dataset in datasets:
            result = subprocess.run(
                [sys.executable, str(ROOT / "evals" / "validate_dataset.py"), str(dataset)],
                capture_output=True,
                text=True,
                check=False,
            )

            assert result.returncode == 0, f"{dataset.name} failed validation:\n{result.stdout}"


class TestSourceProvenance:
    """The source pages, pinned to the snapshot recorded in SHA256SUMS.

    What this proves, precisely: that nothing in `evals/datasets/*/source` has
    changed since the manifest was written. Each digest covers the whole local
    file, which is a ClientAtlas front-matter block followed by the upstream
    body, and it is compared against a manifest living in the same directory.
    That makes this tamper-evidence, not provenance — it cannot tell whether
    the snapshot matched GitLab in the first place, and re-running it never
    will.

    Provenance rests on a separate, earlier act: the 200 bodies were diffed
    against gitlab-com/content-sites/handbook commit `a2af0b1d` and matched.
    The manifest was written from that state, so it holds that verification in
    place rather than repeating it.

    Worth having anyway, because the failure it catches has happened twice.
    Prettier rewrote all 200 files, and later ruff 0.16 — which formats Python
    inside Markdown code fences — rewrote quote characters inside one. Both
    times review missed it, and both times the CC BY-SA attribution's
    "unmodified" claim became false. Configuration now excludes the directory
    from both formatters; configuration is a promise, and this is a check.
    """

    def manifests(self) -> list[Path]:
        return sorted((ROOT / "evals" / "datasets").glob("*/source/SHA256SUMS"))

    def test_there_is_a_manifest_for_every_source_tree(self) -> None:
        # Without this, deleting a manifest would silently disable the check
        # below rather than failing it.
        trees = sorted(
            path for path in (ROOT / "evals" / "datasets").glob("*/source") if path.is_dir()
        )
        assert trees, "no source trees found"

        for tree in trees:
            assert (tree / "SHA256SUMS").exists(), f"{tree} has no SHA256SUMS"

    def test_every_source_file_matches_its_recorded_checksum(self) -> None:
        for manifest in self.manifests():
            recorded: dict[str, str] = {}

            for line in manifest.read_text(encoding="utf-8").splitlines():
                if not line.strip() or line.startswith("#"):
                    continue
                digest, name = line.split(maxsplit=1)
                recorded[name.strip()] = digest

            assert recorded, f"{manifest} lists no files"

            present = {path.name for path in manifest.parent.glob("*.md")}
            assert present == set(recorded), (
                f"{manifest.parent} does not match its manifest: "
                f"added {sorted(present - set(recorded))}, "
                f"missing {sorted(set(recorded) - present)}"
            )

            modified = [
                name
                for name, digest in recorded.items()
                if hashlib.sha256((manifest.parent / name).read_bytes()).hexdigest() != digest
            ]

            assert not modified, (
                f"source pages changed since the manifest was written: {modified}. "
                "The bodies are redistributed verbatim under CC BY-SA 4.0 — restore "
                "them from upstream rather than updating the manifest, which would "
                "only pin the damage."
            )
