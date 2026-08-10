/**
 * The readiness report: what a workspace's documents actually cover.
 *
 * The plan asked for "deterministic rules over retrieved evidence, not free LLM
 * judgement", and there is a trap in the obvious reading of that. The natural
 * deterministic rule is a similarity threshold — score the best match for a
 * probe question, call the topic covered above some floor. That does not work,
 * and it is not a matter of tuning: measured across the whole labelled corpus,
 * no floor on the fused RRF score, on cosine similarity or on `ts_rank_cd`
 * separates questions the documents answer from questions they do not. Every
 * threshold refusing all five unanswerable questions loses fifteen to eighteen
 * of the twenty-two answerable ones.
 * See evals/reports/2026-08-07-abstention-and-injection.md.
 *
 * A readiness score built on such a threshold would be a number that looks
 * objective and means nothing — the worst possible property for a report whose
 * entire purpose is to tell someone what they are missing.
 *
 * So the division of labour is this. The model answers exactly one question per
 * dimension — "do these passages answer this?" — and its answer is worth
 * something because it was measured: 5/5 unanswerable probes refused, 21/22
 * answerable ones answered. It is never asked to rate, score, or judge
 * importance. Everything after that is arithmetic over outcomes: a dimension is
 * covered when the answer survived the citation gate with at least one
 * resolving citation, and the score is a count. No weighting the model chose,
 * no adjective it picked.
 */

import type { AnswerEvent } from "@/lib/generation/answer";

/** One thing a workspace's documents either cover or do not. */
export interface ReadinessDimension {
  readonly key: string;
  readonly heading: string;
  /**
   * The question put to the corpus. Phrased as something a new joiner would
   * actually ask, because that is what retrieval is good at and because a
   * dimension nobody would ask about is not a gap worth reporting.
   */
  readonly probe: string;
}

/**
 * The default set.
 *
 * Deliberately small and general. A larger set would produce a more impressive
 * report and a less honest one: each dimension costs a generation, and a
 * dimension that no realistic workspace would cover reports a permanent gap
 * that is really a statement about the list rather than about the documents.
 */
export const DEFAULT_DIMENSIONS: readonly ReadinessDimension[] = [
  {
    key: "expenses",
    heading: "Expenses and reimbursement",
    probe: "How are expenses claimed and reimbursed, and within what deadline?",
  },
  {
    key: "onboarding",
    heading: "Onboarding",
    probe: "What happens on a new team member's first day, and what are they given?",
  },
  {
    key: "time_off",
    heading: "Time off and leave",
    probe: "How is time off requested and approved?",
  },
  {
    key: "security",
    heading: "Security and incident response",
    probe: "What should someone do when they suspect a security incident?",
  },
  {
    key: "access",
    heading: "Systems and access",
    probe: "How does someone request access to a system or tool?",
  },
  {
    key: "support",
    heading: "Getting help",
    probe: "Where does someone go with a question nobody has answered?",
  },
];

export type Coverage = "covered" | "missing" | "unavailable";

export interface DimensionResult {
  readonly key: string;
  readonly heading: string;
  readonly probe: string;
  readonly coverage: Coverage;
  /** The grounded answer, when there was one. */
  readonly summary: string;
  readonly citations: readonly {
    readonly chunkId: string;
    readonly documentId: string;
    readonly documentTitle: string;
    readonly pageNumber: number | null;
    readonly ordinal: number;
  }[];
  /** Why, when the coverage is not `covered`. Shown to the reader verbatim. */
  readonly note: string;
}

export interface ReadinessScore {
  readonly covered: number;
  readonly missing: number;
  /**
   * Dimensions that could not be assessed — the model service was unreachable,
   * or the request was cancelled. Kept out of both other counts on purpose: a
   * failure to look is not evidence of absence, and folding it into "missing"
   * would report a gap the documents may not have.
   */
  readonly unavailable: number;
  readonly assessed: number;
  /**
   * Covered as a share of what was actually assessed, or `null` when nothing
   * was. Not rounded to a grade or a colour: a percentage invites comparison,
   * and this number is only meaningful against the dimension list that produced
   * it.
   */
  readonly ratio: number | null;
}

/**
 * Fold one dimension's answer stream into a result.
 *
 * The events are the same ones a person asking a question would receive, which
 * is the point: a readiness report makes no claim the ordinary answer path
 * would not have made, and inherits its citation gate rather than reimplementing
 * a laxer one.
 */
export function resultFor(
  dimension: ReadinessDimension,
  events: readonly AnswerEvent[],
): DimensionResult {
  const terminal = events.at(-1);

  const base = { key: dimension.key, heading: dimension.heading, probe: dimension.probe };

  // Anything that is not a terminal frame, including a stream that stopped
  // mid-answer. `token` is not an outcome, and treating "neither error nor
  // abstention" as success reached into a frame that has no citations and threw
  // — caught by the test below rather than in a report.
  if (!terminal || terminal.type === "error" || terminal.type === "token") {
    return {
      ...base,
      coverage: "unavailable",
      summary: "",
      citations: [],
      note:
        terminal?.type === "error"
          ? `This section could not be assessed: ${terminal.message}`
          : "This section could not be assessed: the answer ended without a result.",
    };
  }

  if (terminal.type === "abstained") {
    return {
      ...base,
      coverage: "missing",
      summary: "",
      citations: [],
      // The generator's own words. A rewritten reason would be this module's
      // opinion about someone else's finding.
      note: terminal.reason,
    };
  }

  const summary = events
    .filter((event): event is Extract<AnswerEvent, { type: "token" }> => event.type === "token")
    .map((event) => event.text)
    .join("");

  // A `done` frame cannot carry zero citations — the answer path abstains first
  // — but this module must not depend on that being true elsewhere. Treated as
  // missing rather than trusted, because an uncited paragraph in a readiness
  // report is exactly the kind of confident, unsourced claim the whole system
  // exists to avoid.
  if (terminal.citations.length === 0) {
    return {
      ...base,
      coverage: "missing",
      summary: "",
      citations: [],
      note: "An answer was produced but nothing in it could be traced to a document.",
    };
  }

  return { ...base, coverage: "covered", summary, citations: terminal.citations, note: "" };
}

/** Count outcomes. No weighting, no judgement — the whole scoring rule. */
export function score(results: readonly DimensionResult[]): ReadinessScore {
  const covered = results.filter((r) => r.coverage === "covered").length;
  const missing = results.filter((r) => r.coverage === "missing").length;
  const unavailable = results.filter((r) => r.coverage === "unavailable").length;
  const assessed = covered + missing;

  return {
    covered,
    missing,
    unavailable,
    assessed,
    ratio: assessed === 0 ? null : covered / assessed,
  };
}

export interface ReadinessSection {
  readonly key: string;
  readonly heading: string;
  readonly body: string;
  readonly coverage: Coverage;
}

/**
 * The report, as the sections stored in an artifact version.
 *
 * The summary section is generated from the counts and says what they do and do
 * not mean. It carries no citations, and it is the only section that does not:
 * it is a statement about this report rather than about the documents, and
 * pretending otherwise by attaching a source would be worse than saying so.
 */
export function toSections(
  results: readonly DimensionResult[],
  totals: ReadinessScore,
): ReadinessSection[] {
  const summary = [
    `${totals.covered} of ${totals.assessed} areas are covered by documents in this workspace.`,
    totals.unavailable > 0
      ? `${totals.unavailable} could not be assessed and are counted in neither figure — a failure to look is not evidence of absence.`
      : "",
    "An area counts as covered when a question about it was answered from the workspace's own documents and every citation resolved to a real passage. Areas are not weighted: this is a count of what is documented, not a judgement of what matters.",
  ]
    .filter(Boolean)
    .join(" ");

  return [
    { key: "summary", heading: "Summary", body: summary, coverage: "covered" },
    ...results.map((result) => ({
      key: result.key,
      heading: result.heading,
      body: result.coverage === "covered" ? result.summary : result.note,
      coverage: result.coverage,
    })),
  ];
}
