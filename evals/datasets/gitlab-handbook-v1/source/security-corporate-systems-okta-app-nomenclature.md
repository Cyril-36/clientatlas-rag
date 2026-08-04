---
slug: security-corporate-systems-okta-app-nomenclature
title: "Okta App Nomenclature"
source_url: "https://handbook.gitlab.com/handbook/security/corporate/systems/okta/app/nomenclature/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---

title: Okta App Nomenclature
---

## Overview

Okta apps are a fundamental component of Okta. Standardized naming conventions allow for easy discovery, management, and tracking of apps. Clear naming makes it easier to audit apps, as well as understand and communicate purpose.

### Naming Conventions

**Do:**

- Use hyphen (-) as logical separator between app name and function
- Use parentheses () around environment names
- Capitalize names
- Okta supported character sets: [Character Sets Documentation](https://developer.okta.com/docs/reference/core-okta-api/#character-sets)

**Avoid:**

- Long names (max 100 characters)
- Including sensitive info, such as tenant IDs, Client IDs, or secrets.
- Replacing spaces with -,_,. or other characters
- Identity technical jargon in end-user facing names (e.g. SAML, OIDC, WS-FED, SCIM)
- Word contractions or acronyms unless they are widely recognized at GitLab or required due to system limitations (e.g. Use Salesforce instead of SFDC, but AWS instead of Amazon Web Services is acceptable)

## App Types and Naming Conventions

We use this naming format for all Okta apps, unless technical reasons prevent doing so. Please see below, for examples of each type of app.

**Syntax:**

`{app name} (environment) - {function}`

### End-user Facing Apps

**Syntax:**

`{app name}`

End-user facing apps are apps that are **visible** to an Okta user and **in the Okta Dashboard**.

End-user facing apps include

- Bookmark apps
- SWA apps
- IdP-initiated SAML apps
- OIDC apps that support "Either Okta or App" initiated login

**Examples:**

- `Slack`
- `Google Workspace`
- `GitLab`

### SSO Apps

**Syntax:**

`{app name} - SSO`

SSO apps are dedicated apps that handle **SSO** (OIDC, SAML, WS-Fed) and are **not visible to the end-user**. SSO apps include OIDC and SP-initiated SAML apps which do not provide a public facing url for users to login with.

**Examples:**

- `Slack - SSO`
- `Google Workspace - SSO`
- `GitLab - SSO`

### SCIM Apps

**Syntax:**

`{app name} - Provisioning`

Provisioning apps are dedicated apps for **user provisioning only**. This can include SCIM, API, or other app integrations that handle user provisioning in the app.

**Examples:**

- `Slack - Provisioning`
- `Google Workspace - Provisioning`
- `GitLab - Provisioning`

### API Service Apps

**Syntax:**

`{app name} - API`

API Service apps allow third-party apps to access the Okta API. An API app name should be named the same as the service, automation, or integration leveraging it.

**Examples:**

- `CorpSec Read Only - API`

### Profile Source Apps

**Syntax:**

`{app name} - Profile Source`

Profile Source apps are apps that serve as single source of truth for user identities in Okta. Profile sources help manage a user's entire life cycle (creation, updates, and deactivation) by syncing user creation, updates, and termination events between the app and Okta.

**Examples:**

- `Workday - Profile Source`

### App Environments

**Syntax:**

`{app name} (environment)`

Some apps support multiple environments, tenants, and organizations. The environment name should be included when an app has more than one environment. Environment names can be used in combination with other apps naming conventions (SSO, SCIM, API, Profile Source).

**Examples:**

- `Slack (Sandbox)`
- `Google Workspace (Sandbox) - SSO`
- `GitLab (Dedicated) - Provisioning`

## Edge Cases and Special Scenarios

**Multi-Purpose Apps**

Generally, apps should serve as singular particular function, such as SSO or Provisioning. However, some apps may serve multiple functions (e.g. both SSO and SCIM). This is especially true for historical apps or those with specific limitations that do not allow splitting of functions across multiple app instances. In such cases, the app name will be determined based on app-visibility and purpose.

- If the app is end-user visible, use a user-friendly name (e.g. `GitLab`)
- If the app combines SSO and SCIM, use the SSO Apps naming convention (e.g. `GitLab - SSO`)
