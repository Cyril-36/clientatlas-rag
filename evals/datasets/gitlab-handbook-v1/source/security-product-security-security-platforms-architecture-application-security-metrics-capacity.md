---
slug: security-product-security-security-platforms-architecture-application-security-metrics-capacity
title: "Application Security - Capacity Indicators, Classifications, and Workflows"
source_url: "https://handbook.gitlab.com/handbook/security/product-security/security-platforms-architecture/application-security/metrics/capacity/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---
title: "Application Security - Capacity Indicators, Classifications, and Workflows"
---

## Overview

AppSec manages [a wide range of tasks with a high volume of work](https://gitlab.com/gitlab-com/gl-security/appsec/appsec-team#team-capacity-planning-and-operational-work). This page outlines how we measure the team's capacity to ensure we can effectively handle current workloads and plan for future needs.

Consult our [FAQ](#faq) if you have questions or need to engage with the Application Security team for more specific asks.

### What decisions does this data help us make?

Collecting this data helps inform decisions involving the team's capacity and headcount needs. These metrics are only analyzed in aggregate and are __not__ utilized or referenced for evaluating individual team member performance. They are solely used to understand overall team dynamics and requirements.

### Where are the charts that are based on this data?

Capacity metrics can be consulted on this [Tableau dashboard](https://10az.online.tableau.com/#/site/gitlab/views/appsectest2rawdata/AppSecGeneralDashboard?:iid=1)(Internal)

### How often are these metrics reviewed?

At the beginning of each milestone (monthly), it's the responsibility of AppSec team management to lead the review of these metrics with both the AppSec team and ProdSec leadership.

## Type of Work Classification

Classifying each type of work helps to distinguish where exactly more capacity or other changes may be necessary.

### Table

| Label    | Description |
| -------- | ------- |
| AppSecWorkType::ThreatModel | Indicates the work was associated to the AppSec threat model duties |
| AppSecWorkType::JihuMRreview | Indicates the work was associated to the AppSec JiHu merge request reviews duties |
| AppSecWorkType::AppSecReview | Indicates the work was associated to the AppSec reviews duties |
| AppSecWorkType::KR | Indicates the work was associated to the AppSec OKR/KR duties |
| AppSecWorkType::FieldSecurity | Indicates the work was associated to the request from Field Security (example: customer scan review requests). _When to use this label?_ Whenever Field Security asks us to do some work related to customer requests. |
| AppSecWorkType::VATRotation | Indicates the work was associated to the AppSec Federal AppSec VAT duties |
| AppSecWorkType::FedAppSecRelCert | Indicates the work was associated to the AppSec Federal AppSec release certification and merge monitor review duties |
| AppSecWorkType::SecurityMRReview | Indicates the work was associated to the AppSec merge request security reviews duties. _When to use this label?_ On all MR reviews that Engineering teams have asked us to do a security review |
| AppSecWorkType::TriageRotation | Indicates the work was associated to the AppSec Triage Rotation. _When to use this label?_ On all issues that you are handling as part of the triage rotation (eg by team members, Depscore, SAST pings). For MRs that we are pinged to review during triage rotation, use _AppSecWorkType::SecurityMRReview_ |
| AppSecWorkType::CustomerEscalation | Indicates the work was associated to a customer escalating a security issue |
| AppSecWorkType::SIRTandSecurityComms | Indicates the work was associated to a SIRT incidents and/or Security communications work |
| AppSecWorkType::CrossTeamCollaboration | Indicates the work was associated to cross-team help/collaboration. _When to use this label?_ Whenever the work involves collaboration between AppSec and other teams. |
| AppSecWorkType::TeamProjects | Indicates the work was associated to team projects. _When to use this label?_ On any team related improvement work, new or improved automation (including bug fixes) |
| AppSecWorkType::CriticalProjects | Indicates the work was associated to [critical projects](/handbook/security/critical-projects/) |
| AppSecWorkType::Operational | Should be used for everything else that's not covered by a label above. _When to use this label?_ When you get pinged on an issue, or when none of the labels above apply. |

_Labels now used by PSIRT_

Labels below are now being used by PSIRT following AppSec and PSIRT split. They are marked as reference here until migration is done:

| Label    | Description |
| -------- | ------- |
| AppSecWorkType::SecurityReleaseRotation | Indicates the work was associated to the AppSec Security release task issue duties |
| AppSecWorkType::VulnFixVerification | Indicates the work was associated to security fix validations during security releases (not the same as security release manager rotation AppSecWorkType::SecurityReleaseRotation label) |
| AppSecWorkType::HackerAdmin | Indicates the work was associated to HackerOne administration |

_Deprecated labels_

_Do not use the labels below. They are there for information only as you may encounter them on old issues._

| Label    | Description |
| -------- | ------- |
| AppSecWorkType::HackerOneRotation | Indicates the work was associated to the AppSec HackerOne duties |
| AppSecWorkType::ToolingsAndMaintenance | Indicates the work was associated to our tools and automation. _When to use this label?_ When you're working on improving _existing_ automation like fixing bugs, adding new capabilities, etc |

### Work impacted by SIRT incidents

When SIRT incidents happen, this has an impact on our capacity. To evaluate that impact, team members should apply the label `ImpactedBySIRTIncidents` to the issue.

### Dogfooding

Apply `Dogfooding` label on each feature that we enable through a MR or issue.

#### Who assigns this label and when?

The AppSec Engineer responsible for the task is expected to assign this label to any Issue or MR as soon as they begin interaction.

## Effort Classification

The effort classification is an estimate of the level of effort required to resolve a task, not the amount of actual time spent. The `Estimation Guide` serves as a reference point and is purely a guideline.

### Table

| Label    | Weight | Classification | Description | Estimation Guide | Example |
| -------- | ------ | ------- | ------- | ------- | ------- |
| AppSecWeight::trivial | 1 | Trivial | Very little effort required | Immediate or near immediate change to resolve the issue | Trivial documentation update |
| AppSecWeight::small  | 2 | Small | Straight forward change, minimal investigation | ~0.5 - 1 days  | |
| AppSecWeight::medium | 3 | Medium | Some investigation and/or collaboration needed  | ~1-3 days | |
| AppSecWeight::large | 5 | Large | Significant investigation and collaboration needed | ~3-5 days | |
| AppSecWeight::XLarge | 8 | XLarge | Very complex and requires a major portion of the milestone to resolve | ~5-10 days | |
| AppSecWeight::Needs Refinement | 13 | Needs Refinement | The issue is overly complex and needs to be promoted to an Epic or broken down into smaller issues | N/A | |

#### Who assigns this label and when?

The AppSec Engineer responsible for the task is expected to assign this label to any Issue or MR after they complete it. In order for an issue to show up in the metrics it needs to have the following labels:  `~"AppSecWorkType::<<type>>" ~AppSecWeight::<<weight>> ~"Application Security Team" ~"AppSecWorkflow::complete"` _as well_ as a milestone _and_ be closed.

## Work flow labels

These labels indicate the current status of the issue.

### Table

| Label    | Description |
| -------- | ----------- |
| AppSecWorkflow::new | Indicates this is a new question, request for a MR review, AppSec review, or threat model. Mainly used by the AppSec SLO bot. |
| AppSecWorkflow::planned | Indicates that work has been triaged, scoped, and is ready to be worked on in the assigned milestone. |
| AppSecWorkflow::in-progress |Indicates the issue is actively being worked on, or the rotation is in progress. |
| AppSecWorkflow::complete | Indicates the work is done, or the rotation has finished. |

#### Who assigns this label and when?

The AppSec Engineer responsible for the task is expected to assign this label to an issue when work on the issue is started or completed.

## FAQ

### What labels should I add to have my work considered in the capacity metrics?

You need to have the `Application Security Team`, `AppSecWorkType::`, `AppSecWorkFlow::` labels along with the corresponding `AppSecWeight::` label and a milestone assigned to the issue.
