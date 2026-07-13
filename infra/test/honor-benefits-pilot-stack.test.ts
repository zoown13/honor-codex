import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { HonorBenefitsPilotStack } from "../lib/honor-benefits-pilot-stack";

let stack: HonorBenefitsPilotStack;
let template: Template;
beforeAll(() => {
  const app = new App();
  stack = new HonorBenefitsPilotStack(app, "TestStack", {
    env: { account: "111111111111", region: "ap-northeast-2" }
  });
  template = Template.fromStack(stack);
}, 60_000);

describe("HonorBenefitsPilotStack", () => {
  it("enables stack termination protection by default", () => {
    expect(stack.terminationProtection).toBe(true);
  });

  it("keeps pilot data private, versioned and bounded", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true
      },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: "ExpireRawSnapshotsAfter180Days",
            Prefix: "raw/",
            Status: "Enabled",
            ExpirationInDays: 180
          })
        ])
      }
    });
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" }
      ]
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      MessageRetentionPeriod: 1_209_600,
      SqsManagedSseEnabled: true
    });
  });

  it("gates Cognito email OTP behind verified SES and protects HTTP routes", () => {
    const synthesized = template.toJSON() as {
      Parameters: Record<string, unknown>;
      Conditions: Record<string, unknown>;
    };
    expect(synthesized.Parameters.EmailOtpEnabled).toEqual({
      Type: "String",
      Default: "false",
      AllowedValues: ["true", "false"],
      Description: expect.stringContaining("only after the SES sender identity")
    });
    expect(synthesized.Conditions.EmailOtpEnabledCondition).toEqual({
      "Fn::Equals": [{ Ref: "EmailOtpEnabled" }, "true"]
    });

    const userPoolResource = Object.values(template.findResources("AWS::Cognito::UserPool"))[0] as {
      DependsOn: string[];
      Properties: {
        UsernameAttributes: string[];
        AutoVerifiedAttributes: string[];
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: boolean };
        UserPoolTier: string;
        EmailConfiguration: {
          "Fn::If": [string, Record<string, unknown>, Record<string, unknown>];
        };
        Policies: {
          "Fn::If": [string, Record<string, unknown>, Record<string, unknown>];
        };
        EmailVerificationMessage?: string;
        EmailVerificationSubject?: string;
        VerificationMessageTemplate?: Record<string, unknown>;
      };
    };
    expect(userPoolResource.DependsOn).toContain("SesEmailIdentity");
    expect(userPoolResource.Properties).toMatchObject({
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      UserPoolTier: "ESSENTIALS"
    });
    expect(userPoolResource.Properties.EmailConfiguration).toEqual({
      "Fn::If": [
        "EmailOtpEnabledCondition",
        {
          EmailSendingAccount: "DEVELOPER",
          SourceArn: {
            "Fn::Join": [
              "",
              [
                "arn:",
                { Ref: "AWS::Partition" },
                ":ses:ap-northeast-2:111111111111:identity/",
                { Ref: "SesFromEmail" }
              ]
            ]
          },
          From: { Ref: "SesFromEmail" },
          ConfigurationSet: "honor-benefits-pilot"
        },
        {
          EmailSendingAccount: "COGNITO_DEFAULT"
        }
      ]
    });
    expect(userPoolResource.Properties.Policies).toEqual({
      "Fn::If": [
        "EmailOtpEnabledCondition",
        {
          SignInPolicy: {
            AllowedFirstAuthFactors: ["PASSWORD", "EMAIL_OTP"]
          }
        },
        {
          SignInPolicy: {
            AllowedFirstAuthFactors: ["PASSWORD"]
          }
        }
      ]
    });
    expect(userPoolResource.Properties).not.toHaveProperty("EmailVerificationMessage");
    expect(userPoolResource.Properties).not.toHaveProperty("EmailVerificationSubject");
    expect(userPoolResource.Properties.VerificationMessageTemplate ?? {}).not.toHaveProperty("EmailMessage");
    expect(userPoolResource.Properties.VerificationMessageTemplate ?? {}).not.toHaveProperty("EmailSubject");
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      ExplicitAuthFlows: Match.arrayWith(["ALLOW_USER_AUTH"]),
      AllowedOAuthFlows: Match.absent()
    });
    template.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1);
    template.resourceCountIs("AWS::ApiGatewayV2::Route", 12);
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /v1/auth/otp/start",
      AuthorizationType: "NONE"
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "DELETE /v1/me/subscriptions/{subscriptionId}",
      AuthorizationType: "JWT"
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      DefaultRouteSettings: {
        ThrottlingBurstLimit: 20,
        ThrottlingRateLimit: 10
      },
      RouteSettings: {
        "POST /v1/auth/otp/start": {
          ThrottlingBurstLimit: 2,
          ThrottlingRateLimit: 1
        },
        "POST /v1/auth/otp/verify": {
          ThrottlingBurstLimit: 5,
          ThrottlingRateLimit: 2
        }
      }
    });
  });

  it("creates the HTTP API stage after OTP routes used in route settings", () => {
    const resources = (template.toJSON() as {
      Resources: Record<string, {
        Type: string;
        Properties?: Record<string, unknown>;
        DependsOn?: string | string[];
      }>;
    }).Resources;
    const otpRouteKeys = new Set([
      "POST /v1/auth/otp/start",
      "POST /v1/auth/otp/verify"
    ]);
    const otpRouteLogicalIds = Object.entries(resources)
      .filter(([, resource]) =>
        resource.Type === "AWS::ApiGatewayV2::Route" &&
        otpRouteKeys.has(String(resource.Properties?.RouteKey))
      )
      .map(([logicalId]) => logicalId);
    expect(otpRouteLogicalIds).toHaveLength(2);

    const stageResource = Object.values(resources)
      .find(({ Type }) => Type === "AWS::ApiGatewayV2::Stage");
    expect(stageResource).toBeDefined();
    const stageDependsOn = stageResource?.DependsOn;
    const normalizedDependsOn = stageDependsOn === undefined
      ? []
      : Array.isArray(stageDependsOn) ? stageDependsOn : [stageDependsOn];
    expect(normalizedDependsOn).toEqual(expect.arrayContaining(otpRouteLogicalIds));
  });

  it("runs nine Node.js 24 ARM Lambdas with schedules, DLQs and alarms", () => {
    template.resourceCountIs("AWS::Lambda::Function", 9);
    template.allResourcesProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      DeadLetterConfig: { TargetArn: Match.anyValue() }
    });

    const lambdaResources = Object.values(template.findResources("AWS::Lambda::Function")) as Array<{
      Properties: {
        FunctionName: string;
        Environment: { Variables: Record<string, unknown> };
      };
    }>;
    const environment = (functionName: string): Record<string, unknown> => {
      const resource = lambdaResources.find(({ Properties }) => Properties.FunctionName === functionName);
      if (!resource) throw new Error("Lambda not found: " + functionName);
      return resource.Properties.Environment.Variables;
    };
    const keys = (functionName: string): string[] => Object.keys(environment(functionName)).sort();

    expect(keys("honor-pilot-ingest-mma-facilities")).toEqual([
      "DATA_BUCKET", "DATA_PREFIX", "MMA_FACILITIES_URL", "MMA_LIVE_INGESTION_ENABLED", "RAW_PREFIX", "TABLE_NAME"
    ]);
    expect(keys("honor-pilot-ingest-mma-notices")).toEqual([
      "DATA_BUCKET", "DATA_PREFIX", "MMA_LIVE_INGESTION_ENABLED", "MMA_NOTICES_URL", "RAW_PREFIX", "TABLE_NAME"
    ]);
    expect(keys("honor-pilot-ingest-ordinances")).toEqual([
      "DATA_BUCKET", "DATA_PREFIX", "LAW_API_BASE_URL", "LAW_API_OC", "RAW_PREFIX", "TABLE_NAME"
    ]);
    expect(keys("honor-pilot-subscriptions")).toEqual(["TABLE_NAME"]);
    expect(keys("honor-pilot-auth-otp")).toEqual([
      "ADMIN_EMAILS", "PILOT_ALLOWED_EMAILS", "USER_POOL_CLIENT_ID", "USER_POOL_ID"
    ]);
    expect(keys("honor-pilot-push-subscriptions")).toEqual(["TABLE_NAME", "USER_POOL_ID"]);
    expect(keys("honor-pilot-admin-reviews")).toEqual(["ADMIN_EMAILS", "TABLE_NAME"]);
    expect(keys("honor-pilot-publish")).toEqual([
      "ADMIN_EMAILS", "AMPLIFY_APP_ID", "AMPLIFY_BRANCH", "DATA_BUCKET", "DATA_PREFIX",
      "NOTIFICATION_FUNCTION_NAME", "PUBLISH_ENABLED", "RAW_PREFIX", "TABLE_NAME"
    ]);
    expect(environment("honor-pilot-publish").PUBLISH_ENABLED).toBe("false");
    expect(keys("honor-pilot-weekly-notifications")).toEqual([
      "PILOT_SLUG", "PUBLIC_APP_URL", "SES_FROM_EMAIL", "TABLE_NAME",
      "VAPID_PRIVATE_KEY", "VAPID_PUBLIC_KEY", "VAPID_SUBJECT"
    ]);
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: "lambda:InvokeFunction", Effect: "Allow", Resource: Match.anyValue() })
        ])
      }
    });

    const iamPolicies = Object.values(template.findResources("AWS::IAM::Policy")) as Array<{
      Properties: {
        PolicyDocument: {
          Statement: Array<{
            Action: string | string[];
            Resource: unknown;
            Condition?: unknown;
          }>;
        };
      };
    }>;
    const sesStatement = iamPolicies
      .flatMap(({ Properties }) => Properties.PolicyDocument.Statement)
      .find(({ Action }) => Array.isArray(Action) && Action.includes("ses:SendEmail"));
    expect(sesStatement).toBeDefined();
    expect(sesStatement?.Resource).not.toBe("*");
    expect(JSON.stringify(sesStatement?.Resource)).toContain(":identity/");
    expect(sesStatement?.Condition).toEqual({
      StringEquals: {
        "ses:FromAddress": { Ref: "SesFromEmail" }
      }
    });

    template.resourceCountIs("AWS::Events::Rule", 5);
    template.resourceCountIs("AWS::CloudWatch::Alarm", 10);
    template.resourceCountIs("AWS::Logs::LogGroup", 10);
    template.allResourcesProperties("AWS::Logs::LogGroup", {
      RetentionInDays: 14
    });
  });

  it("supports a two-step Amplify branch migration without losing the app", () => {
    const synthesized = template.toJSON() as {
      Parameters: Record<string, unknown>;
      Conditions: Record<string, unknown>;
      Rules: Record<string, {
        Assertions: Array<{ Assert: unknown; AssertDescription: string }>;
      }>;
      Resources: Record<string, {
        Type: string;
        Condition?: string;
        Properties: Record<string, unknown>;
      }>;
      Outputs: Record<string, { Condition?: string }>;
    };

    expect(synthesized.Parameters.AmplifyBranchEnabled).toEqual({
      Type: "String",
      Default: "true",
      AllowedValues: ["true", "false"],
      Description: expect.stringContaining("existing manual-app GitHub migration")
    });
    expect(synthesized.Conditions.AmplifyBranchEnabledCondition).toEqual({
      "Fn::Equals": [{ Ref: "AmplifyBranchEnabled" }, "true"]
    });

    const appEntry = Object.entries(synthesized.Resources)
      .find(([, resource]) => resource.Type === "AWS::Amplify::App");
    const branchEntry = Object.entries(synthesized.Resources)
      .find(([, resource]) => resource.Type === "AWS::Amplify::Branch");
    expect(appEntry).toBeDefined();
    expect(branchEntry).toBeDefined();
    if (!appEntry || !branchEntry) throw new Error("Amplify app or branch missing");

    const [appLogicalId, appResource] = appEntry;
    const [, branchResource] = branchEntry;
    expect(appResource.Properties.Repository).toEqual({
      "Fn::If": ["HasGitHubConnection", { Ref: "GitHubRepository" }, { Ref: "AWS::NoValue" }]
    });
    expect(appResource.Properties.AccessToken).toEqual({
      "Fn::If": ["HasGitHubConnection", { Ref: "GitHubAccessToken" }, { Ref: "AWS::NoValue" }]
    });
    expect(branchResource.Condition).toBe("AmplifyBranchEnabledCondition");
    expect(branchResource.Properties.AppId).toEqual({
      "Fn::GetAtt": [appLogicalId, "AppId"]
    });
    expect(branchResource.Properties.EnableAutoBuild).toEqual({
      "Fn::If": ["HasGitHubConnection", true, false]
    });
    const branchUrlOutput = synthesized.Outputs.AmplifyBranchUrl;
    const pilotUrlOutput = synthesized.Outputs.PilotUrl;
    const githubRule = synthesized.Rules.GitHubConnectionParametersMatch;
    expect(branchUrlOutput).toBeDefined();
    expect(pilotUrlOutput).toBeDefined();
    expect(githubRule).toBeDefined();
    if (!branchUrlOutput || !pilotUrlOutput || !githubRule) {
      throw new Error("Conditional Amplify outputs or GitHub rule missing");
    }
    expect(branchUrlOutput.Condition).toBe("AmplifyBranchEnabledCondition");
    expect(pilotUrlOutput.Condition).toBe("AmplifyBranchEnabledCondition");
    expect(githubRule.Assertions).toHaveLength(1);
    expect(githubRule.Assertions[0]?.AssertDescription).toContain("must either both be blank");
    expect(githubRule.Assertions[0]?.Assert).toEqual({
      "Fn::Or": [
        {
          "Fn::And": [
            { "Fn::Equals": [{ Ref: "GitHubRepository" }, ""] },
            { "Fn::Equals": [{ Ref: "GitHubAccessToken" }, ""] }
          ]
        },
        {
          "Fn::And": [
            { "Fn::Not": [{ "Fn::Equals": [{ Ref: "GitHubRepository" }, ""] }] },
            { "Fn::Not": [{ "Fn::Equals": [{ Ref: "GitHubAccessToken" }, ""] }] }
          ]
        }
      ]
    });
  });

  it("provisions only the lean pilot hosting and cost controls", () => {
    template.resourceCountIs("AWS::Amplify::App", 1);
    template.resourceCountIs("AWS::Amplify::Branch", 1);
    template.hasResourceProperties("AWS::Amplify::App", {
      BuildSpec: Match.stringLikeRegexp("aws s3 sync"),
      EnvironmentVariables: Match.arrayWith([
        Match.objectLike({ Name: "AMPLIFY_MONOREPO_APP_ROOT", Value: "apps/web" }),
        Match.objectLike({ Name: "NEXT_PUBLIC_KAKAO_MAP_APP_KEY" }),
        Match.objectLike({ Name: "NEXT_PUBLIC_VAPID_PUBLIC_KEY" })
      ]),
      CustomRules: Match.arrayWith([
        Match.objectLike({ Source: "/<*>", Target: "/404.html", Status: "404" })
      ])
    });
    const amplifyApp = Object.values(template.findResources("AWS::Amplify::App"))[0] as {
      Properties: { BuildSpec: string; CustomHeaders: string };
    };
    expect(amplifyApp.Properties.BuildSpec).toContain("pnpm --filter @honor/web test");
    expect(amplifyApp.Properties.BuildSpec).toContain("test -f apps/web/out/404.html");
    expect(amplifyApp.Properties.BuildSpec).toContain(
      'test -f "apps/web/out/pilot/$NEXT_PUBLIC_PILOT_SLUG/index.html"'
    );
    expect(amplifyApp.Properties.BuildSpec.indexOf("pnpm --filter @honor/web test")).toBeLessThan(
      amplifyApp.Properties.BuildSpec.indexOf("pnpm --filter @honor/web build")
    );
    expect(amplifyApp.Properties.BuildSpec).toContain(
      ["applications:", "  - appRoot: apps/web", "    frontend:"].join("\n")
    );
    expect(amplifyApp.Properties.BuildSpec).toContain("      buildPath: /");
    expect(amplifyApp.Properties.BuildSpec).toContain(
      ["      artifacts:", "        baseDirectory: apps/web/out"].join("\n")
    );
    expect(
      amplifyApp.Properties.CustomHeaders.startsWith(
        ["applications:", "  - appRoot: apps/web", "    customHeaders:"].join("\n")
      )
    ).toBe(true);
    expect(amplifyApp.Properties.CustomHeaders).not.toMatch(/^customHeaders:/);
    expect(amplifyApp.Properties.CustomHeaders).toContain("Content-Security-Policy");
    expect(amplifyApp.Properties.CustomHeaders).toContain("https://dapi.kakao.com");
    expect(amplifyApp.Properties.CustomHeaders).toContain("https://*.execute-api.ap-northeast-2.amazonaws.com");
    expect(amplifyApp.Properties.CustomHeaders).toContain("Permissions-Policy");
    expect(amplifyApp.Properties.CustomHeaders).toContain("Strict-Transport-Security");

    template.resourceCountIs("AWS::Budgets::Budget", 2);
    template.allResourcesProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({
        CostFilters: {
          TagKeyValue: ["user:Environment$pilot"]
        }
      })
    });
    template.resourceCountIs("AWS::SES::ConfigurationSet", 1);
    template.resourceCountIs("AWS::SES::EmailIdentity", 1);
    template.resourceCountIs("AWS::WAFv2::WebACL", 0);
    template.resourceCountIs("AWS::Route53::HostedZone", 0);
    template.resourceCountIs("AWS::StepFunctions::StateMachine", 0);
    template.resourceCountIs("AWS::ECS::Service", 0);

    const outputs = template.findOutputs("*");
    expect(outputs).toHaveProperty("HttpApiEndpoint");
    expect(outputs).toHaveProperty("AmplifyBranchUrl");
    expect(outputs).toHaveProperty("PilotUrl");
    expect(outputs).toHaveProperty("UserPoolId");
  });
});
