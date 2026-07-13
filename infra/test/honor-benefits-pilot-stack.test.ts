import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { HonorBenefitsPilotStack } from "../lib/honor-benefits-pilot-stack";

const synthTemplate = (): Template => {
  const app = new App();
  const stack = new HonorBenefitsPilotStack(app, "TestStack", {
    env: { account: "111111111111", region: "ap-northeast-2" }
  });
  return Template.fromStack(stack);
};

let template: Template;
beforeAll(() => {
  template = synthTemplate();
}, 60_000);

describe("HonorBenefitsPilotStack", () => {
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

  it("uses Cognito choice-based email OTP and JWT-protected HTTP routes", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      EmailConfiguration: {
        EmailSendingAccount: "DEVELOPER",
        SourceArn: Match.anyValue()
      },
      UserPoolTier: "ESSENTIALS",
      Policies: {
        SignInPolicy: {
          AllowedFirstAuthFactors: ["PASSWORD", "EMAIL_OTP"]
        }
      }
    });
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
      }
    });
  });

  it("runs nine Node.js 24 ARM Lambdas with schedules, DLQs and alarms", () => {
    template.resourceCountIs("AWS::Lambda::Function", 9);
    template.allResourcesProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      DeadLetterConfig: { TargetArn: Match.anyValue() },
      Environment: {
        Variables: Match.objectLike({
          PILOT_SLUG: Match.anyValue(),
          PUBLIC_APP_URL: Match.anyValue(),
          VAPID_SUBJECT: Match.anyValue(),
          TABLE_NAME: Match.anyValue(),
          DATA_BUCKET: Match.anyValue(),
          MMA_LIVE_INGESTION_ENABLED: Match.anyValue(),
          SES_FROM_EMAIL: Match.anyValue(),
          AMPLIFY_APP_ID: Match.anyValue()
        })
      }
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "honor-pilot-publish",
      Environment: {
        Variables: Match.objectLike({ NOTIFICATION_FUNCTION_NAME: Match.anyValue() })
      }
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: "lambda:InvokeFunction", Effect: "Allow", Resource: Match.anyValue() })
        ])
      }
    });
    template.resourceCountIs("AWS::Events::Rule", 5);
    template.resourceCountIs("AWS::CloudWatch::Alarm", 10);
    template.resourceCountIs("AWS::Logs::LogGroup", 10);
    template.allResourcesProperties("AWS::Logs::LogGroup", {
      RetentionInDays: 14
    });
  });

  it("provisions only the lean pilot hosting and cost controls", () => {
    template.resourceCountIs("AWS::Amplify::App", 1);
    template.resourceCountIs("AWS::Amplify::Branch", 1);
    template.hasResourceProperties("AWS::Amplify::App", {
      BuildSpec: Match.stringLikeRegexp("aws s3 sync"),
      EnvironmentVariables: Match.arrayWith([
        Match.objectLike({ Name: "NEXT_PUBLIC_KAKAO_MAP_APP_KEY" }),
        Match.objectLike({ Name: "NEXT_PUBLIC_VAPID_PUBLIC_KEY" })
      ]),
      CustomRules: Match.arrayWith([
        Match.objectLike({ Source: "/", Target: "/404.html", Status: "404" })
      ])
    });
    template.resourceCountIs("AWS::Budgets::Budget", 2);
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
