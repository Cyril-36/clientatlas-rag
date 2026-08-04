"""Heading-aware chunking.

Chunk boundaries decide what retrieval can find. A chunk that spans two
unrelated sections retrieves for queries about either and answers neither well;
a chunk cut mid-sentence loses the clause that made it relevant.

So blocks are grouped under the heading they belong to, and a chunk never
crosses a heading boundary even when it leaves the chunk short. Overlap carries
the last few blocks forward, so a fact stated at the end of one chunk is still
findable from the start of the next.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.ingestion.parsing import ParsedBlock

# MiniLM uses WordPiece, which splits some words into several tokens. Counting
# whitespace-separated words and scaling is an approximation, deliberately: an
# exact count would need the model's tokenizer, which would drag the optional
# ML dependency into the chunker and into CI.
TOKENS_PER_WORD = 1.3

# These are ceilings, not goals, and on real documents they are rarely reached:
# a heading boundary almost always flushes a chunk first. Measured median chunk
# size on a 200-page corpus is 116 tokens against the 650 below.
#
# That is not a bug, and raising the floor to "fill" chunks makes retrieval
# worse. all-MiniLM-L6-v2 reads only the first 256 WordPiece tokens of any
# input and silently discards the rest, so a chunk built to 650 loses most of
# itself before it is ever embedded. A measured sweep of this — sibling-section
# merging at four different targets — lost to the values below at every setting,
# and collapsed recall@5 from 0.77 to 0.50 at 650.
#
# See evals/reports/2026-08-04-vector-baseline.md before changing these.
EMBEDDING_WINDOW_TOKENS = 256

DEFAULT_TARGET_TOKENS = 650
DEFAULT_MAX_TOKENS = 800
DEFAULT_OVERLAP_TOKENS = 100


def estimate_tokens(text: str) -> int:
    """Approximate WordPiece token count. See TOKENS_PER_WORD."""
    words = len(text.split())
    return max(1, round(words * TOKENS_PER_WORD))


@dataclass(frozen=True)
class Chunk:
    ordinal: int
    text: str
    page_number: int | None
    heading_path: tuple[str, ...]
    token_count: int


def _flush(
    buffer: list[ParsedBlock],
    ordinal: int,
    heading_path: tuple[str, ...],
) -> Chunk:
    text = "\n".join(block.text for block in buffer)

    # The first block's page, not the last: a citation should point at where
    # the passage starts, which is where a reader will look for it.
    page_number = next((block.page_number for block in buffer if block.page_number), None)

    return Chunk(
        ordinal=ordinal,
        text=text,
        page_number=page_number,
        heading_path=heading_path,
        token_count=estimate_tokens(text),
    )


def _overlap_blocks(buffer: list[ParsedBlock], overlap_tokens: int) -> list[ParsedBlock]:
    """The trailing blocks worth carrying into the next chunk."""
    carried: list[ParsedBlock] = []
    total = 0

    for block in reversed(buffer):
        tokens = estimate_tokens(block.text)

        if total + tokens > overlap_tokens and carried:
            break

        carried.insert(0, block)
        total += tokens

    # Never carry the whole chunk forward: that would make no progress and, with
    # a single oversized block, would not terminate.
    if len(carried) >= len(buffer):
        carried = carried[1:]

    return carried


def chunk_blocks(
    blocks: tuple[ParsedBlock, ...] | list[ParsedBlock],
    target_tokens: int = DEFAULT_TARGET_TOKENS,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
) -> list[Chunk]:
    """Group parsed blocks into overlapping, heading-bounded chunks."""
    chunks: list[Chunk] = []
    buffer: list[ParsedBlock] = []
    buffer_tokens = 0
    current_heading: tuple[str, ...] | None = None
    ordinal = 0

    def flush() -> None:
        nonlocal buffer, buffer_tokens, ordinal

        if not buffer:
            return

        ordinal += 1
        chunks.append(_flush(buffer, ordinal, current_heading or ()))

        carried = _overlap_blocks(buffer, overlap_tokens)
        buffer = list(carried)
        buffer_tokens = sum(estimate_tokens(block.text) for block in buffer)

    for block in blocks:
        if current_heading is None:
            current_heading = block.heading_path

        # A new section starts a new chunk, even if the current one is nearly
        # empty. Mixing sections is worse than a short chunk.
        if block.heading_path != current_heading:
            flush()
            # Overlap must not leak across a heading boundary either.
            buffer = []
            buffer_tokens = 0
            current_heading = block.heading_path

        tokens = estimate_tokens(block.text)

        if buffer and buffer_tokens + tokens > max_tokens:
            flush()

        buffer.append(block)
        buffer_tokens += tokens

        if buffer_tokens >= target_tokens:
            flush()

    flush()

    # The final flush leaves its own overlap behind as a trailing buffer. Those
    # blocks are already present in the preceding chunk, so emitting them again
    # would duplicate content in retrieval.
    return chunks
