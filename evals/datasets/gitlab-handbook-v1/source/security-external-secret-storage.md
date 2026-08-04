---
slug: security-external-secret-storage
title: "Setting up external secret storage with Vault"
source_url: "https://handbook.gitlab.com/handbook/security/external-secret-storage/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---
title: Setting up external secret storage with Vault
description: Process outline on how to setup external secrets storage as a secure alternative to environment variables.
---
## Overview

This guide explains how to use HashiCorp Vault as an external secrets manager for your GitLab CI/CD pipelines. Properly managing secrets such as API keys and passwords is critical for maintaining security in your projects.

## Why Use External Secrets?

External secrets provide a secure way to manage sensitive data in CI/CD environments by separating confidential information from your codebase. This approach prevents accidental exposure of credentials in version control systems, enables centralized secret management, and allows for proper access controls and audit trails. By using external secrets, you can maintain security best practices while automating your build, test, and deployment processes without hardcoding sensitive values directly in your pipeline configurations.

## When to Use External Secrets?

External secrets are particularly valuable in these scenarios. Note that this list is non-exhaustive, as it's nearly impossible to cover all potential use cases

**[GitLab CI/CD Pipeline Operations](https://docs.gitlab.com/ci/variables/)**

- Deploying from GitLab CI
- Authenticating with external services (AWS, Docker Hub, cloud providers) during pipeline execution
- Running automated tests that require database or API connections
- Publishing packages to registries (npm, Maven, PyPI) from GitLab pipelines

**[Personal Access Tokens](https://docs.gitlab.com/user/profile/personal_access_tokens/)**

- Using GitLab Personal Access Tokens to access GitLab API programmatically
- Cloning private repositories during CI/CD processes
- Automating GitLab operations like creating merge requests or managing issues
- Integrating GitLab with external tools and services
- Scope tokens appropriately - grant minimal required API permissions and set expiration dates

**[GitLab Runner Configuration](https://docs.gitlab.com/runner/)**

- Configuring GitLab Runners to access private container registries
- Setting up runners to deploy to protected environments
- Authenticating runners with cloud infrastructure services

Secrets are credentials like API keys and passwords that should be kept unknown or unseen by others. While GitLab CI has a built-in variable area with [masking capability](https://docs.gitlab.com/ee/ci/variables/#mask-a-cicd-variable), this feature has limitations:

> [!warning]
> Masking a CI/CD variable is not a guaranteed way to prevent malicious users from accessing variable values. The masking feature is "best-effort" and there to help when a variable is accidentally revealed. To make variables more secure, consider using external secrets.

## Why Protecting Secrets Like Personal Access Tokens (PATs) is Critical

Personal Access Tokens, API keys, database credentials, and similar secrets act as digital keys to your organization's most valuable assets. When these secrets are leaked through CI logs or public commits, they become readily available to anyone with access to those files, including external contributors, former employees, or attackers who have gained access to your repositories.

## How Bad Actors Exploit Leaked Secrets

Once a malicious actor obtains leaked credentials, they can:

- Access and exfiltrate sensitive data from databases, cloud storage, or internal APIs using leaked database credentials or API keys
- Modify or delete critical code by using leaked Git tokens to push malicious commits, delete repositories, or access private repositories
- Escalate privileges within your infrastructure by using service account tokens to access additional systems and resources
- Deploy malicious code to production environments using deployment keys or cloud provider credentials
- Access customer data through leaked application secrets or third-party service credentials
- Conduct lateral movement within your network using leaked internal service credentials
- Sell credentials on dark web markets for other attackers to exploit

## Real-World Impact Scenarios

Leaked secrets can lead to data breaches affecting customers, unauthorized cryptocurrency mining, supply chain attacks or complete compromise of your development and production environments.

## Best Practices for Secret Management

1. Never store secrets directly in your code
2. Use the appropriate subfolder structure in Vault for different environments
3. Limit access to secrets through group-based permissions
4. Regularly rotate credentials stored in Vault
5. Use file-based secrets for more complex authentication configurations like service account JSON files

## Using HashiCorp Vault for Secret Management in GitLab CI/CD

HashiCorp Vault is used for external secrets solutions for GitLab. Details on how to use Vault for secrets managed can be found [here](https://runbooks.gitlab.com/vault/usage/#secrets-management).

Any other form of external secret storage that is called via a CI pipeline must be first approved by [CorpSec](https://internal.gitlab.com/handbook/security/corporate/) prior to being implemented.
The integration between Vault and GitLab works via a JWT-based authentication flow:

1. GitLab generates a JWT and provides it to the CI job
2. The CI runner authenticates with Vault using this JWT
3. Vault verifies the JWT and checks bounded claims
4. Vault returns a token to the runner
5. The runner reads secrets from Vault

## Setup Guide

### Prerequisites

- A GitLab project where you want to use external secrets
- Access to [GitLab's HashiCorp Vault instance](https://vault.gitlab.net)
- Proper permissions to create/manage access requests

> [!note]
> GitLab (the product) has a [tutorial page available](https://docs.gitlab.com/ee/ci/secrets/), but for internal GitLab projects this may be overkill because our SRE team has a vault setup available already!

### Step 1: Access Request

1. Request an [Okta group](https://okta.com/) for your team to be created (no individual access)
2. The group will be added to the Vault application (standard process for IT teams)
3. Okta will need to be updated with a "group claim" to send your new group to HashiCorp Vault
4. Additional configuration will be performed on the SRE/HashiCorp Vault side. More details can be found the [Vault runbook](https://runbooks.gitlab.com/vault/access/#onboarding-a-team-into-vault).

> [!note]
> For GitLab internal users, refer to the [SRE internal runbook](https://runbooks.gitlab.com/vault/usage/) for detailed setup instructions.

### Step 2: Create the Terraform Configuration

HashiCorp Vault is configured via Terraform. Create the necessary configuration files based on examples or templates that might be available from GitLab's [Infrastructure team](https://gitlab.com/gitlab-com/gl-infra/infra-mgmt/-/tree/main). Examples for the gitlab-com environment are available [here](https://gitlab.com/gitlab-com/gl-infra/infra-mgmt/-/tree/main/environments/gitlab-com).

### Step 3: Invite the Bot

The "gitlab-infra-mgmt-bot" (or equivalent in your case) needs to be an owner of your project group BEFORE merging the Terraform configuration. This bot automates [the CI variables](https://docs.gitlab.com/ee/ci/variables/) listed in the HashiCorp documentation.

### Step 4: Merge the Terraform Configuration

Submit and merge the Terraform configuration into your repository.

### Step 5: Set Up Secrets in Vault

1. Access your Vault instance through the web interface or CLI
2. Create a structure following the naming convention from your Terraform and project
   - For example:
     - Project URL: [`https://gitlab.com/gitlab-com/it/security/it-security-automation`](https://gitlab.com/gitlab-com/it/security/it-security-automation)
     - Vault URL path: `/ci/gitlab-com/gitlab-com/it/security/it-security-automation`
   - [View example of Vault navigation](https://vault.gitlab.net/)

### Step 6: Configure Environments

1. Determine which environments (prod, non-prod) you need to support
2. Create appropriate subfolders in Vault for each environment
   - All CI jobs have access to the "shared" subfolder by default
   - For protected branches, use the "protected/" subfolder

### Step 7: Create Secrets

Each ["secret"](https://www.vaultproject.io/docs/secrets) in Vault contains key:value pairs or a JSON object. Add your secrets with appropriate key names and values.

### Step 8: Access Secrets from CI/CD

Edit your `.gitlab-ci.yml` file to access the secrets from Vault:

```yaml
deploy:
  id_tokens:
    VAULT_ID_TOKEN:
      aud: https://vault.gitlab.net
  secrets:
    OKTA_TOKEN:
      file: false
      vault: ${VAULT_SECRETS_PATH}/shared/apikeys/okta@ci
      token: $VAULT_ID_TOKEN
    GOOGLE_SECRET:
      file: true
      vault: ${VAULT_SECRETS_PATH}/shared/google/googlekey@ci
      token: $VAULT_ID_TOKEN
```

Note the following:

- All secret paths must end with `@ci` for CI purposes
- Set `file: false` for simple variables
- Set `file: true` for secrets that should be converted to a file (this is the default)

### Step 9: Use Secrets in Your Scripts

Secrets can be used as environment variables:

For ruby scripts use this:

```ruby
# check if running in CI and get variables as required
if ENV['GITLAB_CI']
  gitlab_token = ENV['GITLAB_TOKEN']
  
  # Read just the gitlab url from config.template
  File.readlines(directory + '/config.template').each do |line|
    if line.strip.match(/^url=(.+)$/) && url_section
      gitlab_url = $1
      break
    end
    url_section = true if line.strip == '[gitlab]'
  end
else
  # Read from config.ini
  gitlab_token = nil
  gitlab_url = nil
  url_section = false
  
  File.readlines(directory + '/config.ini').each do |line|
    if line.strip.match(/^token=(.+)$/) && url_section
      gitlab_token = $1
    elsif line.strip.match(/^url=(.+)$/) && url_section
      gitlab_url = $1
    end
    url_section = true if line.strip == '[gitlab]'
  end
end

headers = { "Private-Token" => gitlab_token }
```

For Python scripts use this:

```python
# check if running in CI and get variables as required
if os.getenv("GITLAB_CI"):
    config.read(directory + '/config.template')
    gitlab_token = os.getenv('GITLAB_TOKEN')
else:
    config.read(directory + '/config.ini')
    gitlab_token = config['gitlab']['token']

gitlab_url = config['gitlab']['url']
headers = {"Private-Token": gitlab_token}
```

## Verification

You can verify that your secrets are being properly resolved by checking the CI output job. You should see log entries like:

```shell
Resolving secrets
Resolving secret "JAMF_USER"...
Using "vault" secret resolver...
Resolving secret "OKTA_TOKEN"...
Using "vault" secret resolver...
```

When printing sensitive values, they should appear as `[MASKED]` in the logs.

## Troubleshooting

If you encounter issues with Vault integration:

1. Check that the bot has proper permissions to your project
2. Verify the secret paths in your `.gitlab-ci.yml` match the structure in Vault
3. Ensure your Okta group has the correct permissions in Vault
4. Check CI job logs for error messages related to secret resolution

## Future Considerations

- We're not limited to Vault for ESS. Consider utilizing 1Password's API integration. You can find an excellent example [here](https://gitlab.com/gitlab-com/it/security/it-security-automation/-/blob/main/onepassword.py?ref_type=heads). The setup guide can be found [here](https://gitlab.com/gitlab-com/it/security/it-security-automation/-/blob/main/README.md).
- Google Cloud Secrets Manager integration
- OAuth 2.0 API service with Proof of Possession (POP) for Okta-specific applications
- [GitLab as a Secrets Manager](https://gitlab.com/groups/gitlab-org/-/epics/10108) feature is currently in development, this will eliminate insecure CI variables and keep your production credentials, API keys, and tokens safely within GitLab's familiar interface.

## Related Resources

- [GitLab CI/CD Secrets Management Documentation](https://docs.gitlab.com/ee/ci/secrets/)
- [HashiCorp Vault Documentation](https://www.vaultproject.io/docs)
- [External Secrets with Terraform](https://docs.gitlab.com/ee/administration/terraform_state.html)
- [CI/CD Variables Documentation](https://docs.gitlab.com/ee/ci/variables/)
- [GitLab IT Security Automation Repository](https://gitlab.com/gitlab-com/it/security/it-security-automation)
