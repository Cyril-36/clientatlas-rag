# Brief: build a labelled evaluation dataset from the GitLab Handbook

You are producing an evaluation dataset for **ClientAtlas**, a multi-tenant
document question-answering system. Your output is used to measure retrieval
quality — recall@k, MRR, citation correctness — at a realistic corpus size.

Read this whole brief before starting. Section 6 lists the checks your output
must pass; running them yourself is part of the job.

---

## 1. What you are producing

Three things, in this directory:

```
evals/datasets/gitlab-handbook-v1/
├── source/            verbatim markdown, one file per handbook page
├── corpus.json        the same content in ClientAtlas's corpus format
├── questions.json     25–30 labelled questions
└── ATTRIBUTION.md     licence and provenance
```

## 2. The corpus

**Source:** the GitLab Handbook, `https://gitlab.com/gitlab-com/content-sites/handbook`,
directory `content/handbook/`. It is licensed **CC BY-SA 4.0**, which permits
redistribution _with attribution and under the same licence_. Record this.

**What to take:** roughly **150–300 pages**, enough to produce **1,500+ chunks**.
Prefer the `engineering/`, `people-group/`, `security/` and `finance/` subtrees —
they are prose-heavy and closest to what ClientAtlas is actually for. Skip pages
that are mostly tables of links, embedded video, or navigation stubs.

**Do not modify the text.** Not to fix typos, not to shorten, and above all not
to insert anything. Two reasons: the attribution claim has to stay true, and a
corpus that has been edited is no longer evidence of how the system behaves on
real documents.

### `source/`

One file per page, named `<slug>.md` where the slug is kebab-case and unique.
Prefix each file with YAML front matter:

```yaml
---
slug: engineering-incident-management
title: Incident Management
source_url: https://handbook.gitlab.com/handbook/engineering/infrastructure/incident-management/
retrieved: 2026-08-04
license: CC BY-SA 4.0
---
```

Then the page's markdown, verbatim.

### `corpus.json`

The same content in the format ClientAtlas already uses, so one set of tooling
covers both datasets. Convert each page's markdown headings and paragraphs:

```json
{
  "version": "gitlab-handbook-v1",
  "organization": "GitLab (public handbook)",
  "note": "...",
  "documents": [
    {
      "slug": "engineering-incident-management",
      "title": "Incident Management",
      "sourceUrl": "https://handbook.gitlab.com/...",
      "mediaType": "application/pdf",
      "sections": [
        {
          "heading": "Severity levels",
          "paragraphs": ["Verbatim paragraph one.", "Verbatim paragraph two."]
        }
      ]
    }
  ]
}
```

Rules:

- `heading` is the nearest markdown heading above the paragraphs. Use the
  heading text only, no `#`.
- Each entry in `paragraphs` is one paragraph of **verbatim** text. Collapse
  internal whitespace; do not reword.
- Drop code blocks, images, HTML blocks and link-only lines.
- A list becomes one paragraph, items joined with `" | "`.
- A table row becomes one paragraph, cells joined with `" | "`.
- `mediaType` is `application/pdf` for most; set roughly a fifth to
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
  so both parsers get exercised.

## 3. The questions

**25–30 questions**, in exactly this shape:

```json
{
  "version": "gitlab-handbook-v1",
  "corpus": "gitlab-handbook-v1",
  "questions": [
    {
      "id": "g01",
      "category": "factual",
      "question": "Who declares a Severity 1 incident?",
      "answerable": true,
      "expected": [
        {
          "document": "engineering-incident-management",
          "mustContain": "the incident commander declares"
        }
      ],
      "notes": "Why this question is here and what failure it catches."
    }
  ]
}
```

### `mustContain` is the part that matters most

It is a **verbatim substring of the source text**, and it is how the dataset
survives re-indexing — chunk ids are regenerated on every ingest, so pinning
them would break immediately.

- Copy it character-for-character from `corpus.json`. Do not paraphrase.
- Keep it **20–120 characters**. Long enough to be unique, short enough to
  survive chunk boundaries.
- It must appear in **exactly one** document. If the phrase occurs in several,
  pick a longer one.
- Prefer a distinctive noun phrase over a common sentence opener.

An anchor that matches nothing is worse than no question at all: it fails
silently, and that question then scores against an empty expectation for ever.

### Category distribution

| Category               | Count | What it must do                                                                                                   |
| ---------------------- | ----- | ----------------------------------------------------------------------------------------------------------------- |
| `factual`              | 10    | One fact, one document. At least 3 must require reading a threshold or condition rather than matching a keyword.  |
| `multi_document`       | 5     | Genuinely needs **two or more different documents**. List every one in `expected`.                                |
| `ambiguous`            | 3     | A term the handbook uses in two distinct senses. List both.                                                       |
| `missing`              | 5     | Plausible, adjacent, and **genuinely absent**. `answerable: false`, `expected: []`.                               |
| `citation_correctness` | 4     | Short fact appearing once; at least 2 phrased so the correct answer is negative ("no", "never", "not permitted"). |
| `conflicting`          | 0–2   | Only if you find a **real** contradiction. Do not manufacture one.                                                |

### Categories you must NOT produce

- **`prompt_injection`** — requires text addressed at the model, which would
  mean editing the corpus. Those questions live in the authored `onboarding-v1`
  dataset and stay there.
- **`cross_tenant`** — a property of the access-control layer, not of a corpus.

### Verifying `missing` questions

Before marking one `answerable: false`, search the _whole_ corpus for the topic,
not just the page you had in mind. A question that is answerable somewhere you
did not look becomes a permanent false failure that will be blamed on retrieval.

## 4. Attribution

`ATTRIBUTION.md` must state: the source project and URL, CC BY-SA 4.0, the
retrieval date, that text is unmodified, and that this derivative is
redistributed under the same licence. List every page with its source URL.

## 5. What good looks like

- A question whose answer requires combining a rule and its exception.
- A `missing` question sitting right next to a page that nearly answers it.
- An `ambiguous` question where both senses are defensible.

## 6. Checks your output must pass

A validator is provided. Run it, and keep running it until it exits 0:

```bash
python evals/validate_dataset.py evals/datasets/gitlab-handbook-v1
```

It is the same script this project runs on the dataset when it arrives, so
there is no gap between what you check and what is checked. It enforces:

1. Every `mustContain` is a verbatim substring of the named document.
2. Every `mustContain` appears in **exactly one** document. This is the check
   that matters most, and the one that caught a real bug in the first dataset:
   a short anchor matched both a policy page and a distractor page that said
   the opposite, so retrieval returning the wrong page would have scored as
   correct.
3. Every `document` in `expected` exists.
4. `answerable: false` ⟹ `expected` is `[]`. `answerable: true` ⟹ non-empty.
5. Question ids are unique.
6. `multi_document` questions reference **≥2 distinct** documents.
7. No question is `prompt_injection` or `cross_tenant` when the corpus is real.
8. Anchor length outside 20–120 characters is a **warning**, not an error.

Set `minDocuments: 150` and `minParagraphs: 1500` at the top level of
`corpus.json` and the validator will enforce the size targets too.

Category counts are not machine-checked. Report them; the table in section 3
is the target.

Report the numbers: documents, paragraphs, questions per category, and anything
you could not satisfy. **Say what you could not do rather than working around
it** — a dataset that quietly drops a requirement is worse than one that reports
the gap, because the gap is then invisible to everyone downstream.
