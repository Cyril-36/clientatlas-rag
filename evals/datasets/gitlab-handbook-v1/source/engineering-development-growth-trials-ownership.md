---
slug: engineering-development-growth-trials-ownership
title: "Trials Ownership and Collaboration Framework"
source_url: "https://handbook.gitlab.com/handbook/engineering/development/growth/trials-ownership/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---
title: Trials Ownership and Collaboration Framework
description: "Conceptual ownership model and decision framework for trials work across Growth and Fulfillment/Monetization"
---

## Overview

This page defines **who owns what** for trials work at GitLab, and how the teams involved collaborate. It covers both the conceptual ownership model (which team is accountable for which part of the trial experience) and the practical decision framework for contributing to shared codebases such as CustomersDot.

Trials have always spanned multiple codebases (GitLab and CustomersDot) and serve multiple customer states (new prospects and existing paid customers). What has shifted over the years is *which team owns which part*, and for periods that sat clearly enough within a single team that a written model was unnecessary. That is no longer the case: ownership is split across Growth and Fulfillment/Monetization, and the trial codebase is being centralized under Fulfillment/Monetization so that all trial types — new and existing — live under one roof. This page makes those lines explicit.

This framework builds on the initiative to enable Growth's independence for trials work in CustomersDot (see [Epic #20063](https://gitlab.com/groups/gitlab-org/-/epics/20063)). The goal is to let Growth move quickly on the trial entry points it owns while Fulfillment/Monetization owns and sustains the underlying trial codebase, billing, and provisioning infrastructure.

## Conceptual Ownership Model

Ownership is split along **what a team is accountable for**, not along a single repository. Two dimensions determine ownership: the *layer* of the trial experience (entry point vs. codebase) and the *customer state* (new prospect vs. existing paid customer).

### Core principle: entry points vs. codebase

| Area | Owner | What this includes |
| --- | --- | --- |
| **Trial entry points** | Growth | The surfaces that get a user *into* a trial. In GitLab (the application): registration and trial sign-up flows, lead capture, in-product trial CTAs and upgrade prompts, trial-related experiments, onboarding, and the messaging around starting a trial. In CustomersDot: the **trial entry endpoint and its basic controller wiring** — the thin layer that receives a trial request and hands it off to the underlying trial systems. |
| **Trial codebase** | Fulfillment / Monetization | Everything deeper than the entry layer that *runs* a trial once started: trial creation, entitlement, trial state and lifecycle, provisioning, billing integration, and the shared CustomersDot services and data that back all trial types. |

Growth is accountable for **turning interest into started trials**, including the thin CustomersDot entry layer that initiates a trial. Fulfillment/Monetization is accountable for **the trial actually working** once it has begun — the provisioning, entitlement, billing, and lifecycle systems behind the entry point — and for the long-term health of that code.

The dividing line within CustomersDot is depth: Growth owns the trial **entry endpoint and basic controller**; the moment the request crosses into trial creation, provisioning, entitlement, billing, or shared services, it is Fulfillment/Monetization's. When in doubt about which side of that line a change sits on, use the [decision framework](#decision-framework) below.

This ownership split applies to *building* the entry layer. **Operational support, incidents, and on-call for all of CustomersDot — including the thin entry layer Growth may build or modify — remain with Fulfillment/Monetization** (see [Engineering excellence and sustaining ownership](#engineering-excellence-and-sustaining-ownership)).

Centralizing the deeper trial codebase under Fulfillment/Monetization means a single team owns the *implementation* of all trial types — new prospect trials, paid-customer add-on/expansion trials, and any future trial variants — rather than spreading that ownership across teams. Trial *entitlements* specifically fall under Fulfillment's Entitlements area, which supports entitlements for all trials.

### Customer state: new prospect vs. existing paid customer

Trials serve two distinct customer states, and this has historically been the dividing line between Growth and Fulfillment work:

- **New prospect trials** — A user or organization that is not yet a paying customer evaluates GitLab through a trial. Growth owns the entry points (acquisition, sign-up, activation, conversion to paid). The trial codebase that provisions and runs the trial is owned by Fulfillment/Monetization.
- **Existing paid customer trials** — An existing paying customer trials an add-on, higher tier, or additional capability (for example, trialing a feature on top of an active subscription). The entry points here are closer to in-product expansion and upgrade surfaces; the provisioning, entitlement, and billing implications are owned by Fulfillment/Monetization.

The consistent rule across both states: **Growth owns the entry point that starts the trial; Fulfillment/Monetization owns the codebase that fulfills it.**

### Engineering excellence and sustaining ownership

Work that is not a user-facing feature but keeps the trial systems healthy — **observability, monitoring, performance improvements, reliability, technical debt, and refactoring** within the trial codebase — is owned by **Fulfillment/Monetization** as the codebase owner. This holds regardless of which team most recently shipped a feature in that code.

{{% alert title="Support and on-call stay with Fulfillment" color="warning" %}}
**All operational support, incidents, and on-call for CustomersDot remain with Fulfillment/Monetization — including the thin trial entry layer, even when Growth created or modified it.** Contributing entry-layer code does not transfer any CustomersDot support burden to Growth. This keeps CustomersDot on-call and incident response under a single owner and avoids fragmenting responsibility for a production system that backs paying customers.
{{% /alert %}}

Practically:

- Fulfillment/Monetization is the DRI for the operability and long-term maintainability of the entire CustomersDot trial codebase (instrumentation, alerting, dashboards, performance, incident response, and on-call), including the trial entry endpoint and basic controller.
- Support issues, bug reports, and incidents touching any part of CustomersDot — entry layer included — are triaged and owned by Fulfillment/Monetization. Growth assists on entry-layer specifics when asked, but is not the support DRI.
- Growth instruments the **product analytics and experiment tracking** for the entry points it owns, even when those events fire from shared code; Growth coordinates with Fulfillment/Monetization on placement and review.
- When Growth contributes a feature into the trial codebase, Fulfillment/Monetization inherits the sustaining and support ownership of that code (see the decision framework below), so Growth contributions should meet the codebase owner's quality, test, and observability standards.

### Trial request lifecycle: who owns each hop

The clearest way to apply the model is to trace a trial request end to end. Ownership follows the **function** of each step (initiating the trial vs. fulfilling it), **not the repository the code lives in**. A useful tell: an outbound call *from GitLab to CustomersDot to start a trial* is a Growth entry point, while an inbound call *from CustomersDot back into GitLab to provision the result* is Fulfillment/Monetization, even though that provisioning code executes inside GitLab.

| # | Step in the trial flow | Where the code runs | Owner |
| --- | --- | --- | --- |
| 1 | Trial UI/UX — the trial form, CTAs, upgrade prompts, onboarding | GitLab | **Growth** |
| 2 | Building and sending the trial submission from GitLab to CustomersDot | GitLab | **Growth** |
| 3 | Receiving the submission at the CustomersDot trial entry endpoint and basic controller (create/modify the initial submission handling and routing) | CustomersDot | **Growth** |
| 4 | Trial creation, eligibility enforcement, entitlement granting, and provisioning logic behind the entry point | CustomersDot | **Fulfillment/Monetization** |
| 5 | Billing, subscription, and lifecycle handling for the trial | CustomersDot | **Fulfillment/Monetization** |
| 6 | The provisioning that reaches back into GitLab to update the namespace, licensing, and plan/add-on state | GitLab | **Fulfillment/Monetization** |
| 7 | Operability and support for the whole flow — monitoring, alerting, incidents, on-call (not including GitLab entry layer) | GitLab + CustomersDot | **Fulfillment/Monetization** |

In short: **Growth owns the UI/UX and the act of submitting a trial to CustomersDot (steps 1–3). Fulfillment/Monetization owns everything the submission triggers — creation, entitlement, billing, and the provisioning callback that updates the GitLab namespace/license (steps 4–6) — plus support for all of it (step 7).**

For end-to-end worked examples that combine the ownership call with the steps to follow, see [Worked Examples](#worked-examples) below.

## Decision Framework

The conceptual ownership model above defines *accountability*. This decision framework is its practical application for **contributing to shared codebases** (primarily CustomersDot): when Growth can contribute directly versus when it must engage Fulfillment/Monetization as the codebase owner. Even when Growth contributes directly, sustaining ownership of the merged code stays with Fulfillment/Monetization.

### Growth Contributes Independently

Growth team members can contribute directly for changes that are isolated to the **trial entry layer** — the GitLab-app trial surfaces and the thin CustomersDot trial entry endpoint and basic controller — and do not reach into provisioning, entitlement, billing, or shared systems.

**Examples of Growth-owned changes:**

1. **Trial entry endpoint and basic controller**: Changes to the CustomersDot endpoint and basic controller that receive and route a trial request, as long as they do not change provisioning, entitlement, or billing behavior
1. **Trial entry eligibility checks**: Entry-level gating of who can *start* a trial (for example, domain restrictions, user attributes, or geographic limitations) at the entry point, distinct from how entitlements are granted downstream
1. **Trial UX and entry flow**: The trial sign-up flow, onboarding experience, and trial-to-paid conversion surfaces
1. **Trial tracking and analytics**: Instrumentation, analytics events, or experiment tracking for trial entry and conversion behavior
1. **Trial-entry messaging**: Copy, email templates, or in-app messaging related to starting a trial
1. **Trial feature flags**: Feature flags that control trial entry-point functionality or experiments

When a change starts at the entry layer but needs deeper behavior (for example, a new eligibility rule that must be enforced in provisioning, or a duration change that affects how the trial is provisioned), it crosses into the codebase owner's domain — see [Engage the Codebase Owner](#engage-the-codebase-owner-fulfillmentmonetization).

**Process for independent contributions:**

1. Follow standard GitLab [contribution guidelines](../../workflow/code-review/)
2. Apply appropriate labels: `devops::growth`, `group::activation` (or relevant Growth group), `CustomersDot`
3. Notify Fulfillment/Monetization in [#s_fulfillment](https://gitlab.slack.com/channels/s_fulfillment) for awareness
4. Ensure code review includes a Fulfillment/Monetization maintainer when touching the CustomersDot codebase

### Engage the Codebase Owner (Fulfillment/Monetization)

Growth must engage the trial codebase owner in Fulfillment/Monetization for changes that affect billing, subscriptions, provisioning infrastructure, or shared systems that impact paying customers.

{{% alert title="A note on team names" color="info" %}}
This page refers to the trial codebase owner as **Fulfillment/Monetization**, reflecting the centralized ownership model. The team that performs this work today operates under the Fulfillment organization (historically the Provision team). Links below point to the current Fulfillment/Provision handbook pages until the restructure is fully reflected in the handbook.
{{% /alert %}}

**Examples of codebase-owner changes:**

1. **Billing integration**: Any changes to Zuora integration, payment processing, or invoice generation
1. **Subscription provisioning**: Modifications to how subscriptions are created, activated, or managed
1. **License generation**: Changes to license key generation, validation, or distribution
1. **Zuora integration**: Any work involving Zuora API calls, data synchronization, or billing workflows
1. **Shared infrastructure**: Database schema changes, API endpoints used by multiple systems, or core CustomersDot services
1. **Compliance and security**: Changes affecting PCI compliance, data privacy, or security controls

**Process for engaging Fulfillment/Monetization:**

1. Create an issue in the [fulfillment-meta](https://gitlab.com/gitlab-org/fulfillment-meta) project using the appropriate intake template
2. Reach out in [#s_fulfillment](https://gitlab.slack.com/channels/s_fulfillment) to discuss the request
3. Schedule a sync meeting if needed to align on approach and timeline
4. Follow the codebase owner's [project management process](../fulfillment/provision/#project-management-process)
5. Collaborate on implementation with Fulfillment/Monetization team members as DRIs

### Judgment Call / Consultation

When uncertain about whether a change falls into Growth's domain or requires Fulfillment/Monetization involvement, err on the side of consultation. Consider the following factors:

**Consult with Fulfillment/Monetization if:**

1. The change could impact billing accuracy or revenue recognition
1. You're unsure about the "blast radius" of the change (how many users/systems it affects)
1. The change involves domain knowledge specific to provisioning, licensing, or billing
1. There's potential for the change to affect paying customers or production systems
1. The change modifies shared code paths or infrastructure

**How to consult:**

1. Post a brief description in [#s_fulfillment](https://gitlab.slack.com/channels/s_fulfillment) with the issue link
2. Tag relevant Fulfillment/Monetization team members (PM, EM, or engineers familiar with the area)
3. Request a quick sync if needed to discuss approach
4. Document the decision in the issue for future reference

## Escalation Paths

When priority conflicts arise or Growth needs to move faster than the codebase owner's current capacity allows, use the following escalation paths:

### Level 1: Direct Contribution

**When to use:** Growth has the capability to implement the change but needs the codebase owner's review and approval.

**Process:**

1. Growth implements the change following CustomersDot contribution guidelines
2. Request review from Fulfillment/Monetization maintainers
3. Address feedback and iterate as needed
4. Fulfillment/Monetization reviews for correctness and potential impact
5. Merge with codebase-owner approval

**Timeline:** Typically 1-2 milestones depending on complexity

### Level 2: Leadership-Level Reprioritization

**When to use:** The work requires Fulfillment/Monetization implementation but is blocked by capacity or competing priorities.

**Process:**

1. Growth PM escalates to Growth Product Director
2. Growth Director engages with Fulfillment Product Director to discuss priorities
3. Joint assessment of business impact and urgency
4. Reprioritization decision made at Director level
5. Fulfillment/Monetization adjusts milestone planning accordingly

**Timeline:** Typically requires 1 milestone for planning + implementation time

### Level 3: Resource Allocation Adjustments

**When to use:** Persistent capacity constraints require structural changes to team composition or responsibilities.

**Process:**

1. Directors identify the ongoing capacity gap
2. Evaluate options: temporary team member loans, hiring, or reorganization
3. Escalate to VP level if cross-department resource allocation needed
4. Implement agreed-upon resource adjustments
5. Document new responsibilities and handoffs

**Timeline:** Typically 1-2 quarters for structural changes

## Collaboration Process

### Communication Channels

1. **Primary Slack channels:**
   - [#s_growth](https://gitlab.slack.com/channels/s_growth) - Growth team channel
   - [#s_fulfillment](https://gitlab.slack.com/channels/s_fulfillment) - Fulfillment/Monetization team channel
   - Use these channels for questions, collaboration requests, and status updates

2. **Issue tracking:**
   - Growth issues: [gitlab-org/gitlab](https://gitlab.com/gitlab-org/gitlab) with `devops::growth` label
   - Fulfillment/Monetization issues: [gitlab-org/fulfillment-meta](https://gitlab.com/gitlab-org/fulfillment-meta)
   - CustomersDot issues: [gitlab-org/customers-gitlab-com](https://gitlab.com/gitlab-org/customers-gitlab-com)

### Regular Touchpoints

Growth and Fulfillment/Monetization teams should maintain regular communication through:

1. Async updates in shared Slack channels
2. Mentions on relevant issues and merge requests
3. Quarterly planning alignment sessions
4. Ad-hoc sync meetings as needed for complex initiatives

### Code Review Process

1. All CustomersDot changes require review from a Fulfillment/Monetization maintainer (the codebase owner)
2. Growth engineers should request review from Fulfillment/Monetization team members familiar with the affected area
3. Fulfillment/Monetization commits to timely reviews (within 2 business days for standard changes)
4. For urgent changes, coordinate in [#s_fulfillment](https://gitlab.slack.com/channels/s_fulfillment) to expedite review

## Worked Examples

These examples combine the **ownership call** (mapped to the [lifecycle steps](#trial-request-lifecycle-who-owns-each-hop)) with **what to actually do**. They span both engineering and product decisions. Use them as patterns; when a new situation doesn't match cleanly, fall back to the lifecycle table and the [Decision Framework](#decision-framework).

### Growth contributes independently (entry layer, steps 1–3)

These stay in Growth's domain because they're isolated to the entry layer and don't change provisioning, entitlement, or billing.

**Trial duration or entry-eligibility experiment** — for example, testing a 30→60 day trial for a segment, or gating who can *start* a trial by company size at the entry point.

- **Owner:** Growth (steps 1–3). *Caveat:* if a duration or eligibility rule must be **enforced during provisioning/entitlement**, that enforcement is step 4 → engage Fulfillment/Monetization. Eligibility that could affect sales/lead routing is a judgment call — consult first (see below).
- **What to do:** Create an issue with the experiment plan → implement the entry-layer change and analytics → post in [#s_fulfillment](https://gitlab.slack.com/channels/s_fulfillment) for awareness → request a Fulfillment/Monetization maintainer review for any CustomersDot change → deploy and monitor.

**Add a field to the trial form and pass it to CustomersDot.**

- **Owner:** Growth — GitLab UI + submission payload (steps 1–2) and the CustomersDot entry endpoint/controller that accepts it (step 3). If the field must *change how the trial is provisioned or entitled*, step 4 is involved → engage Fulfillment/Monetization.
- **What to do:** Implement the form + submission change → extend the entry controller to accept the field → request maintainer review → if it influences provisioning, open a fulfillment-meta issue to coordinate step 4.

**Add analytics/experiment tracking on trial start and conversion.**

- **Owner:** Growth — product analytics for the entry points it owns, even when events fire from shared code (step 1–3).
- **What to do:** Implement events per GitLab instrumentation guidelines → coordinate placement/review with Fulfillment/Monetization for any shared-code touchpoints → standard maintainer review → validate events fire correctly.

### Engage Fulfillment/Monetization (codebase, steps 4–6)

These require the codebase owner because they touch provisioning, entitlement, billing, or the provisioning callback into GitLab.

**Trial-to-paid conversion / subscription creation flow.**

- **Owner:** Fulfillment/Monetization (steps 4–5). Touches subscription creation and billing; can affect revenue recognition.
- **What to do:** Open an issue in [fulfillment-meta](https://gitlab.com/gitlab-org/fulfillment-meta) → sync with Fulfillment/Monetization PM + engineers → collaborate on design → Fulfillment implements or closely reviews → joint testing → coordinated deployment.

**Trial namespace isn't getting the right add-on/tier after submission; or wrong license/seat count or subscription record.**

- **Owner:** Fulfillment/Monetization — the provisioning callback into GitLab (step 6) and the entitlement/billing logic (steps 4–5), fully owned even though step 6 runs in the GitLab repo.
- **What to do:** Route to Fulfillment/Monetization as the codebase + support DRI → Growth provides entry-layer/submission context if the issue originates at the handoff (step 3↔4 boundary).

### Shared work — split along the boundary

**Existing paid customer trials an add-on or higher tier from in-product.**

- **Owner:** Shared. Growth owns the in-product expansion/upgrade surface that initiates the add-on trial (entry point, steps 1–3); Fulfillment/Monetization owns the entitlement, provisioning, and billing of granting it (steps 4–6). This is the existing-paid-customer state of the model.
- **What to do:** Growth implements + instruments the entry point/CTA → engage Fulfillment/Monetization for entitlement and provisioning → align on the **submission contract** (how the trial entitlement is granted, tracked, expired) → joint review → coordinated deployment.

**A new trial type with both a new entry experience and new provisioning.**

- **Owner:** Shared — split the work. Growth scopes the entry points (steps 1–3); Fulfillment/Monetization scopes creation/entitlement/provisioning (steps 4–6).
- **What to do:** Agree on the submission contract between the two halves up front → track as linked issues across both backlogs → align on milestones since the entry-point change usually depends on the provisioning side.

### Judgment call — consult first

**Entry-layer eligibility that could affect sales workflows or lead routing** — for example, restricting trials for large companies to push direct sales engagement.

- **Owner:** Growth entry-point concern, but with downstream implications → consult Fulfillment/Monetization (and sales stakeholders) before building.
- **What to do:** Post the proposal in [#s_fulfillment](https://gitlab.slack.com/channels/s_fulfillment) → tag the Fulfillment/Monetization PM → quick sync on impacts → document the decision in the issue, then proceed based on the outcome.

### Fulfillment/Monetization owns outright (sustaining + support, step 7)

**The CustomersDot trial endpoint is failing / slow / lacks alerting.**

- **Owner:** Fulfillment/Monetization — observability, performance, incidents, and on-call for the trial codebase, **including the entry endpoint Growth wrote** (step 7). Contributing entry-layer code does not transfer support burden to Growth.
- **What to do:** Fulfillment/Monetization owns the incident and the operability fix and scopes the instrumentation/performance work → Growth shares entry-point context or analytics needs and assists on entry-layer specifics on request → Fulfillment implements and owns the resulting alerting/dashboards.

**Customer-reported trial issues** (didn't provision, wrong entitlement, billing problem).

- **Owner:** Fulfillment/Monetization as the CustomersDot support DRI, regardless of which team built the entry point.
- **What to do:** Triage in Fulfillment/Monetization → pull in Growth only if the root cause is in the entry layer (steps 1–3).

## Resources

### Related Documentation

- [Provision team handbook](../fulfillment/provision/) - Provision team processes and project management
- [Growth team handbook](./) - Growth team processes and experimentation guidelines
- [Growth experimentation guidelines](./experimentation/) - How Growth runs experiments
- [Fulfillment project management process](../fulfillment/#project-management-process) - Fulfillment intake and planning
- [Growth-Feature Product Owner collaboration process](../../../product/groups/growth/#collaboration-process-with-other-product-teams) - General Growth collaboration model

### Technical Resources

- [CustomersDot repository](https://gitlab.com/gitlab-org/customers-gitlab-com) - Main CustomersDot codebase
- [CustomersDot architecture documentation](https://gitlab.com/gitlab-org/customers-gitlab-com/-/tree/main/doc) - Technical documentation
- [Provision Tracking System monitoring](https://gitlab.com/gitlab-org/customers-gitlab-com/-/blob/main/doc/provision_tracking_system/failure_monitoring.md) - PTS monitoring guide

### Key Contacts

- **Growth Product Director:** See [Growth team handbook](./#leadership)
- **Growth Engineering Director:** See [Growth team handbook](./#leadership)
- **Trial Codebase Engineering Manager (Fulfillment/Monetization):** See [Provision team handbook](../fulfillment/provision/#team-members)
- **Fulfillment/Monetization Product Management:** See [Provision stable counterparts](../fulfillment/provision/#stable-counterparts)

## Feedback and Iteration

This framework is a living document. As we learn from our collaboration, we'll iterate and improve these guidelines. Suggestions for improvements can be proposed through:

1. Issues in [gitlab-org/fulfillment-meta](https://gitlab.com/gitlab-org/fulfillment-meta)
2. Discussion in [#s_growth](https://gitlab.slack.com/channels/s_growth) or [#s_fulfillment](https://gitlab.slack.com/channels/s_fulfillment)
3. Direct feedback to Growth or Fulfillment/Monetization leadership

Following GitLab's value of [iteration](../../../values/#iteration), we encourage teams to try this framework, gather feedback, and propose improvements based on real-world experience.
