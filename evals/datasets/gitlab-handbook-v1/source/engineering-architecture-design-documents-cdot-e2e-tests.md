---
slug: engineering-architecture-design-documents-cdot-e2e-tests
title: "End-to-End Testing with Playwright in the Customers Portal"
source_url: "https://handbook.gitlab.com/handbook/engineering/architecture/design-documents/cdot_e2e_tests/"
retrieved: 2026-08-04
license: CC BY-SA 4.0
---

---

title: End-to-End Testing with Playwright in the Customers Portal
status: accepted
creation-date: "2026-02-19"
authors: [ "@mlunoe" ]
coaches: []
dris: []
owning-stage: "~devops::fulfillment"
participating-stages: []
toc_hide: true
---

## Summary

The current QA test suite has become a significant barrier to developer productivity, with 44% of developers rating local setup as "very difficult," 63% uncomfortable writing or updating tests, and widespread concerns about test flakiness and maintainability. Adopt Playwright as the primary framework for end-to-end (E2E) testing in the Customers Portal to address these pain points. Playwright is a well-established, industry-standard framework that provides fast and stable test execution with built-in debugging tools, making it accessible to all developers. By enabling developers to write and maintain E2E tests with minimal friction, we can lower barriers to contribution, improve test reliability through network interception and proper configuration, and leverage AI-assisted test generation with GitLab Duo to accelerate test development.

## Resources

- [Playwright Docs](https://playwright.dev/docs/intro)
- [Playwright vs. Cypress](https://testdino.com/blog/playwright-vs-cypress/)
- [Playwright flaky tests: detection, causes, and fixes](https://testdino.com/blog/manage-playwright-flaky-tests/)

## Proof of Concept

The following merge requests (MR) demonstrate the initial Playwright implementation and AI-assisted test generation:

- [!14622](https://gitlab.com/gitlab-org/customers-gitlab-com/-/merge_requests/14622): Proof of concept (POC) implementation with initial Playwright configuration and setup
- [!14815](https://gitlab.com/gitlab-org/customers-gitlab-com/-/merge_requests/14815): Additional test created with GitLab Duo agent assistance, demonstrating AI-assisted test generation
- [Demo](https://youtu.be/IZfVfAHqZPE): Walkthrough of working with GitLab Duo to produce Playwright end-to-end tests
- [!14902](https://gitlab.com/gitlab-org/customers-gitlab-com/-/merge_requests/14902): Tests created in the demo above

## Implementation tracking

Implementation is tracked under the parent epic: [&21622 Adopt Playwright as the E2E Testing Framework for CustomersDot](https://gitlab.com/groups/gitlab-org/-/work_items/21622)

### 🐳 Infrastructure & Setup

| Issue                                                                           | Description                                                                   |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [#16795](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16795) | Update GDK and CDot Docker containers to support Playwright E2E tests         |
| [#16796](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16796) | Set up Playwright configuration, environment handling, and base test patterns |

### 🔁 MR Pipeline Integration

| Issue                                                                           | Description                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [#16797](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16797) | Run Playwright E2E jobs in MR pipelines for SaaS and Self-Managed environments |
| [#16798](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16798) | Integrate Playwright JUnit results into GitLab MR test reporting               |

### ⏰ Staging & Observability

| Issue                                                                           | Description                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [#16799](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16799) | Set up scheduled Playwright E2E test runs against the staging environment |
| [#16800](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16800) | Implement Slack notifications for Playwright staging test failures        |

### 📚 Documentation

| Issue                                                                           | Description                                                                 |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [#16801](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16801) | Document Playwright E2E test writing guidelines for CustomersDot developers |

### 👥 Coverage Ownership

| Issue                                                                           | Group                                                                                               |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [#16802](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16802) | `group::fulfillment platform` — Define critical user workflows and create E2E test coverage plan    |
| [#16803](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16803) | `group::provision` — Define critical user workflows and create E2E test coverage plan               |
| [#16804](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16804) | `group::seat management` — Define critical user workflows and create E2E test coverage plan         |
| [#16805](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16805) | `group::subscription management` — Define critical user workflows and create E2E test coverage plan |
| [#16806](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16806) | `group::utilization` — Define critical user workflows and create E2E test coverage plan             |

## Motivation

The Customers Portal requires robust E2E testing to ensure critical user workflows function correctly across the application. However, the current QA test suite has become a significant pain point for developers. A recent [developer experience survey](https://gitlab.com/gitlab-org/fulfillment/meta/-/work_items/2085) revealed that:

- **Setup complexity**: 44% of developers rated local E2E test setup as "very difficult," citing too many environment variables, tedious debugging, and issues with dependencies like ChromeDriver.
- **Low confidence**: Developers struggle to trust test results due to flakiness and frequent failures unrelated to actual code changes, making it difficult to diagnose real issues.
- **Difficult to maintain**: 63% of developers are uncomfortable writing or updating E2E tests, citing unfamiliar syntax, lack of framework knowledge, and the custom Ruby-based framework that differs from standard testing tools.
- **Barriers to contribution**: The complex setup and steep learning curve discourage developers from contributing to E2E tests, creating a bottleneck where only specialized test engineers can maintain them

We need a testing framework that is **accessible to all developers**, **reliable with minimal flakiness**, **fast with quick feedback loops**, and **maintainable with clear patterns** that developers have an easier time understanding. By adopting Playwright, we can lower barriers to contribution, improve test reliability, and enable developers to own E2E tests for their features.

### Goals

- Establish Playwright as the standard E2E testing framework for the Customers Portal
- Enable developers to write and maintain E2E tests with minimal friction
- Improve test stability through network interception and proper test configuration
- Run E2E tests in merge request pipelines and staging environments to catch regressions early
- Support parallel test execution to minimize feedback time
- Leverage AI-assisted test generation and debugging to improve developer experience

### Non-Goals

- Immediately migrate all existing QA tests to Playwright (can support a slow transition)
- Migrate feature specs to use Playwright
- Replace unit or integration tests with E2E tests
- Implement a custom test framework or wrapper around Playwright

## Proposal

Adopt Playwright as the primary E2E testing framework with the following implementation strategy:

### Framework selection

Playwright is a well-known, industry-standard framework.

#### Pros

- **Stability**: Built-in network interception capabilities to [stabilize tests](https://playwright.dev/docs/network) by controlling external dependencies
- **Developer experience**: Trace viewer and UI mode for debugging and writing tests interactively
- **Accessible**: Moderate for developers to learn and write tests without extensive training
- **Familiarity**: Well-established framework that developers can quickly learn and adopt
- **AI-friendly**: Standard practices and clear test structure that make it straightforward to use GitLab Duo for test generation and fixing
- **Speed**: Quick feedback loops to support rapid development cycles, faster test execution compared to alternatives like Selenium or even Cypress (see [performance comparison](https://dev.to/swikritit/comparing-test-execution-speed-of-modern-test-automation-frameworks-cypress-vs-playwright-3hg8#key-observations))
- **Maintainable**: Clear syntax and tooling that reduces test maintenance burden
- **Open source**: Distributed as open-source under the [Apache 2.0 license](https://github.com/microsoft/playwright/blob/66137fd17d4453d199b086df26aece65f0169cf1/LICENSE)

#### Cons

- Moderate learning curve (steeper than Cypress)
- Growing community (though well-established)

### Test execution strategy

- **MR pipeline**: Run E2E tests in merge request pipelines to catch regressions before merge
- **Staging environment**: Execute full test suite against staging to validate behavior in production-like environment
- **Parallel execution**: Run tests in parallel to minimize feedback time and improve developer velocity

### Developer tooling

- **Trace viewer**: Inspect test execution with detailed traces for debugging
- **UI mode**: Interactive test writing and debugging interface
- **AI-assisted generation**: Use GitLab Duo to generate and fix tests, improving developer productivity

### Migration strategy

1. Maintain existing active QA tests during transition period
1. Establish ownership and coverage roadmap to prevent the maintenance bottleneck that plagued the previous QA suite. Each group under Fulfillment should:
   - Define critical user workflows for their features
   - Create a test coverage plan
   - Own the E2E tests for their area
   - Review the [CustomersDot E2E Test Redundancy Reduction analysis (&21309)](https://gitlab.com/groups/gitlab-org/-/work_items/21309) to identify tests to migrate, consolidate, or remove

   Tracked in: [#16802](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16802) (Fulfillment Platform), [#16803](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16803) (Provision), [#16804](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16804) (Seat Management), [#16805](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16805) (Subscription Management), [#16806](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16806) (Utilization)

1. Integrate tests into CI/CD: set up scheduled staging test runs, implement Slack notifications and issue creation for failures, and integrate test results into merge request reporting

   Tracked in: [#16795](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16795) (Docker), [#16796](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16796) (Playwright config), [#16797](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16797) (MR pipeline jobs), [#16798](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16798) (MR test reporting), [#16799](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16799) (Scheduled staging runs), [#16800](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16800) (Slack notifications)

1. Document test writing guidelines for developers, including a requirement that new E2E tests include brief justification confirming the scenario cannot be covered by unit, integration, or system tests

   Tracked in: [#16801](https://gitlab.com/gitlab-org/customers-gitlab-com/-/work_items/16801)

1. Gradually migrate existing QA tests to Playwright
1. Retire stale QA tests as Playwright coverage increases

## Design and implementation details

### Test organization

Structure tests by feature or user workflow:

```sh
playwright/
├── helpers/
│   └── env.js
├── pages/
│   ├── login_page.js
│   ├── purchase_page.js
│   ├── billing_accounts_page.js
├── tests/
│   ├── auth.setup.js
│   ├── purchase.setup.js
│   ├── login.spec.js
│   └── purchase.spec.js
```

### Setup projects and dependencies

Playwright projects enable sequential test execution with dependencies. The POC implements a multi-stage setup:

- **auth project**: Authenticates the test user with GitLab and the Customers Portal, storing session state in `playwright/.auth/user.json`
- **purchase project**: Completes an initial subscription purchase to set up test data, depends on auth project
- **chromium project**: Runs actual E2E tests with authenticated session, depends on purchase project

This approach ensures tests have the necessary preconditions (authenticated user, existing subscription) without duplicating setup logic across tests.

### Environment configuration

Environment variables are centralized in [`playwright/helpers/env.js`](https://gitlab.com/gitlab-org/customers-gitlab-com/-/blob/12788-mlunoe-playwright-e2e-poc/playwright/helpers/env.js) (mirroring the setup in [`qa/runtime/env.rb`](https://gitlab.com/gitlab-org/customers-gitlab-com/-/blob/fc98217e4dd989b14361eaef91450f9407bb8fb5/qa/runtime/env.rb)):

```javascript
export function getEnv() {
  const isCI = process.env.CI === "true" || process.env.CI_SERVER === "yes";
  const isHeadless = process.env.HEADLESS !== "false";
  const baseURL = process.env.CUSTOMER_PORTAL_URL || "http://localhost:5000";
  const testUserEmail = process.env.QA_TEST_USER_EMAIL;
  const testUserPassword = process.env.QA_TEST_USER_PASSWORD;

  if (!testUserEmail || !testUserPassword) {
    throw new Error(
      "QA_TEST_USER_EMAIL and QA_TEST_USER_PASSWORD environment variables are required. " +
        "Make sure that the `qa/docker/prepare_gitlab.rb` script was executed.",
    );
  }

  return {
    isCI,
    isHeadless,
    baseURL,
    testUserEmail,
    testUserPassword,
    customerPortalUrl: baseURL,
    gitlabUrl: process.env.GITLAB_URL || "http://localhost:3000",
  };
}
```

This ensures consistent configuration across local development and CI environments, with clear error messages when required variables are missing.

### Authentication handling

Authentication is implemented as a reusable page object that handles both GitLab and Customers Portal login flows:

- Logs in to GitLab with test user credentials (created through the [`qa/docker/prepare_gitlab.rb`](https://gitlab.com/gitlab-org/customers-gitlab-com/-/blob/12788-mlunoe-playwright-e2e-poc/qa/docker/prepare_gitlab.rb))
- Navigates to Customers Portal and initiates Single Sign-On (SSO) flow
- Handles first-time signup (user creation) if needed
- Stores authenticated session state for reuse across tests

The `auth.setup.js` project runs this once and persists the session, allowing subsequent tests to use the authenticated state without re-authenticating. We can use [this session isolation](https://gitlab.com/gitlab-org/customers-gitlab-com/-/blob/12788-mlunoe-playwright-e2e-poc/playwright/tests/login.spec.js#L8-25) pattern for tests that need to invalidate the existing session without obstructing other tests.

### Page objects and test patterns

The POC demonstrates page object pattern for maintainable tests:

- **LoginPage**: Encapsulates GitLab and Customers Portal authentication flows
- **PurchasePage**: Handles subscription purchase workflows including payment form interaction

Page objects provide:

- Reusable methods for common interactions (login, fill forms, submit)
- Centralized selectors and locators
- Clear separation between test logic and UI interaction
- Easy updates when UI changes

Example test structure:

```javascript
test("can complete purchase with existing payment method", async ({ page }) => {
  const purchasePage = new PurchasePage(page);

  await purchasePage.navigateToPurchase();
  await purchasePage.fillQuantity(1);
  await purchasePage.selectExistingPaymentCard();
  await purchasePage.acceptTermsAndPurchase();
  await purchasePage.verifyPurchaseSuccess();
});
```

### Test stability

With this implementation we get multiple tools to help test stability.

- **Network interception**: Use `waitForResponse` to reliably wait for API responses instead of arbitrary timeouts
- **Parallel workers**: Default parallelization to ensure test robustness (configurable per environment)
- **Retries**: Automatic retry logic for flaky tests (1 retry in CI, 0 in local development)
- **Test traces**: Detailed view into failed tests to help nail down the root cause
- **Screenshots on failure**: Automatic screenshot capture for failed tests
- **Quarantining**: The ability to quarantine tests to unblock other development, while it gets fixed
- **Headless mode**: Consistent behavior between local and CI environments

### Handling Zuora API instability

The Customers Portal integrates with external APIs like Zuora, which can introduce instability in tests. We can use the following strategies to work around this issue.

#### Specific API integration tests

Create dedicated integration tests that validate actual API interactions with Zuora. These tests should:

- Run against real API endpoints to catch actual integration issues
- Use Playwright's [`waitForResponse`](https://playwright.dev/docs/api/class-page#page-wait-for-response) to reliably wait for API responses
- Provide stability measurements and insights into API behavior
- Run on a separate schedule (for example, nightly or on-demand) to isolate API flakiness from regular test runs

#### Fixture-based tests

Where necessary, regular E2E tests can use mocked API responses from Playwright's fixtures to:

- Mock Zuora API responses
- Ensure tests remain stable and fast regardless of external API availability
- Focus on testing application logic and user workflows
- Reduce test flakiness caused by API timeouts or failures

This two-tier approach separates concerns: integration tests validate API contracts while regular tests validate application behavior, resulting in more reliable and maintainable test suites.

### Docker setup and reuse

The POC reuses the existing Docker infrastructure for E2E testing:

- **GDK container** (`cdot-gdk`): Runs GitLab Development Kit (GDK) instance with SaaS simulation enabled
- **CustomersDot container** (`web`): Runs the Customers Portal (CustomersDot, or CDot) application
- **E2E container** (`e2e`): Runs Playwright tests with Node.js and Playwright dependencies

The E2E container is built from a base image (`cdot-for-e2e`) that includes:

- Node.js and Yarn for dependency management
- Playwright browsers (Chromium, Firefox, WebKit)
- Test dependencies from `package.json`

Key Docker configuration:

- **Dockerfile.e2e**: Installs Yarn dependencies and Playwright browsers
- **docker-compose.e2e.yml**: Orchestrates all containers with proper networking and health checks
- **Environment variables**: Passed to containers for configuration (URLs, credentials, etc.)
- **Volume mounts**: Test results are mounted from the E2E container to the host for artifact collection

The setup automatically handles:

- Container startup and health checks
- Network connectivity between services
- Log collection from all containers for debugging
- Test result artifact collection

### Test user creation

The [`qa/docker/prepare_gitlab.rb`](https://gitlab.com/gitlab-org/customers-gitlab-com/-/blob/12788-mlunoe-playwright-e2e-poc/qa/docker/prepare_gitlab.rb) script creates a test user during GitLab initialization:

- Reads `QA_TEST_USER_EMAIL` and `QA_TEST_USER_PASSWORD` environment variables
- Creates a GitLab user with these credentials
- Outputs progress and error messages for debugging
- Validates that required environment variables are set before proceeding

This test user is then used by the auth setup project to authenticate and establish session state. Based off of this user we can establish additional necessary state, for example groups, subscriptions, billing account, etc.

### CI/CD integration

Playwright E2E tests are integrated into the Continuous Integration/Continuous Deployment (CI/CD) pipeline with dedicated jobs:

- **mr:playwright-e2e:saas**: Runs tests against SaaS (GDK) environment in merge requests
- **mr:playwright-e2e:self-managed**: Runs tests against self-managed environment in merge requests
- Both jobs:
  - Run in the MR to ensure these block pipelines on failure
  - Retries failed tests once to handle transient failures
  - Collect test results in JUnit format for GitLab integration
  - Captures screenshots and traces on failure for debugging
  - Generates HTML reports and JSON results for analysis
  - Store artifacts for 30 days for debugging
  - Support parallel execution with configurable workers

### Browser coverage

The implementation focuses on running tests in Chromium for CI/CD and local development, but also supports Firefox, WebKit, and Microsoft Edge through Playwright's multi-browser capabilities.

## Implementation considerations

### Ownership

Explicit ownership of E2E tests is critical to prevent them from becoming stale. Without clear ownership, tests quickly fall into disrepair as responsibility becomes diffuse and UI changes break tests that no one feels obligated to fix.

Engineers from each group developing user-facing features should own the E2E tests for their features. This ensures tests stay current as the product evolves, developers understand both the code and tests, and maintenance happens incrementally rather than accumulating into a large burden.

Having these tests run in the MR and block it from merging on failures is therefore also a crucial piece of ensuring that they are up-to-date. When the tests also run in staging we help automate feature validation and can replace large parts of the User Acceptance Testing (UAT) that we do.

The framework itself should be owned by ~"group::subscription management", as this group builds the vast majority of the UI in the Customers Portal.

### Learning curve

While Playwright is a new framework for the team, it is well-documented and widely adopted. Developers familiar with modern testing frameworks will find it accessible. AI-assisted test generation can further reduce the learning curve.

### Configuration complexity

Playwright requires configuration for CI/CD integration, network interception, and parallel execution. However, this complexity is comparable to other modern testing frameworks and provides significant benefits in test stability and speed.

### Existing browser usage

The project already uses Playwright in RSpecs for integration testing, providing some familiarity with the framework's concepts and reducing the learning curve for Playwright adoption.

### Fixtures as first-class citizens

Playwright treats fixtures as first-class citizens, enabling us to naturally extend beyond E2E testing. Fixtures can be leveraged for also creating feature tests and integration tests.

## Proof of Concept Learnings

The POC ([!14622](https://gitlab.com/gitlab-org/customers-gitlab-com/-/merge_requests/14622) and [!14815](https://gitlab.com/gitlab-org/customers-gitlab-com/-/merge_requests/14815)) validated the following:

### Docker setup works well

- Reusing existing Docker infrastructure (`docker-compose.e2e.yml`) is effective
- GDK container with SaaS simulation provides a realistic test environment
- Test user creation during initialization enables authentication testing
- Container health checks ensure services are ready before tests run

### Authentication is straightforward

- User creation in GDK works seamlessly
- SSO flow handling works reliably with proper waits
- Page object pattern cleanly encapsulates login flows
- Session state persistence in `storageState` eliminates re-authentication in tests
- [Session isolation](https://gitlab.com/gitlab-org/customers-gitlab-com/-/blob/12788-mlunoe-playwright-e2e-poc/playwright/tests/login.spec.js#L8-25) enables tests to invalidate sessions without obstructing other tests
- Setup projects with dependencies ensure proper test preconditions

### AI-assisted test generation is viable

See specific MR for [generated tests created with GitLab Duo here](https://gitlab.com/gitlab-org/customers-gitlab-com/-/merge_requests/14815).

- GitLab Duo can generate functional Playwright tests
- Tests follow project patterns and conventions
- Generated tests require minimal manual adjustment
- Page objects make it easy for AI to generate maintainable code

### Test patterns are clear

- Page objects provide good abstraction for UI interactions
- Setup projects handle complex preconditions (authentication, initial purchase)
- Test organization by feature/workflow is intuitive
- Playwright's API is expressive and readable

## Alternative Solutions

### Playwright with built-in agents

Playwright offers its own planner, generator, and healer agents for test automation. While these agents provide automation capabilities, the proposal is to use GitLab's AI agents instead because it will allow us to validate and improve our own AI product and it aligns with our broader strategy of leveraging GitLab's AI capabilities.

### Momentic.ai

An AI-powered test automation platform that could generate and maintain tests automatically.

#### Pros

- Easy and automatic test generation

#### Cons

- Does not leverage GitLab's AI capabilities
- Significant licensing costs
- Introduces external vendor dependency
- Less control over test implementation and maintenance

### Cypress

Alternative E2E testing framework.

#### Pros

- Larger community
- Easy setup
- User-friendly API

#### Cons

- Slower test execution compared to Playwright
- Introduces another test browser integration
- Single language focus

### Update existing QA tests

Attempt to modernize and maintain current QA test suite.

#### Pros

- Most configuration is already done

#### Cons

- Previous efforts have resulted in tests becoming stale
- Recent developer experience survey [indicated tests are difficult to understand and update](https://gitlab.com/gitlab-org/fulfillment/meta/-/work_items/2085#note_2219119420)
- Custom framework, with higher learning curve and higher maintainability requirements
- Requires significant effort with uncertain return on investment
- Does not address underlying framework limitations
