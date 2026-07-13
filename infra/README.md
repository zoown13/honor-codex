# Pilot infrastructure

This CDK package deploys one deliberately small pilot stack to `ap-northeast-2`.
It has no WAF, Route 53 zone, custom domain, VPC, Step Functions, or container
workload. Persistent S3, DynamoDB, Cognito and SQS resources use retain policies.

## Required deployment parameters

- `PilotSlug`: 22 or more URL-safe random characters (128 bits or stronger).
- `AlertEmail`: recipient for SNS and AWS Budgets alerts.
- `SesFromEmail`: the SES sender identity for weekly notifications and, after
  verification, Cognito email OTP.
- `EmailOtpEnabled`: keep the default `false` for the first deployment. Set to
  `true` only after the SES sender identity and every sandbox recipient are verified.
- `PilotAllowedEmails`: comma-separated email allowlist for OTP access (empty
  intentionally permits no pilot users until configured).

Optional parameters keep live ingestion and source control disconnected by
default. `MmaLiveIngestionEnabled=false` is intentional until source usage is
approved. Set `LawApiOc` only after the OPEN API credential has been issued.
Web Push is opt-in: provide VapidSubject, VapidPublicKey and VapidPrivateKey
together. Leaving any one blank disables push while weekly SES email remains
available.

For Git-connected hosting, pass both `GitHubRepository` and
`GitHubAccessToken`. A CloudFormation rule rejects a deployment when only one
is supplied. If both are blank, Amplify remains in manual deployment mode;
upload `apps/web/out` using Amplify's create/start deployment APIs.

`AmplifyBranchEnabled` defaults to `true`. It controls whether the
CloudFormation-managed `AWS::Amplify::Branch` exists; it is an operational
migration control, not an application feature flag.

### Connecting an existing manual app to GitHub

Migrate an already-deployed manual Amplify app with two separate CloudFormation
updates. Do not combine the steps. Keep every unrelated stack parameter at its
current value in both updates.

Before starting, record the current `AmplifyAppId`, branch name, API endpoint,
CORS origin, and enabled safety switches. Run infra typecheck, tests, and synth.
The access token must stay in an ignored local secret file and be read by
secret-redacting deployment tooling. The tooling must not echo parameters,
enable shell tracing, print child-process arguments, or include the token in an
error message. This procedure intentionally does not provide a raw token-bearing
CLI command.

| Update | AmplifyBranchEnabled | GitHubRepository | GitHubAccessToken |
| --- | --- | --- | --- |
| 1 — remove manual branch | `false` | blank | blank |
| 2 — connect and recreate | `true` | exact HTTPS repository URL | token read from the local secret file |

1. Deploy update 1 and wait for `UPDATE_COMPLETE`. This deletes only the
   CloudFormation-managed branch; the Amplify app and its app ID remain.
2. Confirm the recorded app ID is unchanged and the configured branch no longer
   exists. While the condition is false, `AmplifyBranchUrl` and `PilotUrl`
   are deliberately absent from stack outputs, and the pilot site is
   temporarily unavailable.
3. Deploy update 2 with both GitHub parameters supplied together. The branch
   references the existing app through `Fn::GetAtt AppId`, and auto-build is
   enabled only when the GitHub connection condition is true.
4. Wait for `UPDATE_COMPLETE`, then verify the app repository, branch name,
   and `enableAutoBuild=true`. If branch creation produced no build job, confirm
   the empty job list and either start a `RELEASE` through an authorized
   operational path or merge a verified normal change to `main` through a pull
   request. Do not push directly to `main` only to trigger a build.
5. Verify a successful Amplify build and the restored pilot URL. A
   CloudFormation success without a successful Amplify build is not a completed
   migration.
6. Remove the local token file and revoke the short-lived PAT after the
   connection and build have been verified.

If update 1 rolls back, CloudFormation restores the prior manual branch. If
update 2 rolls back, the stack returns to the update-1 state, so the site remains
unavailable; correct the connection issue and retry update 2. To abandon the
migration, recreate the manual branch with `AmplifyBranchEnabled=true` while
both GitHub parameters are blank, then deploy its artifacts manually.

## First deployment and browser configuration

Amplify generates its hostname and API Gateway generates its endpoint during
the first deployment, so use this verification-gated two-pass setup:

1. Deploy once with the required parameters and `EmailOtpEnabled=false`. The
   user pool remains on Cognito default email with password as its only first
   authentication factor.
2. Click the SES verification messages for `SesFromEmail` and every pilot
   sandbox recipient, then confirm all identities are verified in the SES console.
3. Copy the `AmplifyBranchUrl` and `HttpApiEndpoint` outputs and restrict the
   Kakao JavaScript key to the emitted Amplify hostname.
4. Deploy again with `EmailOtpEnabled=true`,
   `CorsAllowedOrigin=<AmplifyBranchUrl>` and
   `PublicApiBaseUrl=<HttpApiEndpoint>`. This switches Cognito to the verified
   SES identity and enables `EMAIL_OTP`.

`PilotUrl` contains the private shared path. The slug is not an authentication
boundary. Cognito is required only for follows, push registrations and owner
review operations.

## Validation

```sh
pnpm --filter @honor/infra typecheck
pnpm --filter @honor/infra test
pnpm --filter @honor/infra synth
```

The two AWS Budgets are USD guardrails using a fixed pilot assumption of
1 USD ~= 1,400 KRW: USD 7 approximates KRW 10,000 and USD 21 approximates KRW
30,000. Update these values when the exchange-rate assumption materially drifts.
For the first deployment, both budgets filter on `Environment=pilot`, which is
already active as a user-defined cost-allocation tag. After the stack creates
resources tagged `Application=honor-benefits`, follow the runbook to activate
`Application` and tighten the filter.
