---
slug: security-product-security-security-platforms-architecture-application-security-secure-code-review-automated-mr-reviewer
title: "Automated MR Security Reviewer"
source_url: "https://handbook.gitlab.com/handbook/security/product-security/security-platforms-architecture/application-security/secure-code-review/automated-mr-reviewer/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---

title: "Automated MR Security Reviewer"
description: "How to use the AppSec automated security review flow on merge requests at GitLab."
---

{{% alert title="Proof of Concept" color="warning" %}}
The AppSec team is running a proof of concept (PoC) to evaluate whether this review flow can operate reliably without a human in the loop. **All findings from this flow must be reviewed and validated by a human before any action is taken.** Do not merge, block, or escalate based solely on this flow's output. Findings are advisory only during this phase.
{{% /alert %}}

The Automated MR Security Reviewer is an AI-driven application security review flow that analyzes merge requests for exploitable vulnerabilities, logic flaws, and design issues. When triggered, it runs autonomously and posts its findings as an internal note on the MR — no AppSec engineer needs to be in the loop to initiate or complete a review.

The flow is currently available for merge requests in `gitlab-org/gitlab` and other select projects. The AppSec team is evaluating whether the flow produces consistent, low-false-positive findings at a quality and reliability that would support broader rollout.

The flow's source and full technical reference are maintained in the [appsec-security-mr-reviewer project](https://gitlab.com/components/agents-and-flows/appsec-security-mr-reviewer/).

If you would like to have this flow enabled on your project, submit an MR in the [appsec-security-mr-reviewer project](https://gitlab.com/components/agents-and-flows/appsec-security-mr-reviewer/), adding your project to the `flow.yaml` file.

## How It Works

A review runs in four steps:

1. **Build Context** — Gathers MR metadata, diffs, comments, linked issues, and epics to understand the full scope of the change.
1. **Prescan Codebase** — Scans the target project to identify existing security patterns (input validation, authentication, sanitization, error handling) and establish a baseline for how the project handles security.
1. **Perform AppSec Review** — An AI security engineer reviews the code changes against the baseline, looking for exploitable vulnerabilities, logic flaws, and design issues. It highlights where new code breaks established conventions or bypasses available security utilities.
1. **Validate Findings & Post Review** — A second-pass validation filters out false positives and confirms each finding is genuinely exploitable in context. The final review is posted as an internal note on the MR.

The flow focuses on real, exploitable security risks rather than generic missing controls that SAST tools already cover.

## Triggering a Review

### Manually via @mention

Mention the service account in a public comment on the MR to trigger a review:

`@ai-appsec-security-mr-reviewer-<namespace> please review this MR for security issues`

The service account username follows the pattern `@ai-appsec-security-mr-reviewer-<namespace>`, where `<namespace>` corresponds to the GitLab group the flow is deployed under.

When triggered, the flow immediately labels the MR `~security-mr-reviewer-flow-triggered` and posts a confirmation comment linking to the running job.

**Note:** Using the wrong `<namespace>`, will cause the flow to not be triggered. When you begin typing `@ai-appsec....` a drop down should appear with the full name of the correct service account. If the service account does not appear in the drop down, the flow needs to be added to the project in which you are working.

### Automatically via CI

The flow can be integrated into a project's CI pipeline so that it triggers automatically on new MR pipelines. The mechanism is a CI job that posts the `@mention` on behalf of the pipeline. This requires a fine grained access token associated with a user account. The only conditions that are required for correct behavior are that the job must not post a mention when either `~AppSecMRReviewPerformedBy::AutomatedFlow` or `~security-mr-reviewer-flow-triggered` is already present on the MR — this prevents double-triggering a completed review or one that is already in progress.

All other `rules:` conditions — pipeline source, event type, fork check, draft exclusion — are configurable and should be adapted to the project's pipeline structure. See the [project README](https://gitlab.com/components/agents-and-flows/appsec-security-mr-reviewer/) for the reference CI snippet, required token setup, and service account naming.

## Understanding the Results

The review is posted as an internal note on the MR, with findings grouped by impact category: Exploitable, Logic Flaw, or Design Issue. Each finding includes the relevant file path and line numbers, along with reasoning grounded in the patterns the prescan found in the rest of the codebase.

When reading findings, keep in mind:

- **Validate every finding.** The flow may surface false positives — findings that seem valid but miss broader context like post-processing redaction, caching behavior, or framework-level protections. Always check against your knowledge of the code before acting.
- **No findings is a valid outcome.** The flow will not manufacture issues when the MR is clean.
- **Non-security observations are incidental.** If the flow surfaces something that is not a security concern, do not act on it through this channel.

## Re-triggering a Review

After code changes, you can request a new review by repeating the trigger method you used originally.

For **CI-based setups**, remove the `~AppSecMRReviewPerformedBy::AutomatedFlow` label and push a new commit or re-run the pipeline. The CI job will re-evaluate its `rules:` and post a new mention automatically.

For **manual @mention**, simply mention the service account again in a new public comment.

{{% alert title="Note" color="primary" %}}
Be careful not to expose existing vulnerabilities when asking the flow to validate a fix in a public comment.
{{% /alert %}}

## Flow Failure and Recovery

### Recognizing a stuck or failed flow

The flow labels the MR `~security-mr-reviewer-flow-triggered` at the start of a run and removes it only after successful completion, replacing it with `~AppSecMRReviewPerformedBy::AutomatedFlow`. If the flow crashes or hangs mid-run, the MR is left with `~security-mr-reviewer-flow-triggered` applied — which blocks both CI-based and manual re-triggering until it is cleaned up.

Signs that a run has failed or stalled:

- `~security-mr-reviewer-flow-triggered` is present but no review note has appeared after ~15–20 minutes.
- The job linked in the confirmation comment is stuck or shows an error in CI.

### Recovery steps

1. **Check the job logs.** Open the CI job linked in the flow's confirmation comment and look for error messages or the step the job stalled on.

1. **Notify the AppSec team.** Tag `@appsec` in a new note on the MR with the job URL, any error output, and a description of what you observed.

1. **Remove the blocking label.** Remove `~security-mr-reviewer-flow-triggered` from the MR. Anyone with access to the MR can do this via the label sidebar — no special permissions are required.

1. **Re-trigger.** Once the label is cleared, use whichever trigger method applies (CI pipeline re-run or a new @mention).

## Known Limitations

The following limitations have been identified during the PoC. None have committed fix timelines.

**Open discussion thread blocks the merge button.** The flow's confirmation comment ("✅ AppSec Security MR Reviewer has started") opens a thread on the MR. GitLab requires all threads to be resolved before merging, and the flow cannot close threads automatically. Resolve it manually once the review is complete.

**All findings appear in a single note.** The flow posts one consolidated internal note rather than individual discussion threads per finding. This makes it harder to track which findings have been addressed. Splitting findings into separate threads is being considered for a future iteration.

**Occasional hallucinations.** The LLM may produce findings that reference code constructs or behaviors that do not exist in the codebase. Always validate against the actual code. Report hallucinations through the feedback process below.

**Duplicate reviews.** In rare cases the flow has run twice on the same MR, producing two review notes. If your CI job has `retry:` configured, remove it — the `@mention` POST is non-idempotent and retries will trigger duplicate runs. If you receive a duplicate without a retry configuration change, report it to the AppSec team and use the most recent note.

## Providing Feedback

Feedback from engineers using the flow directly shapes how the AppSec team calibrates and improves it. After a review is posted on your MR:

**Apply a feedback label:**

- `~"appsec-flow-mr-review::helpful"` if the review identified real issues or useful context
- `~"appsec-flow-mr-review::unhelpful"` if the review was not useful or produced false positives
- `~"appsec-flow-mr-review::mixed-helpful"` if the review produced both valid and invalid findings
- `~"appsec-flow-mr-review::non-security-helpful"` if the review produced valid but non-security findings

**Leave a comment on the [feedback issue](https://gitlab.com/components/agents-and-flows/appsec-security-mr-reviewer/-/work_items/1)** with a link to your MR and details on what the flow got right, what it got wrong, and anything else that would help improve quality.

Usage tracking relies on these labels being applied. MRs without labels will not appear in the flow's usage data.
