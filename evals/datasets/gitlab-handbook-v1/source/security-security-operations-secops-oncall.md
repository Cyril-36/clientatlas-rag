---
slug: security-security-operations-secops-oncall
title: "Security Operations On-Call Guide"
source_url: "https://handbook.gitlab.com/handbook/security/security-operations/secops-oncall/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---

title: "Security Operations On-Call Guide"
description: " "
weight: 30
---

The Security Operations sub-department is collectively responsible for responding to reports of actual or potential security incidents on a 24/7/365 basis.

- The SIRT (Security Incident Response Team) generally responds to reports of suspicious activities (e.g. Phishing, hacking, social engineering) and security alerts.
- The Trust & Safety team generally responds to reports of cryptomining, platform SPAM, abuse, bullying and violations of terms of service.

Security Operations Managers share in On-Call responsibilities and need to ensure proper coverage for escalations and emergencies. The Security department maintains a series of On-Call escalations to ensure that every reported incident is responded to in a reasonable timeframe.

On-Call scheduling for SIRT is organized in Pager Duty within the `Security Responder` policy.

## On-Call Security Handoffs

### Times

Standard handoff times are as scheduled. However, team members are empowered to agree on a temporary modified handoff schedule as long as all those involved agree and the team is notified about changes.

SIRT (November - April)

- 23:00 to 07:00 UTC –> APAC - 8 hours
- 07:00 to 15:00 UTC –> EMEA - 8 hours
- 15:00 to 23:00 UTC –> AMER - 8 hours

SIRT (April - November)

- 22:00 to 06:00 UTC –> APAC - 8 hours
- 06:00 to 14:00 UTC –> EMEA - 8 hours
- 14:00 to 22:00 UTC –> AMER - 8 hours

SIRT times are reflected in the [SIRT Handoffs](https://calendar.google.com/calendar/u/0?cid=Y18zZDBwampnN3N1bDlib2VrczIxbzRxc2RjNEBncm91cC5jYWxlbmRhci5nb29nbGUuY29t) calendar. In case both parties agree to change the time, this should be reflected in the calendar at least 24 hours prior to the handoff. This allows other team members the ability to adequately plan their schedules the night before. Changing the meeting time counts as a notification.

### SIRT Written Handoff

_Incident issues are the SSoT for any incident. Be sure to include any significant incident updates within the incident summaries._

SIRT is using the self-developed tool [Handogotchi](https://www.tines.com/library/stories/1208015/?name=manage-shift-turnover-with-handogotchi) for written handover summaries. Handogotchi reminds the SIRT engineer on call to update incidents and add additional information one hour before handoff time. It will automatically send links to active incidents half an hour before handoff times.

Written handoffs are required to be completed at least half an hour before the end of every shift and are the basis for warm handoffs.

For all incidents, we highly encourage pausing after no longer than one hour to document and make it a general habit to keep documentation up to date after every work step.

### SIRT Warm Handoff

SIRT uses warm handoffs to clarify written handoffs and avoid misunderstandings in complex situations. They should take no more than 15 minutes. One person per region is required (outgoing and incoming).

The outgoing region prepares the handoff as described in the section above. The incoming region should familiarize themselves with the written handoff before attending the meeting. _Team members should be prepared for warm handoff meetings, so that the meetings will be efficient, with a focus on open questions and clarifications._

Because the incidents are well documented, there is no written agenda for warm handoffs. All significant discussion points that come up must be immediately documented and corrected in the incident issue.

## SIRT On-Call

### Weekday

#### Weekday On-Call Engineer Responsibilities

Security Operations provides weekday On-Call coverage using a follow-the-sun model. Weekday On-Call Security Engineers are the team members that cover the On-Call responsibilities during their region's sunny time.

- A Weekday On-Call shift typically covers one work week, from Monday to Friday.
- The Weekday On-Call Security Engineers are expected to cover the `"Triage Engineer"` role, and should be the first responder to alerts and incidents as they are presented via PagerDuty and via the various Slack and alerting channels.

### Weekend

#### Weekend On-Call Security Responsibilities

SIRT maintains weekend coverage through scheduled engineers who respond to alerts and incidents during their assigned shifts. Security Managers are on-call 24/7 as a backup escalation path.

### Scheduling Time Off for SIRT

To ensure incidents are not left unattended, SIRT team members must complete the following steps before scheduling planned time off:

- Ensure proper coverage for any on-call shifts during the planned time off
- Close any incidents that are ready for closure
- Reassign open incidents to another available team member

**Manager Responsibility**: Managers are accountable for ensuring that all assigned incidents are properly handed over before a team member’s time off. If this process is not completed, managers will ensure coverage for any outstanding incidents.

## SIRT On-Call Paging

### On-Call Paging Workflow

The SIRT On-Call paging workflow is currently designed to follow this escalation path:

1. The notification goes to our incident Slack channel and the designated Security Engineer On-Call in the sunny region is paged.
1. All Security Engineers in the sunny region are paged after 15 minutes of no response.
1. The Security Operations manager in the sunny region is paged as a backup after 15 minutes if the team members don't acknowledge the pages.
1. SIRT director is paged if SIRT engineers or managers do not acknowledge the previous pages after 15 minutes.

### SIRT On-Call Paging Duties

The On-Call Engineer's primary concern is to provide timely and adequate responses to incoming pages. When receiving a page:

1. Acknowledge the alarm in the corresponding alert Slack channel or through PagerDuty directly.
1. Review incident's GitLab issue and follow the checklists posted there for triaging.

If the alarm is not acknowledged, the Security Incident Manager On-Call will be alerted.

Engineers should acknowledge pages within the first 15 minutes, and start performing initial triage of potential incidents within the first hour of the initial page.

### Security Managers On-Call

In addition to the Security Engineers being On-Call, the Security Managers across the GitLab Security Department act as backups in the event the Security Engineers are unable to acknowledge security pages. PagerDuty will automatically engage the Security Manager On-Call if SIRT doesn't acknowledge the paging attempts.

It's the responsibility of the Security Manager On-Call to:

- Be available via mobile phone during their On-Call shift if the Security Engineer On-Call does not acknowledge a page.
- Attempt to contact the Security Engineer On-Call to acknowledge the page. **Note: If Slack is not available or an alternative means of communication is required, PagerDuty has cell phone numbers of GitLab team members involved in the on-call process. GitLab also sets up a Zoom channel (#Slack Down!) as backup communication channel.**
- If the Security Engineer On-Call is unresponsive, attempt to contact other Engineers to take on the page. Prioritize based on timezone and region.
- In the event of a high-impact security incident to GitLab, the Security Manager On-Call will be engaged to assist with cross-team/department coordination.

## Triage Engineer

During On-Call shifts the Security Engineer On-Call is the Triage DRI and has these core responsibilities:

1. Acknowledge and triage pages; delegate
1. Monitor and triage incidents; delegate
1. Monitor and triage alerts; delegate alerts that are for their own activity; delegate resulting incidents
1. Continue critical assignments as determined by management
1. Monitor and respond to security related slack channels; delegate
1. Improve on-call and incident handling processes - document on-call related problems and improvement opportunities by opening issues and any necessary support tickets.
1. Continue ongoing work where possible

### Triage Engineer Responsibility to delegate

Delegation allows the team to spread the workload across the global team while maintaining adequate coverage and response times. It also minimizes the risk of one single person having to handle spikes in incident volume.

- On-Call Engineers must delegate incidents to other Engineers after performing initial triage.
- Delegation guidelines:
  - Incidents classified with either S1 or S2 should only be delegated to team members available in the current sunny region.
  - All other incidents can be assigned to any team member not out of office in any region.
- Sometimes, team members are working on a high-priority, time sensitive assignment and are temporarily unavailable for delegation. These situations should be communicated to the team transparently. If those team members inadvertently receive delegated incidents, they should work with their manager for assistance in incident reassignment.
- The On-Call Engineer is the last resort if no other team member is available to work on high-urgency incidents.

## Incident Ownership

Whoever is assigned to the incident after the initial triage is the person responsible for incident resolution. Use the assignee field in the GitLab incident to identify the responsible person. In case of severity 1 or severity 2 incidents the work should continue around the globe until the incident is contained. When multiple people work on one incident, work is divided into tasks with their corresponding assignees.

Ownership of an incident means being the person responsible for:

- Ensuring continued progression to a contained and resolved state
- Maintaining ongoing 24/7 coverage of high-severity incidents
- Accurate and timely issue tracking and communication with stakeholders
- Adequate documentation and communications

Being the responsible person does not imply being the sole person to perform incident tasks. Team members from all departments can be called upon to assist in incident resolution, and these requests should be documented as a task or related issue.

## Exceptions

Exceptions to this procedure will be tracked as per the [Information Security Policy Exception Management Process](/handbook/security/controlled-document-procedure/#exceptions).
