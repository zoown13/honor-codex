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
`GitHubAccessToken`. If they are blank, Amplify is created in manual deployment
mode; upload `apps/web/out` using Amplify's create/start deployment APIs.

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
