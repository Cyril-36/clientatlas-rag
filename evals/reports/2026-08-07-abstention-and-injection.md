# Abstention and prompt injection — 2026-08-07

Closes the two M5 criteria that were still open: *a question with no evidence
abstains*, and *a document containing "ignore previous instructions" does not
change behaviour*.

The first turned out to need a different mechanism than the plan specified.

## The confidence threshold does not exist

The plan called for `→ 6–8 chunks → confidence threshold`: score the best match
and refuse below a floor. The dataset makes that testable — twenty-two
questions written to be answerable from this corpus, five written not to be —
so the floor could be measured rather than picked.

`scripts/measure-threshold.mjs` measures all three signals available, over the
5,393-chunk corpus:

| signal | answerable (n=22) | unanswerable (n=5) |
| --- | --- | --- |
| fused RRF score | min 0.01639 · median 0.01639 · max 0.03279 | all five 0.01639 |
| best cosine similarity | min 0.43961 · median 0.59231 · max 0.85446 | 0.46519 – 0.61773 |
| best `ts_rank_cd` | min 0 · median 0 · max 0.05 | all five 0 |

**None of them separates the two groups.** The trade-off at every threshold
that refuses all five unanswerable questions:

| signal | threshold | unanswerable refused | answerable lost |
| --- | --- | --- | --- |
| RRF | 0.03126 | 5/5 | **18**/22 |
| cosine | 0.62141 | 5/5 | **15**/22 |
| `ts_rank_cd` | 0.00263 | 5/5 | **17**/22 |

The best cosine trade-off anywhere on the curve is 0.49421 — one unanswerable
question refused, one answerable question lost. That is not a feature.

Two different reasons, worth separating.

**RRF cannot work, by construction.** Fusion scores rank position and discards
magnitude. A chunk ranked first by both searches scores `2/61` whether it is a
verbatim answer or the least irrelevant of five thousand passages. The top
fused score is therefore almost binary — it says how many searches agreed on a
first place, not whether that place was any good. Any threshold on it is a
threshold on agreement, not on confidence, and the measured distribution shows
exactly that: every unanswerable question scores `1/61`, and so does the median
answerable one.

**Cosine and `ts_rank_cd` could work in principle and do not in fact.** They
carry magnitude, so the failure is empirical rather than structural: a question
about something the handbook discusses adjacently scores like one it answers
outright. "What reimbursement rate per kilometer applies to bicycle travel?"
finds the expenses pages at 0.53 cosine — the corpus genuinely is about
reimbursement, it simply never states that rate. Similarity to the topic is not
evidence of an answer, and no threshold on similarity can tell those apart.

**No threshold has been implemented.** Adding one at, say, 0.5 would have looked
like diligence, refused one unanswerable question in five, and silently lost
answerable ones — a change that makes the product worse while appearing to make
it safer. The measurement is kept so the next person to reach for this idea
starts from the numbers.

## What does work: the generator reads the passages

If the score cannot tell whether the evidence answers the question, something
has to read it. That is what the prompt contract asks for and what the citation
gate enforces, and `scripts/measure-abstention.mjs` measures whether it holds up
with the real model — qwen3:8b via Ollama, all 27 questions, retrieval through
the real query path.

|  | correct | total |
| --- | --- | --- |
| unanswerable questions refused | **5** | 5 |
| answerable questions answered | **21** | 22 |

Median latency 85s on this machine, which is a local 8B model on consumer
hardware and says nothing about the design.

The one loss is `g27`, an answerable question the model declined. Compare that
against the best threshold available: 5/5 refused for 15 answerable questions
lost. Semantic abstention gets the same refusals for one.

This is a measurement, not a gate. CI has no 8B model, and a test that skipped
itself when one was absent would be worse than no test — it would report green
for a check that never ran.

## Injection: what is enforced, and what is asked for

The criterion is that a document saying "ignore previous instructions" does not
change behaviour. Two different kinds of assurance sit behind that, and they
should not be reported as one.

**Enforced, and tested in CI.** Passage text is structurally data: carried in a
JSON field, rendered into a delimited block, and with no path to the position
where instructions live. `SYSTEM_PROMPT` is a constant and nothing derived from
retrieved text can reach it. And whatever a passage persuades a model to do, the
output still has to pass the citation gate — so the worst an injection can
achieve is an abstention. It cannot manufacture a citation.

`services/ai/tests/test_prompt_injection.py` tests this at its worst: a provider
that obeys the injection completely, disregards the documents and cites `[3]`
against two supplied passages. The endpoint refuses it. A provider that dumps
the system prompt is refused too — for the ordinary reason, no citations, with
no special case. The gate does not have to recognise an attack to stop one.

`tests/integration/answers-api.test.ts` does the same through the real signed-in
route, with the poisoned passage in the tenant's own corpus and the stub model
obeying it. The passage reaches the evidence; nothing reaches the caller.

**Asked for, and measured rather than asserted.** Whether a given model declines
the instruction is a property of that model. Rule 6 of the system prompt asks it
to. No unit test here asserts it, because such a test would be asserting a fact
about qwen3:8b that would break the day the model changed for unrelated reasons.

## Reproducing

```bash
pnpm --filter @clientatlas/product-api exec node scripts/measure-threshold.mjs

# needs ollama serve, and the model service on :8000
pnpm --filter @clientatlas/product-api exec node scripts/measure-abstention.mjs
```

Both need a loaded corpus. The threshold numbers are deterministic given one;
the abstention numbers are not, since a language model at temperature 0.1 is not
a pure function, and the 21/22 should be read as one run rather than a constant.

## Not done

The abstention measurement covers one corpus, one model, and five unanswerable
questions. Five is enough to kill the threshold idea — it cannot be rescued by a
larger sample when the distributions overlap this completely — and it is not
enough to put a confidence interval on 5/5. M8 expands the dataset to 40–50
questions across nine categories, which is where that number becomes meaningful.
