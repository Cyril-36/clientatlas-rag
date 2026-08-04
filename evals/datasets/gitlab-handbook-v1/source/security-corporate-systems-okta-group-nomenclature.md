---
slug: security-corporate-systems-okta-group-nomenclature
title: "Okta Group Nomenclature"
source_url: "https://handbook.gitlab.com/handbook/security/corporate/systems/okta/group/nomenclature/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---

title: Okta Group Nomenclature
---

## Overview

Okta Groups are a fundamental component of access management. Standardized naming conventions allow us to discover, track, manage, and automate group operations efficiently. Clear naming makes it easier to audit access, understand a groups purpose, and correctly route provisioning requests.

### Types of Okta Groups at GitLab

GitLab Okta groups fall into six categories:

- **App Groups** — Assigned to applications via the Okta Assignments tab for SSO, SCIM provisioning, group claims, and license assignment
- **Push Groups** — Synced to downstream applications via SCIM to manage group membership, permissions, roles, entitlements, or features in the target system
- **Attribute Groups** — Represent shared user characteristics (department, location, division, cost center)
- **Policy Groups** — Control Okta platform policies (MFA, session management, access reviews, authentication)
- **Admin Groups** - Used for assigning Okta users to admin roles and resource sets
- **Other Groups** — Group names that are may be dictated by the needs of external systems that don't fit the above categories

### Naming Conventions

**Do:**

- Use periods (.) as separators between logical components
- Use underscores (_) to replace spaces within component names
- Use lowercase for all group names
- Type out full words unless they are a very common term at GitLab (ex: people_ops instead of people_operations, or google_cloud instead of google_cloud_platform)

**Avoid:**

- Hyphens (-)
- UPPERCASE or camelCase
- Spaces
- Word contractions or acronyms unless they are widely recognized at GitLab or required due to system limitations (ex: Okta Group Rule names have a 55 character limit)

## Group Types and Naming Conventions

### App Groups

**Syntax:**

`app.{system}.{environment_if_necessary}.{role_or_permission}`

App Groups are assigned to applications in the **Okta Assignments tab**. They are used to manage access to external systems and applications through one or more of the following mechanisms:

- Assigning users to an app for SSO access
- Using SCIM user provisioning via app assignment (users get created/updated/deleted in the downstream app)
- Passing group claims (SAML/OIDC) to determine access, role, or permission at sign-in
- Assigning licenses through the app's Assignments tab (ex: Figma, Lucidchart)
- Assigning Google OU, role, or license

**Examples:**

- `app.salesforce.users` — Salesforce users
- `app.greenhouse_recruiting.users` — Greenhouse recruiting users

### Push Groups

**Syntax:**

`push.{system}.{environment_if_necessary}.{role_or_permission}`

Push Groups are configured in the **Okta Push Groups tab** and are synced to downstream applications via SCIM provisioning. Push Groups manage group membership in the target system, where the application independently determines what that membership grants. Push Groups should be app-specific and never reused across multiple applications to avoid group dependencies and ensure isolation.

Push Groups are used to:

- Create/manage a Google Group in Google Workspace
- Grant permissions or roles to a downstream group (ex: Google Groups for access delegation)
- Push to app group membership (ex: Slack user groups for channel management)
- Grant feature flags or entitlements that the downstream app manages (ex: Tableau viewer license, Anthropic Console roles)
- Manage downstream group structures, hierarchies, or access control lists

**Important:** Never use the same group for both assignment and push operations. Okta requires separate groups to maintain consistent group membership between Okta and the downstream app.

**Examples:**

- `push.google.gemini_users` — Creates a Group in Google Workspace, for providing access to the Gemini App
- `push.google.systems_operations_friends@gitlab.com` - Creates a Group in Google Workspace, for granting membership to the systems_operations_friends@gitlab.com email group
- `push.slack.security_team` — Slack user group for the security team
- `push.tableau.viewer_license` — Tableau users with viewer license entitlement
- `push.figma.product_team` — Figma group for product team file accesss

### IGA Administration Groups

IGA Administration Groups are used for defining who should approve and provision specific applications.

**Syntax:**

`corpsys.{function}.{system}`

**Examples:**

- `corpsys.approver.salesforce` — Approver group for requests to get access to Salesforce
- `corpsys.provisioner.tableau` — Group of users who will provision access to Tableau once a request is approved
- `corpsys.approver.claude.dev` — Approver group for requests to join the Claude Dev environment

### Attribute Groups

**Syntax:**

`{attribute_name}.{attribute_value}`

Attribute Groups are typically reference groups that represent shared attributes or characteristics of users. These groups are often used within Okta to make access decisions based on department, division, location, or other organizational attributes. They serve as a _source of truth_ for specific user populations.
No members should ever be manually assigned to these groups.

**Examples:**

- `dept.information_technology` — All members of the Information Technology department
- `country.ca` — All team members in Canada
- `div.engineering` — All members of the Engineering division

### Policy Groups

**Syntax:**

`policy.{description}`

Policy Groups are used to manage Okta platform policies, including Global Session Policies, MFA policies, and access policies. These groups determine how and when users can authenticate and access systems.

**Examples:**

- `policy.employee` — Okta session policies, authentication policies, and MFA policies that apply to GitLab employees
- `policy.privileged` — For privileged, or Admin/Black accounts
- `policy.professional_services` - Okta session policies, authentication policies, and MFA policies for Professional Services Partners team members

### Admin Groups

**Syntax:**

`admin.{role_name}`

**Examples:**

- `admin.read-only_administrator` - Grants the Read-only administrator role in Okta
- `admin.organization_administrator` - Grants the Organization administrator role in Okta
- `admin.report_administrator` - Grants the Reports administrator role in Okta

### Other Groups

Use "Other Groups" only when an application or external system dictates a specific group name that cannot be aligned with the conventions above. These groups should be the exception, not the rule.

Before creating an Other Group, confirm that it does not fit into the App Groups, Attribute Groups, or Policy Groups categories. When an Other Group is necessary, document the reason it cannot conform to standard naming conventions in the associated issue.
Note: Okta Push Groups can often be renamed in the downstream application so that we can maintain our naming conventions, while also providing the app with the group name they need.

**Examples:**

- `LookerAdmin` — SaaS app "Looker" requires specific group names in Okta
- `SaaSApp-BreakGlass-10dg91` — Emergency access group required by incident response procedures

### Edge Cases and Special Scenarios

**Abbreviated Group Names**

Group Names may be abbreviated using acronyms if a shorter form is widely understood within the organization. For example, you can use "app.aws.users" for all users in Amazon Web Services, where "AWS" is often more recognizable than the full name.
Add more information in the group description, to ensure consistency across the organization and help new team members understand the naming conventions.

**Vendor-Dictated Requirements**

Some applications require specific group naming formats that conflict with these conventions. In such cases, create the group with the vendor-required name in the "Other Groups" category, and document the business justification in the group description field in Okta.
Note that this should be very rare and often there are ways that we can abide by our naming conventions, while catering to the needs of the downstream app.
