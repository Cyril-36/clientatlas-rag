---
slug: engineering-ai-ai-model-services
title: "AI Model Services Group"
source_url: "https://handbook.gitlab.com/handbook/engineering/ai/ai-model-services/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---

title: AI Model Services Group
description: "The AI Model Services group owns GitLab Duo's customer-facing model operations/intelligence layer, which models are available and how they're selected, the health and connectivity of the customer experience, and the gateway service surface (prompts, internal events, and AIGW billing)."
---

## Vision

The AI Model Services group focuses on additional, custom models that power GitLab Duo functionality in support of our customers' unique data and use-cases.

## Mission, what we own

AI Model Services is the end-to-end owner of GitLab's **customer-facing model intelligence layer**: which models are available, how they're selected, the health and connectivity of the customer experience, and the gateway service surface (prompts, internal events, and AIGW billing). One team, full stack, across Customer zero, SaaS, Self-Managed, and Dedicated.

We are responsible for all backend aspects of the product categories that fall under the [AI Model Services group](/handbook/product/categories/#ai-model-services-group) of the [AI Powered stage](/handbook/product/categories/#ai-powered-stage) of the [DevOps lifecycle](/handbook/product/categories/#devops-stages). Our product direction is on the [Category Direction, AI Model Services Management](https://about.gitlab.com/direction/ai-powered/custom_models/) page, and the features we work with are listed on the [Features by Group page](/handbook/product/categories/features/#custom-models).

## Organisation

The group is organised into three functional teams. Each functional team owns its scope end-to-end, including the Requests for Help (RFHs) and support escalations in its area (see [Customer support](#customer-support--requests-for-help)). Staff Engineers are expected to support multiple functional teams as needed.

### Model Selection

Owns which models are available and how they're chosen, across `.com` and self-hosted.

| Scope            |                                                                                   |
| ---------------- | --------------------------------------------------------------------------------- |
| Model lifecycle  | Model additions/removals across Customer Zero,`.com`, Self-Managed, and Dedicated |
| Selection Engine | Unit Primitives, large/small models, agents                                       |
| Selection UI     | Customer zero, SaaS, Self-Managed, Dedicated                                      |
| Supporting       | Prompts, evals, and docs for newly added models                                   |

Evaluation results from Model Evaluation Infra feed selection decisions through a shared review cadence between the two groups (see [What falls outside our scope](#what-falls-outside-our-scope)).

### Health & Connectivity

Owns the diagnostic surface and the wider class of customer-facing setup and connectivity issues.

| Scope            |                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Diagnostics      | Duo Health Check diagnostic surface                                                                                           |
| Setup & config   | Customer setup and configuration                                                                                              |
| Connectivity     | Connectivity across GitLab / AIGW / Models / DWS                                                                              |
| Operations       | Debugging, version drift, and related support escalations                                                                     |
| LLMOps Expanding | Monitoring, observability, and tracking LLM performance, identifying errors, and optimizing models connectivity down the line |

"Health" is deliberately broad: it covers the diagnostic surface _and_ the failure modes those diagnostics are meant to surface, so the people building the diagnostics are the same people fielding the issues.

### Gateway Services

Owns the event-driven surfaces that sit on top of the gateway, prompts flowing in, telemetry flowing through, and billing/credit events flowing out.

| Scope           |                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt Registry | Prompt management on the gateway                                                                                                          |
| Telemetry       | Internal events and tracking                                                                                                              |
| AIGW billing    | The AIGW side of billing, metering and billing events for self-hosted billing, SaaS billing, on-demand credits, and AWS Marketplace flows |

> **Billing boundary:** Gateway Services owns the **AIGW side** of billing (metering and billing events). The purchasing and subscription side, buying, plan management, is owned by the **Fulfillment** team.
> **Instrumentation boundary:** Analytics Instrumentation owns the tooling, internal events (Snowplow), billing-events tooling, and Service Ping collection. We own the domain-specific events, billing events, and metrics for the gateway/AIGW surface and instrument them using that tooling.

### How we're organised into functional teams

**Acting Engineering Manager:** Mohamed Hamda

**Engineering Manager & Engineers**

{{< team-by-manager-slug "mhamda" >}}

**Staff Engineer (cross-team):** Manoj M J, contributes across functional teams, taking on initiatives wherever they're most needed.

| Functional team       | Members                                        |
| --------------------- | ---------------------------------------------- |
| Model Selection       | Julie Huang; Manoj M J (supporting)            |
| Health & Connectivity | Cindy Halim, Newick Lee; Manoj M J (main team) |
| Gateway Services      | Patrick Cyiza; Manoj M J (supporting)          |

### Stable Counterparts

The following members of other functional teams are our stable counterparts:

| **Name**     | **Role**                                                                       |
| ------------ | ------------------------------------------------------------------------------ |
| Jordan Janes | [Principal Product Manager](/job-description-library/product/product-manager/) |

## What falls outside our scope

To make boundaries clear for teams inside and outside the org, the following areas are owned by counterpart teams. When work touches these areas, loop in the listed owner.

| Area                                                                   | Owner                                                                                                    | Relationship to AI Model Services                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Subscription purchase / buying flows, plan management                  | Fulfillment                                                                                              | Counterpart for Gateway Services. We own AIGW-side billing/metering; they own purchasing and subscriptions. |
| Product analytics tooling & instrumentation                            | [Analytics Instrumentation](/handbook/engineering/data-engineering/analytics/analytics-instrumentation/) | Counterpart for Gateway Services. We use their tooling for internal events and tracking.                    |
| Raw gateway infrastructure, routing, streaming, self-hosted AIGW       | AI Platform Engineering (Duo Service Infra)                                                              | They own the gateway as infrastructure; we own the customer-visible service surface that runs on top of it. |
| Model evaluation infrastructure, CEF as a service, benchmark pipelines | AI Platform Engineering (Model Evaluation Infra)                                                         | They run and maintain evaluation infra; we consume the results to drive model selection.                    |

## How to reach us

- Issue Tracker: [`~group::ai model services`](https://gitlab.com/dashboard/issues?sort=title_asc&state=opened&label_name[]=group::ai+model+services)
- Slack Channel: [#g_custom_models](https://gitlab.enterprise.slack.com/archives/C06DCB3N96F)
- Label Subscription: [`~group::ai model services`](https://gitlab.com/groups/gitlab-com/-/labels?subscribed=&search=group%3A%3Aai+model+services)

### Organisational Labels

Issues owned by the AI Model Services group should have these labels, as appropriate:

- `~"group::ai model services"`
- `~"devops::ai-powered"`
- `~"category:ai gateway services"`
- `~"category:model selection"`
- `~"category:health & connectivity"`
- `~"category:health & connectivity"`
  In addition, issues should contain the relevant `~type:` and subtype labels.

## How we work

Our operating framework keeps ownership visible, keeps the team honest on progress, and makes space to push back when priorities don't make sense, without adding bureaucracy.

### Directly Responsible Individuals (DRIs)

Every issue, feature, bug fix, or initiative the team is actively working on has a single named **DRI**. The DRI is not necessarily the person doing all the work, they are the person responsible for driving it forward and keeping it unblocked.

Being a DRI means:

- You own the **outcome**, not just the task. If it's stuck, you raise it, you don't wait to be asked.
- You update the planning issue with status at least once a week.
- You can delegate work, but accountability stays with you.
- You can (and should) push back if scope, priority, or timeline doesn't make sense, with a clear explanation of why.

How DRIs get assigned:

- **New issues:** discussed at the weekly sync; someone volunteers or is proposed. If no one volunteers, we discuss why, maybe it isn't actually a priority, or the team is overloaded.
- **RFHs and escalations:** the triage DRI in the relevant functional team either takes ownership or explicitly hands it off with context.
- DRI assignment is tracked on the team's planning issue, the single source of truth for who owns what.

Reassigning a DRI is a normal, low-friction thing, not a political event. It should happen **explicitly** (not by drift) and with enough context handed over that the new DRI isn't starting from scratch.

### Weekly status updates

Each active DRI posts a short async update on the team planning issue, a few lines, not a novel:

- What moved forward this week
- What's blocked and what you need
- What's next for the coming week

Example:

---

**Async Status Update YYYY-MM-DD**

**issue-title (link)**

- Progress: ...
- Blockers: ...
- Confidence for current milestone: 🟡 Slightly confident

**issue-title (link)**

- Progress: ...
- Blockers: ...
- Confidence for current milestone: 🟢 Very confident

**Confidence key:** 🔴 Not confident · 🟡 Slightly confident · 🟢 Very confident

---

Async updates on the planning issue are the default and the single place to see the state of all active work. The existing engineering sync is used mainly to raise hands on blockers; attendance is optional, and nothing else changes if you can't join (for example, timezones).

### Raising hands early

If you're stuck, overloaded, or realize the work is bigger than expected, raise your hand. This is how a healthy team operates, not a sign of failure:

- Flag it in your weekly update.
- Ping the team in Slack with a clear ask: "I need help with X" or "I need someone to take over Y because Z."
- Blocked items get discussed first at the weekly sync.

### Pushing back, and quality over quantity

The team is empowered to push back on work that doesn't align with current priorities or that would compromise quality:

- Push back comes with a **reason** ("We can't take this on this milestone because we're committed to X and Y").
- It's directed at the work, not the person requesting it.
- It's documented (a comment on the issue is enough) so there's a record of the decision.

We resist the pressure to add new models or configurations until the existing ones are solid. New model onboarding goes through a lightweight readiness check:

1. Is the documentation complete?

1. Are known issues resolved?

1. Is support equipped to handle tickets?

"We're not adding this yet; here's what we need to get right first" is a valid and encouraged answer.

### Cadence

| Activity                                   | Frequency      | Owner                          |
| ------------------------------------------ | -------------- | ------------------------------ |
| Weekly sync (review blockers, assign DRIs) | Weekly         | EM                             |
| Status update on planning issue            | Weekly (async) | Each active DRI                |
| Triage of new RFHs / escalations           | Ongoing        | Triage DRI per functional team |
| Retrospective on process health            | Monthly        | Team                           |

## Scoping work using Epics and Tech Leads

Epics are the primary definition of scope for any work item larger than a single issue, a new feature, a complex refactor, or a bug. The issues in the epic constitute the entire scope of the work item; when they are all closed the work is complete and the epic is closed. An epic should enclose an iteration that adds a clear improvement, but an epic does not necessarily represent a whole feature, which might require multiple epics.

Technical ownership of the work defined by an epic is delegated to a **Tech Lead**, an engineer who is assigned to the epic and ensures the scope is correct. The Tech Lead works with the EM, the PM, and other engineers. Any engineer on the team can work on the issues in the epic, self-assigned using the Kanban process, including the Tech Lead themselves.

## Team Milestone Planning Process

AI Model Services follows the [Product Development Flow](/handbook/product-development/how-we-work/product-development-flow/) and [Cross Functional Prioritization](/handbook/engineering/workflow/cross-functional-prioritization/). The team uses a planning issue and boards to manage the planning process. [Planning automation](https://gitlab.com/gitlab-org/ai-powered/custom-models/custom-models/-/blob/main/doc/planning/index.md) scripts are available to make this easier.

[Planning issues](https://gitlab.com/groups/gitlab-org/-/epics/13440) for each milestone are created by the PM and used to coordinate upcoming work between the PM, EM, and stable counterparts.

During each milestone, planning is completed for the next milestone:

1. Creation of planning issues and boards (EM or PM)
1. Refinement issues created every week with [automation](https://gitlab.com/gitlab-org/ai-powered/custom-models/custom-models/-/merge_requests/95)
1. Identification of candidate issues for the milestone and addition to the Planning Board (PM, EM)
1. Team member capacity planning (EM)
1. Estimation of effort using weights (Engineers and EM)
1. Joint planning session to finalise the planning board (PM, EM)
1. Assignment of work to engineers, addition of the `~Deliverable` label, update to the planning issue (EM)

### Planning Issue

Each month a planning issue is created by the PM using automation and the [AI Model Services Planning template](https://gitlab.com/gitlab-org/ai-powered/custom-models/custom-models/-/blob/main/.gitlab/issue_templates/milestone-planning-template.md). This is the discussion area for the planning team members (PM, EM) for a specific milestone and links to the Planning and Build Boards.

### Planning Board

The [Planning Board](https://gitlab.com/groups/gitlab-org/-/boards/7762631?milestone_title=17.7&label_name[]=group%3A%3Acustom%20models) is created for each milestone by the PM and is a curated list of issues by category. It can be overloaded with issues; the excess is moved to the next milestone or to the Next 1-3 Milestones board during the planning call.

The PM marks issues with `~workflow::planning breakdown`, signaling to the EM to request engineers to review the issue description and ensure it's clear and ready for development. The engineer then assigns a weight and applies the `~workflow::ready for development` label.

### Ready for Development Status

Issues ready to be worked on are labeled `workflow::ready for development`. Only issues with this label should be assigned to an engineer as a Deliverable. If research is required, the `~spike` label is assigned; the scope of the spike should be clearly stated, and the outcome might be code or a refined issue.

### Capacity Planning

The EM maintains a method for calculating team capacity and assigning work lanes to the release based on priority. The EM posts the team capacity and DRIs on the planning issue.

### Build Board

The EM selects issues from the [Planning Board](#planning-board) based on previous-milestone slippage, PM preference, weight, and priority. The EM then applies the `~Deliverable` label to each issue in the release and assigns it to an engineer. Issues are tracked throughout the release with the Build Board.

### Say / Do Ratio

The Say / Do ratio is calculated using `Completed Issues / Assigned Issues`:

- Issues added to the Build Board with the `~Deliverable` label are the Assigned Issues.
- Issues closed by the end of the milestone are the Completed Issues.

### Issue Weights

A weight is assigned to each issue as an estimate of work to close it. A weight of 1 is approximately 2 working days of effort. Issues are generally not weighted above 3, larger weights indicate the issue should be broken down further.

### Planning and Delivery Boards

All workflow statuses in the [Product Development Flow](/handbook/product-development/how-we-work/product-development-flow/) are valid. The [Next 1-3](https://gitlab.com/groups/gitlab-org/-/boards/7472817?milestone_title=Next%201-3%20releases&label_name[]=group%3A%3Acustom%20models) and [Next 4-6 milestones](https://gitlab.com/groups/gitlab-org/-/boards/7472821?milestone_title=Next%204-6%20releases&label_name[]=group%3A%3Acustom%20models) boards house issues which need refinement or are ready to be worked on.

| Board               | Filters                                                | Columns                                                                                                                                                     |
| ------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planning Board      | Milestone, `~group::ai model services`                 | `~type::bug`, `~type::maintenance`, `~type::feature`                                                                                                        |
| Build Board         | Milestone, `~group::ai model services`, `~Deliverable` | `~workflow::ready for development`, `~workflow::in dev`, `~workflow::in review`, `~workflow::awaiting security release`, `~workflow::blocked`               |
| Next 1-3 Milestones | `%Next 1-3 Milestones`                                 | `~workflow::problem validation`, `~workflow::design`, `~workflow::solution validation`, `~workflow::planning breakdown`, `~workflow::ready for development` |
| Next 4-6 Milestones | `%Next 4-6 Milestones`                                 | Same as Next 1-3 Milestones                                                                                                                                 |

### Issue Milestones

- Issues are assigned the current or next milestone if they are planned to be or are currently being worked on.
- `%Backlog` is assigned if issues are not intended to be worked on, although they may be addressed by a community contribution.
- `%Awaiting Customer Feedback` may be worked on, pending customer interest.

The [issue triage report](https://gitlab.com/gitlab-org/quality/triage-reports/-/issues/17099) highlights issues that need a milestone assignment.

## Customer support & Requests for Help

To better support calls with customers (existing and prospective), AI Model Services provides engineers who prioritise customer support requests, so that load and knowledge are shared across the team.

**RFHs are owned by the functional team whose scope they fall under**, Gateway Services handles gateway RFHs, Health & Connectivity handles setup/connectivity RFHs, and so on. Each functional team assigns a **triage DRI** who either drives the RFH to resolution or explicitly hands it off with context. Support requests should be acknowledged within 24h.

To request help for a customer, create a [request for help issue](https://gitlab.com/gitlab-com/request-for-help/-/issues/new?description_template=SupportTemplateRequest-SelfHostedModels) and share it in [#g_custom_models](https://gitlab.enterprise.slack.com/archives/C06DCB3N96F). Don't hesitate to ask for help from other team members in the same channel.

### Responsibilities of the triage DRI in support

- Triage [Requests for Help](https://gitlab.com/gitlab-com/request-for-help/-/issues/?sort=created_date&state=opened&label_name%5B%5D=group%3A%3Acustom%20models&first_page_size=20).
- Monitor incoming requests in [#g_custom_models](https://gitlab.enterprise.slack.com/archives/C06DCB3N96F) and [#custom_model_rfh](https://gitlab.enterprise.slack.com/archives/C0B4URWF2PN).
- Make sure request-for-help issues are created.
- Answer support questions on Slack, redirecting to documentation whenever possible.
- Join customer calls led by Solution Architects or Sales reps when needed, and own communication with the customer until it's resolved or handed to a support engineer.
- Act on outcomes:
  1. Can we add documentation to help SAs and customers be more self-sufficient?
  1. Could better tooling help? Create an issue with the changes needed.
  1. Was it a bug we didn't catch? How do we avoid it next time?
- Notify the EM in advance if you won't be available.
- Hand over the necessary context to the next engineer in support.

It is **not** expected for engineers in support to:

- Be available outside their preferred working hours, though some requests may be urgent and should be tackled first thing on the next working day. Consult the EM and PM in those situations.
- Lead customer calls, unless agreed for a specific case.
- Present demos, unless agreed for a specific case.

## Communication

AI Model Services communicates based on the following guidelines:

1. Always prefer async communication over sync meetings.
1. Don't shy away from arranging a [sync call](#ad-hoc-sync-calls) when async is proving inefficient, but try to record it to share with team members.
1. [Transparency by Default](/handbook/security/transparency-by-default/).
1. The primary channel for work-related communication is the [#g_custom_models](https://gitlab.enterprise.slack.com/archives/C06DCB3N96F) Slack channel.
1. Internal team issues and projects are namespaced under [`gitlab-org/ai-powered/custom-models`](https://gitlab.com/gitlab-org/ai-powered/custom-models).

## Acknowledgement of Pings

If you are pinged by name in either Slack or GitLab, please acknowledge it with either a threaded comment or an emoji.

## Time Off

Team members should add any [Paid Time Off](/handbook/people-group/time-off-and-absence/time-off-types/) in the "Workday" Slack app, so the EM can use the proper number of days off during capacity planning. Where possible, add time off a full milestone in advance.

There can always be last-minute, unplanned PTO needs. Please take any time you need, but enter it into Workday and communicate with the EM as soon as you can.

## Ad-hoc sync calls

We operate using async communication by default. There are times when a sync discussion is beneficial, and we encourage team members to schedule sync calls with the required people as needed.

## Blog Posts

Blog posts written by AI Model Services team members:

- [Developing GitLab Duo: How we validate and test AI models at scale](https://about.gitlab.com/blog/2024/05/09/developing-gitlab-duo-how-we-validate-and-test-ai-models-at-scale/), [@susie.bee](https://gitlab.com/susie.bee)
- [GitLab Duo Self-Hosted: Enterprise AI built for data privacy](https://about.gitlab.com/blog/2025/02/27/gitlab-duo-self-hosted-enterprise-ai-built-for-data-privacy/), [@susie.bee](https://gitlab.com/susie.bee)
- [Speed meets governance: Model Selection comes to GitLab Duo](https://about.gitlab.com/blog/speed-meets-governance-model-selection-comes-to-gitlab-duo/), [@susie.bee](https://gitlab.com/susie.bee)
