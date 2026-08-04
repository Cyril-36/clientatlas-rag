---
slug: security-product-security-security-platforms-architecture-product-security-engineering
title: "Product Security Engineering"
source_url: "https://handbook.gitlab.com/handbook/security/product-security/security-platforms-architecture/product-security-engineering/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---
title: "Product Security Engineering"
description: "Product Security Engineering Team Charter"
---

Product Security Engineering (ProdSecEng) is a team within [Product Security](/handbook/security/product-security/) (ProdSec), reporting to the VP of Product Security.

## Mission statement

ProdSecEng builds and ships high-value security capabilities into the GitLab product that address security risk. We work directly with Product and Engineering to turn security requirements, risk insights, and internal expertise into product improvements and features that benefit both GitLab and our customers.

We follow GitLab's [engineering workflow](/handbook/engineering/workflow/) and contribute code alongside the teams that will own the features long-term.

## Value proposition

We bring hands-on security engineering directly into the product development process. ProdSec teams identify risks and requirements; ProdSecEng turns those into shipped product features. This means security capabilities reach customers faster, Product and Engineering get a dedicated security engineering partner, and ProdSec can validate GitLab's own product for their workflows.

## Focus areas

Our work is driven by epics that address high-value security risk and align with the direction of Product and Engineering. Specific focus areas are set during milestone planning and informed by the [Product Security Risk Register (PSRR)](/handbook/security/product-security/security-platforms-architecture/risk-register/) and cross-team discussions.

## Scope and responsibilities

### What we own

ProdSecEng owns the delivery of security engineering work that ships into the GitLab product:

1. **Co-create and deliver security product contributions**: Contributions can be improvements that reduce GitLab's product risk, or solutions that make it easier for our customers and development teams to follow security practices by default. We follow the [co-create workflow](/handbook/security/product-security/security-platforms-architecture/security-interlock/prodsec-to-product-workflow/#co-create-workflow), and align with Engineering and Product on work that complements their roadmap.
1. **Product validation (Customer Zero)**: Validating GitLab security features through [Security Interlock](/handbook/security/product-security/security-platforms-architecture/security-interlock/) initiatives, where ProdSec acts as Customer Zero.
1. **Proof of concepts**: Validating proposed security solutions before broader implementation or handoff.
1. **Documentation and knowledge transfer**: Creating and maintaining documentation, runbooks, and guides for our contributions.

> **Transition: custom tooling (effective 1 July 2026)**
>
> Prior to 1 July 2026, ProdSecEng also owned the maintenance and management of custom internal security tooling, including intake, maintenance, and sunsetting of tools on behalf of the Security division. That responsibility is winding down as part of GitLab's Act 2 operating model changes.
>
> The team's existing custom tooling commitments are being transitioned to their owning teams. Transition plans are being finalised and documented in the [internal handbook tooling inventory](https://internal.gitlab.com/handbook/security/product_security/product_security_engineering/) (accessible to GitLab team members only). New custom tooling requests aren't being accepted. Teams with existing tooling questions should reach out in [`#security_help`](https://gitlab.enterprise.slack.com/archives/C094L6F5D2A) on Slack.

### Where we get work from

ProdSecEng sources work from:

1. **Product Security Risk Register (PSRR)**: Systemic risks identified by [Security Platforms & Architecture (SPA)](/handbook/security/product-security/security-platforms-architecture/) and other ProdSec teams that need product engineering solutions.
1. **Cross-team discussions with ProdSec**: Direct collaboration with ProdSec teams to identify where product capabilities can replace manual processes or close security gaps.
1. **Product and Engineering alignment**: Joint planning with Product Managers and Engineering teams to shape security features that fit the product roadmap.
1. **Security Interlock**: Validating GitLab security features through [Customer Zero](/handbook/product/product-processes/customer-0/) initiatives where appropriate.

### Out of scope

| Area | DRI |
|------|-----|
| Application security standards, reviews, or testing | [AppSec](/handbook/security/product-security/security-platforms-architecture/application-security/) |
| Infrastructure, cloud, or data security tooling or architecture | [InfraSec](/handbook/security/product-security/infrastructure-security/) |
| Vulnerability management, disclosure, and triage | [Vulnerability Operations](/handbook/security/product-security/vulnerability-management/) |
| Building or accepting new custom internal tooling | See Transition: custom tooling above |

## Team values

ProdSecEng operates under [GitLab's company-wide operating principles](/handbook/company/operating-principles/). In addition, the team practices:

1. **Transparency**: We work in the open. Decisions, trade-offs, and progress are visible to anyone who looks. When we hit a blocker or change direction, we say so in the issue or epic rather than sorting it out privately.
1. **Engineering standards**: We follow GitLab's [engineering workflow](/handbook/engineering/workflow/) and hold our contributions to the same quality bar as any other Engineering team. Code reviews, testing, documentation, and performance standards all apply.
1. **Dogfooding**: We use GitLab where possible so we understand the user experience. This includes using mentions and TODOs to understand when teams need our input, recording discussions and decisions in work items, using GitLab features in our engineering workflows, and providing feedback or leading with MRs for bugs we find.

## Operating model

### Planning and milestones

ProdSecEng plans work using [Product Milestones](/handbook/product/product-processes/milestones/) to align with Product and Engineering cadences. Milestones are approximately four weeks long. The Engineering Manager leads milestone planning, informed by PSRR priorities, cross-team discussions, and team capacity.

### Priority

We use GitLab's standard [priority scoped labels](/handbook/product-development/how-we-work/issue-triage/#priority):

| Priority | Intention | Target resolution |
|----------|-----------|-------------------|
| `~"priority::1"` | Address as soon as possible, regardless of capacity constraints | 30 days |
| `~"priority::2"` | Address soon; capacity allocated in the next few milestones | 60–90 days |
| `~"priority::3"` | Address when possible; may be displaced by higher-priority work | 90–120 days |
| `~"priority::4"` | No timeline designated | Best effort |

Priority is set during milestone planning by the EM, informed by risk ratings, company-wide priorities, cross-team requests, and team needs.

### Sizing and estimates

We use the standard [modified Fibonacci scale](https://docs.gitlab.com/tutorials/scrum_events/standups_retrospectives_velocity/#deciding-the-value-of-story-points) for issue weight:

| Weight | Complexity | Approximate time |
|--------|-----------|------------------|
| 1 | Trivial; no side effects expected | 1 day |
| 2 | Small; requirements are clear and testing is straightforward | 1–2 days |
| 3 | Moderate; larger code footprint, clear requirements | 2–3 days |
| 5 | Complex; requirements understood but gaps likely along the way | 3–5 days |
| 8 | Very complex; significant investigation and research before starting | 5–10 days |
| 13+ | Split required; break into smaller issues | N/A |

This generally means about 20 weight of work items per milestone per team member, reduced for leave, holidays, and growth & development time. We plan 60–80% of capacity in advance; the rest is reserved for unplanned, reactive work.

### Unplanned work

We use the `~Unplanned` label on issues and MRs added to the milestone after planning. This helps us track whether our planned-vs-unplanned capacity split is right and identify recurring sources of interruptions.

### Work tracking

We track data to make sure we're picking the right work, sizing it accurately, raising risks early, and giving people visibility into progress. For details on our team-specific workflows, including backlog management, refinement, development, and handoff processes, see [Detailed Workflows](detailed-workflow/).

## Success metrics

ProdSecEng tracks metrics through labeled merge requests and issues.

### Active metric labels

These labels apply to our current product-focused mission:

| **Category** | **Label** | **Description** |
| --- | --- | --- |
| **Product Security Requirements** | `~ProdSecEngMetric::ProdSecRequirement` | Functionality within the product required by GitLab Product Security teams |
| **Defense in Depth** | `~ProdSecEngMetric::Defense in Depth` | Modifications to existing non-vulnerable functionality to be more resilient if an "earlier" security control fails |
| **Paved Roads** | `~ProdSecEngMetric::Paved Road` | New tools, methods, or checks that give GitLab's contributors an easier way to perform an activity securely |
| **Pending** | `~ProdSecEngMetric::Pending` | Work type isn't clear yet, but we don't want to block progress |
| **Internal** | `~ProdSecEngMetric::Internal` | Team tasks such as processes and planning |

### Winding-down metric labels

These labels were designed for ProdSecEng's previous custom tooling mission. They'll be retired once existing tooling transitions are complete:

| **Category** | **Label** | **Description** |
| --- | --- | --- |
| **Tooling Integration** | `~ProdSecEngMetric::Tooling Integration` | Work done as part of integrating functionality from custom in-house tooling into GitLab products |
| **Custom Tooling** | `~ProdSecEngMetric::Custom Tooling` | Work to build, maintain, or augment custom tooling needed to satisfy Product Security requirements |
| **Sunsetting** | `~ProdSecEngMetric::Sunsetting` | Issues representing specific features or functionality required to deprecate a custom tool |

### Strategic KPIs

| **Metric** | **How it's calculated** | **Status** |
| --- | --- | --- |
| **Product Security Team Requirements Delivered** | Count of merged MRs with `~ProdSecEngMetric::ProdSecRequirement` label | Active |
| **Security Enhancements and Paved Roads Delivered** | Count of merged MRs with `~ProdSecEngMetric::Defense in Depth` or `~ProdSecEngMetric::Paved Road` labels | Active |
| **Custom Tool Value Integrated Into Product** | Percentage of distinct value propositions in custom tools contributed to the product | Winding down |

### Operational KPIs

| **Metric** | **How it's calculated** | **Status** |
| --- | --- | --- |
| **Backlog Health and Refinement** | Count of candidate issues refined, issues in `Ready for Development` status, refinement participation across milestones | Active |
| **Milestone Predictability** | Actual vs. planned work completed in each milestone (measured by weight and metric labels) | Active |
| **Metric Label Coverage** | Percentage of merged MRs and closed issues with appropriate `~ProdSecEngMetric::*` labels | Active |

## Communication

1. **Slack**: Ask in [`#security_help`](https://gitlab.enterprise.slack.com/archives/C094L6F5D2A) on Slack and @ mention the `@product-security-engineering` handle
1. **GitLab**: Mention `@gitlab-com/gl-security/product-security/product-security-engineering`
1. **Issues**: Submit to the [ProdSecEng team repository](https://gitlab.com/gitlab-com/gl-security/product-security/product-security-engineering/product-security-engineering-team/-/issues/new)
1. **Emergencies**: Page the Security Incident Response Team using `/security` in any Slack channel

We use "ProdSecEng" as our short name to avoid confusion with [Professional Services Engineer](/job-description-library/sales/professional-services-engineer/).

## Team composition

The ProdSecEng team consists of:

- **Security Engineering Manager**: Leads team prioritization, roadmap planning, and milestone planning; manages cross-functional relationships with Product and Engineering
- **Product Security Engineers**: Design, develop, and validate security features, automation solutions, and product contributions

### Development goals

Our team is a mix of software and security engineers. Our plans for growth and development include:

1. Expanding expertise in GitLab's codebase, architecture, and development practices
1. Building deeper skills in translating security requirements into user-centric product features
1. Strengthening cross-team collaboration with Product Managers and Engineering teams
1. Developing hands-on experience with AI-assisted security tooling and implementation

## Review and updates

This charter is reviewed quarterly. Next scheduled review: October 1, 2026.
