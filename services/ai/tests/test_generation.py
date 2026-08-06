"""Generation: the streaming contract, and the two ways an answer is refused.

The deterministic provider makes this testable without a model. It is
extractive and predictable, so the expected output is computed here rather than
approximated, and every property the endpoint enforces — frames arriving as a
stream, citations resolving to supplied evidence, abstention when they do not —
is exercised on the real code path.

What is *not* tested here is answer quality. This service cannot be responsible
for that, and a test asserting a phrase appears in a model's output would fail
the day the model changed for reasons having nothing to do with correctness.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.generation.prompt import ABSTENTION_MARKER, Passage, build_prompt, render_evidence
from app.main import create_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def evidence(*passages: tuple[str, str]) -> list[dict[str, Any]]:
    """Evidence items, numbered from 1 in the order given."""
    return [
        {
            "ordinal": index,
            "chunkId": f"chunk-{index}",
            "text": text,
            "documentTitle": title,
            "pageNumber": 1,
        }
        for index, (title, text) in enumerate(passages, start=1)
    ]


def frames(response: Any) -> list[dict[str, Any]]:
    """Parse an SSE body into its events."""
    out: list[dict[str, Any]] = []

    for block in response.text.split("\n\n"):
        line = block.strip()
        if line.startswith("data: "):
            out.append(json.loads(line[len("data: ") :]))

    return out


def post(client: TestClient, body: dict[str, Any]) -> Any:
    return client.post("/v1/generate", json=body)


DEMO = {"provider": "deterministic-demo"}


class TestStreaming:
    def test_streams_tokens_then_a_done_frame(self, client: TestClient) -> None:
        response = post(
            client,
            {
                "question": "What is the reimbursement deadline?",
                "evidence": evidence(
                    ("Expenses", "Reimbursement claims must be filed within 30 days."),
                ),
                "policy": DEMO,
            },
        )

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")

        events = frames(response)
        assert [event["type"] for event in events][-1] == "done"

        tokens = [event for event in events if event["type"] == "token"]
        assert len(tokens) > 1, "a single-frame stream would not exercise streaming at all"

    def test_the_stream_reassembles_into_the_answer(self, client: TestClient) -> None:
        # The tokens are the answer, not a summary of it. If they did not
        # rejoin cleanly a reader would see words run together.
        response = post(
            client,
            {
                "question": "What is the reimbursement deadline?",
                "evidence": evidence(
                    ("Expenses", "Reimbursement claims must be filed within 30 days."),
                ),
                "policy": DEMO,
            },
        )

        answer = "".join(e["text"] for e in frames(response) if e["type"] == "token")
        assert "Reimbursement claims must be filed within 30 days." in answer
        assert "[1]" in answer


class TestCitations:
    def test_reports_only_ordinals_that_were_supplied(self, client: TestClient) -> None:
        response = post(
            client,
            {
                "question": "What is the reimbursement deadline?",
                "evidence": evidence(
                    ("Onboarding", "New starters receive a laptop on their first day."),
                    ("Expenses", "Reimbursement claims must be filed within 30 days."),
                ),
                "policy": DEMO,
            },
        )

        done = [event for event in frames(response) if event["type"] == "done"]
        assert done, "expected an answer, not an abstention"
        assert done[0]["citedOrdinals"] == [2]

    def test_rejects_evidence_numbered_with_a_gap(self, client: TestClient) -> None:
        # A citation of [2] against evidence numbered 1 and 3 cannot be
        # resolved by the caller afterwards, so it is refused at the door.
        items = evidence(("A", "first"), ("B", "second"))
        items[1]["ordinal"] = 3

        assert (
            post(client, {"question": "Anything?", "evidence": items, "policy": DEMO}).status_code
            == 422
        )

    def test_rejects_duplicate_ordinals(self, client: TestClient) -> None:
        items = evidence(("A", "first"), ("B", "second"))
        items[1]["ordinal"] = 1

        assert (
            post(client, {"question": "Anything?", "evidence": items, "policy": DEMO}).status_code
            == 422
        )


class TestAbstention:
    def test_abstains_when_no_passage_is_relevant(self, client: TestClient) -> None:
        response = post(
            client,
            {
                "question": "What is the capital of Peru?",
                "evidence": evidence(("Expenses", "Claims must be filed within 30 days.")),
                "policy": DEMO,
            },
        )

        events = frames(response)
        assert events[-1]["type"] == "abstained"
        assert events[-1]["reason"]

    def test_the_abstention_marker_never_reaches_the_reader_as_an_answer(
        self, client: TestClient
    ) -> None:
        # The marker is a protocol between the prompt and this endpoint. A
        # reader seeing the literal string INSUFFICIENT_EVIDENCE would be
        # reading an implementation detail and, worse, might read it as content.
        response = post(
            client,
            {
                "question": "What is the capital of Peru?",
                "evidence": evidence(("Expenses", "Claims must be filed within 30 days.")),
                "policy": DEMO,
            },
        )

        assert [event for event in frames(response) if event["type"] == "done"] == []

    def test_an_answer_without_citations_is_refused_when_they_are_required(self) -> None:
        # Driven through the endpoint's own logic with a provider that answers
        # fluently and cites nothing, which is the failure this rule exists for
        # and the one the deterministic provider cannot produce.
        from app.api.generation import GenerateRequest, _stream

        class Uncited:
            @property
            def model_name(self) -> str:
                return "test-uncited"

            async def generate(self, *args: Any, **kwargs: Any) -> Any:
                for token in ["The ", "deadline ", "is ", "30 ", "days."]:
                    yield token

        request = GenerateRequest.model_validate(
            {
                "question": "What is the deadline?",
                "evidence": evidence(("Expenses", "Claims must be filed within 30 days.")),
                "policy": {"provider": "deterministic-demo", "requireCitations": True},
            }
        )

        import asyncio

        async def collect() -> list[dict[str, Any]]:
            return [
                json.loads(chunk[len("data: ") :].strip())
                async for chunk in _stream(Uncited(), request)
            ]

        events = asyncio.run(collect())

        assert events[-1]["type"] == "abstained"
        assert "cited no passage" in events[-1]["reason"]

    def test_a_citation_outside_the_evidence_does_not_count_as_one(self) -> None:
        # The model inventing [7] when four passages were supplied is the
        # central failure mode. It must not be reported as a citation, and with
        # no other citation the answer must be refused.
        from app.api.generation import GenerateRequest, _stream

        class Invents:
            @property
            def model_name(self) -> str:
                return "test-invents"

            async def generate(self, *args: Any, **kwargs: Any) -> Any:
                yield "The policy is clear [7]."

        request = GenerateRequest.model_validate(
            {
                "question": "What is the deadline?",
                "evidence": evidence(("Expenses", "Claims must be filed within 30 days.")),
                "policy": {"provider": "deterministic-demo", "requireCitations": True},
            }
        )

        import asyncio

        async def collect() -> list[dict[str, Any]]:
            return [
                json.loads(chunk[len("data: ") :].strip())
                async for chunk in _stream(Invents(), request)
            ]

        events = asyncio.run(collect())
        assert events[-1]["type"] == "abstained"


class TestHostedProviderIsRefused:
    def test_hosted_generation_is_refused_without_explicit_permission(
        self, client: TestClient
    ) -> None:
        # Confidential content must not leave the machine, and this check lives
        # on the service rather than only in the caller: a check that exists
        # solely on the calling side protects nothing from a second caller.
        response = post(
            client,
            {
                "question": "What is the deadline?",
                "evidence": evidence(("Expenses", "Claims must be filed within 30 days.")),
                "policy": {"provider": "groq", "allowHostedProvider": False},
            },
        )

        assert response.status_code == 403

    def test_hosted_generation_is_still_refused_when_the_caller_asks_nicely(
        self, client: TestClient
    ) -> None:
        # The caller setting allowHostedProvider is necessary and not
        # sufficient: the service's own setting defaults closed, so a
        # compromised or mistaken caller cannot turn it on by itself.
        response = post(
            client,
            {
                "question": "What is the deadline?",
                "evidence": evidence(("Expenses", "Claims must be filed within 30 days.")),
                "policy": {"provider": "groq", "allowHostedProvider": True},
            },
        )

        assert response.status_code == 403


class TestPrompt:
    def test_evidence_is_numbered_so_a_citation_has_a_referent(self) -> None:
        rendered = render_evidence(
            [
                Passage(ordinal=1, text="first", document_title="A", page_number=3),
                Passage(ordinal=2, text="second", document_title="B", page_number=None),
            ]
        )

        assert "[1] (A, page 3)" in rendered
        assert "[2] (B)" in rendered

    def test_the_question_comes_after_the_evidence(self) -> None:
        # A model that reads the question first starts composing an answer and
        # then looks for support, which is the failure this ordering avoids.
        prompt = build_prompt("Why?", [Passage(1, "because", "A", None)])

        assert prompt.index("Passages:") < prompt.index("Question: Why?")

    def test_the_abstention_marker_is_defined_once(self) -> None:
        # Both the instruction and the check must use the same string. Two
        # literals would drift, and the symptom would be an answer that reads
        # "INSUFFICIENT_EVIDENCE" being shown to someone as content.
        prompt = build_prompt("Why?", [Passage(1, "because", "A", None)])

        assert ABSTENTION_MARKER in prompt
