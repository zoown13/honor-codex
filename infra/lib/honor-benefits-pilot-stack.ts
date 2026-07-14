import * as path from "node:path";
import {
  ArnFormat,
  Aws,
  CfnCondition,
  CfnOutput,
  CfnParameter,
  CfnRule,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags
} from "aws-cdk-lib";
import * as amplify from "aws-cdk-lib/aws-amplify";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

interface PilotFunctionOptions {
  readonly entry: string;
  readonly environment: Record<string, string>;
  readonly memorySize?: number;
  readonly timeout?: Duration;
}

/**
 * Single-account, single-region infrastructure for the private pilot.
 *
 * The stack intentionally omits WAF, Route 53, custom domains, VPCs and
 * Step Functions. Parameters make it possible to synthesize without AWS
 * credentials and to defer external credentials until deployment.
 */
export class HonorBenefitsPilotStack extends Stack {
  public constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, {
      ...props,
      terminationProtection: props.terminationProtection ?? true
    });

    if (Stack.of(this).region !== "ap-northeast-2" && !Stack.of(this).region.includes("${Token")) {
      throw new Error("The pilot stack must be deployed in ap-northeast-2.");
    }

    Tags.of(this).add("Application", "honor-benefits");
    Tags.of(this).add("Environment", "pilot");
    Tags.of(this).add("ManagedBy", "aws-cdk");

    const pilotSlug = new CfnParameter(this, "PilotSlug", {
      type: "String",
      noEcho: true,
      minLength: 22,
      allowedPattern: "[A-Za-z0-9_-]+",
      constraintDescription: "Use at least 128 bits of URL-safe random data (22+ base64url characters).",
      description: "Private URL slug used at /pilot/{slug}. This is obscurity, not authentication."
    });
    const adminEmails = new CfnParameter(this, "AdminEmails", {
      type: "String",
      default: "",
      description: "Comma-separated, lower-case email addresses allowed to perform owner review actions."
    });
    const pilotAllowedEmails = new CfnParameter(this, "PilotAllowedEmails", {
      type: "String",
      default: "",
      description: "Comma-separated, lower-case email allowlist for the private pilot OTP flow."
    });
    const alertEmail = new CfnParameter(this, "AlertEmail", {
      type: "String",
      allowedPattern: "[^@\\s]+@[^@\\s]+\\.[^@\\s]+",
      description: "Email address for CloudWatch and AWS Budgets notifications. SNS confirmation is required."
    });
    const sesFromEmail = new CfnParameter(this, "SesFromEmail", {
      type: "String",
      allowedPattern: "[^@\\s]+@[^@\\s]+\\.[^@\\s]+",
      description: "SES sender for weekly notifications and email OTP after identity and sandbox recipient verification."
    });
    const emailOtpEnabled = new CfnParameter(this, "EmailOtpEnabled", {
      type: "String",
      default: "false",
      allowedValues: ["true", "false"],
      description: "Enable Cognito email OTP only after the SES sender identity and all sandbox recipient emails are verified."
    });
    const emailOtpEnabledCondition = new CfnCondition(this, "EmailOtpEnabledCondition", {
      expression: Fn.conditionEquals(emailOtpEnabled.valueAsString, "true")
    });
    const lawApiOc = new CfnParameter(this, "LawApiOc", {
      type: "String",
      noEcho: true,
      default: "",
      description: "Optional law.go.kr OPEN API OC value. Ordinance ingestion is skipped while blank."
    });
    const mmaLiveIngestionEnabled = new CfnParameter(this, "MmaLiveIngestionEnabled", {
      type: "String",
      default: "false",
      allowedValues: ["true", "false"],
      description: "Explicit safety switch for the undocumented MMA live JSONP endpoint."
    });
    const facilitiesIngestionScheduleEnabled = new CfnParameter(this, "FacilitiesIngestionScheduleEnabled", {
      type: "String",
      default: "false",
      allowedValues: ["true", "false"],
      description: "Enable the facility ingestion schedule only after its live source preflight succeeds."
    });
    const facilitiesIngestionScheduleEnabledCondition = new CfnCondition(
      this,
      "FacilitiesIngestionScheduleEnabledCondition",
      { expression: Fn.conditionEquals(facilitiesIngestionScheduleEnabled.valueAsString, "true") }
    );
    const noticesIngestionScheduleEnabled = new CfnParameter(this, "NoticesIngestionScheduleEnabled", {
      type: "String",
      default: "false",
      allowedValues: ["true", "false"],
      description: "Enable the notice ingestion schedule only after its live source preflight succeeds."
    });
    const noticesIngestionScheduleEnabledCondition = new CfnCondition(
      this,
      "NoticesIngestionScheduleEnabledCondition",
      { expression: Fn.conditionEquals(noticesIngestionScheduleEnabled.valueAsString, "true") }
    );
    const ordinancesIngestionScheduleEnabled = new CfnParameter(this, "OrdinancesIngestionScheduleEnabled", {
      type: "String",
      default: "false",
      allowedValues: ["true", "false"],
      description: "Enable the ordinance ingestion schedule only after its live source preflight succeeds."
    });
    const ordinancesIngestionScheduleEnabledCondition = new CfnCondition(
      this,
      "OrdinancesIngestionScheduleEnabledCondition",
      { expression: Fn.conditionEquals(ordinancesIngestionScheduleEnabled.valueAsString, "true") }
    );
    const mmaFacilitiesUrl = new CfnParameter(this, "MmaFacilitiesUrl", {
      type: "String",
      default: "https://open.mma.go.kr/caisGGGS/bymmgListAjaxJsonCall.json"
    });
    const mmaNoticesUrl = new CfnParameter(this, "MmaNoticesUrl", {
      type: "String",
      default: "https://www.mma.go.kr/hall/board/boardList.do?mc=mma0003395&gesipan_id=217",
      description: "MMA honorable-family benefit notice board. The shared live-ingestion switch remains off by default."
    });
    const lawApiBaseUrl = new CfnParameter(this, "LawApiBaseUrl", {
      type: "String",
      default: "https://www.law.go.kr/DRF"
    });
    const githubRepository = new CfnParameter(this, "GitHubRepository", {
      type: "String",
      default: "",
      description: "Optional HTTPS GitHub repository URL. Leave blank for manual Amplify deployment mode."
    });
    const githubAccessToken = new CfnParameter(this, "GitHubAccessToken", {
      type: "String",
      noEcho: true,
      default: "",
      description: "Optional GitHub personal access token used only when GitHubRepository is supplied."
    });
    const amplifyBranchName = new CfnParameter(this, "AmplifyBranchName", {
      type: "String",
      default: "main",
      allowedPattern: "[A-Za-z0-9._/-]+"
    });
    const amplifyBranchEnabled = new CfnParameter(this, "AmplifyBranchEnabled", {
      type: "String",
      default: "true",
      allowedValues: ["true", "false"],
      description: [
        "Controls the CloudFormation-managed Amplify branch.",
        "Set false for the first step of an existing manual-app GitHub migration,",
        "then true when reconnecting the app and recreating the branch."
      ].join(" ")
    });
    const amplifyBranchEnabledCondition = new CfnCondition(this, "AmplifyBranchEnabledCondition", {
      expression: Fn.conditionEquals(amplifyBranchEnabled.valueAsString, "true")
    });
    const corsAllowedOrigin = new CfnParameter(this, "CorsAllowedOrigin", {
      type: "String",
      default: "http://localhost:3000",
      description: "Exact browser origin allowed by HTTP API CORS. Set to the AmplifyBranchUrl output after the first deployment."
    });
    const publicApiBaseUrl = new CfnParameter(this, "PublicApiBaseUrl", {
      type: "String",
      default: "",
      description: "Optional API endpoint injected into the Amplify build. Set to HttpApiEndpoint after the first deployment."
    });
    const kakaoJavascriptKey = new CfnParameter(this, "KakaoJavascriptKey", {
      type: "String",
      noEcho: true,
      default: "",
      description: "Kakao Maps JavaScript key restricted to the Amplify hostname. It is public in the browser bundle."
    });
    const vapidSubject = new CfnParameter(this, "VapidSubject", {
      type: "String",
      default: "",
      description: "Optional Web Push contact URI, for example mailto:owner@example.com."
    });
    const vapidPublicKey = new CfnParameter(this, "VapidPublicKey", {
      type: "String",
      default: "",
      description: "Optional VAPID public key. Web Push remains disabled unless all VAPID parameters are supplied."
    });
    const vapidPrivateKey = new CfnParameter(this, "VapidPrivateKey", {
      type: "String",
      noEcho: true,
      default: "",
      description: "Optional VAPID private key. Stored in Lambda configuration for this small private pilot."
    });

    const dataBucket = new s3.Bucket(this, "DataBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          id: "ExpireRawSnapshotsAfter180Days",
          prefix: "raw/",
          enabled: true,
          expiration: Duration.days(180),
          noncurrentVersionExpiration: Duration.days(180)
        }
      ]
    });

    const table = new dynamodb.Table(this, "PilotTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN
    });
    table.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    const dlq = new sqs.Queue(this, "SharedDeadLetterQueue", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN
    });

    const alarmTopic = new sns.Topic(this, "OperationsAlarmTopic", {
      displayName: "Honor Benefits pilot operations alarms"
    });
    alarmTopic.addSubscription(new snsSubscriptions.EmailSubscription(alertEmail.valueAsString));

    const dlqAlarm = new cloudwatch.Alarm(this, "DeadLetterQueueMessagesAlarm", {
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "At least one pilot message is waiting in the shared DLQ."
    });
    dlqAlarm.addAlarmAction({ bind: () => ({ alarmActionArn: alarmTopic.topicArn }) });

    const sesConfigurationSetName = "honor-benefits-pilot";
    const sesConfigurationSet = new ses.CfnConfigurationSet(this, "SesConfigurationSet", {
      name: sesConfigurationSetName,
      sendingOptions: { sendingEnabled: true }
    });
    const sesIdentity = new ses.CfnEmailIdentity(this, "SesEmailIdentity", {
      emailIdentity: sesFromEmail.valueAsString,
      configurationSetAttributes: { configurationSetName: sesConfigurationSetName }
    });
    sesIdentity.addDependency(sesConfigurationSet);
    const sesIdentityArn = this.formatArn({
      service: "ses",
      resource: "identity",
      resourceName: sesFromEmail.valueAsString,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME
    });

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "honor-benefits-pilot",
      selfSignUpEnabled: false,
      email: cognito.UserPoolEmail.withCognito(),
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      signInPolicy: {
        allowedFirstAuthFactors: {
          password: true
        }
      },
      removalPolicy: RemovalPolicy.RETAIN
    });
    const cfnUserPool = userPool.node.defaultChild as cognito.CfnUserPool;
    cfnUserPool.emailConfiguration = Fn.conditionIf(
      emailOtpEnabledCondition.logicalId,
      {
        EmailSendingAccount: "DEVELOPER",
        SourceArn: sesIdentityArn,
        From: sesFromEmail.valueAsString,
        ConfigurationSet: sesConfigurationSetName
      },
      {
        EmailSendingAccount: "COGNITO_DEFAULT"
      }
    );
    cfnUserPool.policies = Fn.conditionIf(
      emailOtpEnabledCondition.logicalId,
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
    );
    cfnUserPool.addPropertyDeletionOverride("EmailVerificationMessage");
    cfnUserPool.addPropertyDeletionOverride("EmailVerificationSubject");
    cfnUserPool.addPropertyDeletionOverride("VerificationMessageTemplate.EmailMessage");
    cfnUserPool.addPropertyDeletionOverride("VerificationMessageTemplate.EmailSubject");
    userPool.node.addDependency(sesIdentity);
    const userPoolClient = userPool.addClient("WebClient", {
      userPoolClientName: "honor-benefits-pilot-web",
      generateSecret: false,
      authFlows: { user: true },
      disableOAuth: true,
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30)
    });
    new cognito.CfnUserPoolGroup(this, "AdminGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "ADMIN",
      description: "Owners allowed to approve changes and publish datasets."
    });

    const hasGitHubConnection = new CfnCondition(this, "HasGitHubConnection", {
      expression: Fn.conditionAnd(
        Fn.conditionNot(Fn.conditionEquals(githubRepository.valueAsString, "")),
        Fn.conditionNot(Fn.conditionEquals(githubAccessToken.valueAsString, ""))
      )
    });
    new CfnRule(this, "GitHubConnectionParametersMatch", {
      assertions: [
        {
          assert: Fn.conditionOr(
            Fn.conditionAnd(
              Fn.conditionEquals(githubRepository.valueAsString, ""),
              Fn.conditionEquals(githubAccessToken.valueAsString, "")
            ),
            Fn.conditionAnd(
              Fn.conditionNot(Fn.conditionEquals(githubRepository.valueAsString, "")),
              Fn.conditionNot(Fn.conditionEquals(githubAccessToken.valueAsString, ""))
            )
          ),
          assertDescription: [
            "GitHubRepository and GitHubAccessToken must either both be blank",
            "or both be supplied."
          ].join(" ")
        }
      ]
    });
    const amplifyServiceRole = new iam.Role(this, "AmplifyServiceRole", {
      assumedBy: new iam.ServicePrincipal("amplify.amazonaws.com"),
      description: "Allows Amplify builds to read the active pilot dataset."
    });
    dataBucket.grantRead(amplifyServiceRole, "published/*");

    const amplifyApp = new amplify.CfnApp(this, "AmplifyApp", {
      name: "honor-benefits-pilot",
      description: "Private pilot; shared URL is not an authentication boundary.",
      platform: "WEB",
      iamServiceRole: amplifyServiceRole.roleArn,
      repository: Fn.conditionIf(
        hasGitHubConnection.logicalId,
        githubRepository.valueAsString,
        Aws.NO_VALUE
      ).toString(),
      accessToken: Fn.conditionIf(
        hasGitHubConnection.logicalId,
        githubAccessToken.valueAsString,
        Aws.NO_VALUE
      ).toString(),
      buildSpec: [
        "version: 1",
        "applications:",
        "  - appRoot: apps/web",
        "    frontend:",
        "      buildPath: /",
        "      phases:",
        "        preBuild:",
        "          commands:",
        "            - nvm install 24",
        "            - nvm use 24",
        "            - npm install -g pnpm@11.5.3",
        "            - pnpm install --frozen-lockfile",
        "        build:",
        "          commands:",
        "            - mkdir -p apps/web/public/data",
        "            - aws s3 sync \"s3://$DATA_BUCKET/$DATA_PREFIX\" apps/web/public/data",
        "            - pnpm --filter @honor/web test",
        "            - pnpm --filter @honor/web build",
        "            - test -f apps/web/out/404.html",
        "            - test -f \"apps/web/out/pilot/$NEXT_PUBLIC_PILOT_SLUG/index.html\"",
        "      artifacts:",
        "        baseDirectory: apps/web/out",
        "        files:",
        "          - '**/*'",
        "      cache:",
        "        paths:",
        "          - node_modules/**/*",
        "          - .pnpm-store/**/*"
      ].join("\n"),
      customHeaders: [
        "applications:",
        "  - appRoot: apps/web",
        "    customHeaders:",
        "      - pattern: '**/*'",
        "        headers:",
        "          - key: X-Robots-Tag",
        "            value: 'noindex, nofollow, noarchive'",
        "          - key: Strict-Transport-Security",
        "            value: 'max-age=31536000; includeSubDomains'",
        "          - key: Content-Security-Policy",
        "            value: \"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline' https://dapi.kakao.com https://*.daumcdn.net; style-src 'self' 'unsafe-inline' https://*.daumcdn.net; img-src 'self' data: blob: https://*.kakao.com https://*.daum.net https://*.daumcdn.net; font-src 'self' data:; connect-src 'self' https://*.execute-api.ap-northeast-2.amazonaws.com https://dapi.kakao.com https://*.kakao.com https://*.daum.net; worker-src 'self' blob:; manifest-src 'self'; frame-src 'self' https://*.kakao.com https://*.daum.net; upgrade-insecure-requests\"",
        "          - key: Referrer-Policy",
        "            value: 'strict-origin-when-cross-origin'",
        "          - key: Permissions-Policy",
        "            value: 'geolocation=(self), camera=(), microphone=(), payment=(), usb=()'",
        "          - key: X-Content-Type-Options",
        "            value: 'nosniff'",
        "          - key: X-Frame-Options",
        "            value: 'DENY'",
        "          - key: Cross-Origin-Opener-Policy",
        "            value: 'same-origin-allow-popups'",
        "          - key: Cross-Origin-Resource-Policy",
        "            value: 'same-site'",
        "          - key: X-Permitted-Cross-Domain-Policies",
        "            value: 'none'",
        "      - pattern: '/data/**'",
        "        headers:",
        "          - key: Cache-Control",
        "            value: 'public, max-age=60, stale-while-revalidate=86400'"
      ].join("\n"),
      customRules: [],
      environmentVariables: [
        { name: "AMPLIFY_MONOREPO_APP_ROOT", value: "apps/web" },
        { name: "NEXT_PUBLIC_PILOT_SLUG", value: pilotSlug.valueAsString },
        { name: "NEXT_PUBLIC_API_BASE_URL", value: publicApiBaseUrl.valueAsString },
        { name: "NEXT_PUBLIC_COGNITO_USER_POOL_ID", value: userPool.userPoolId },
        { name: "NEXT_PUBLIC_COGNITO_CLIENT_ID", value: userPoolClient.userPoolClientId },
        { name: "NEXT_PUBLIC_AWS_REGION", value: this.region },
        { name: "NEXT_PUBLIC_KAKAO_MAP_APP_KEY", value: kakaoJavascriptKey.valueAsString },
        { name: "NEXT_PUBLIC_VAPID_PUBLIC_KEY", value: vapidPublicKey.valueAsString },
        { name: "DATA_BUCKET", value: dataBucket.bucketName },
        { name: "DATA_PREFIX", value: "published/" }
      ]
    });
    const amplifyBranch = new amplify.CfnBranch(this, "AmplifyBranch", {
      appId: amplifyApp.attrAppId,
      branchName: amplifyBranchName.valueAsString,
      stage: "PRODUCTION",
      enableAutoBuild: Fn.conditionIf(hasGitHubConnection.logicalId, true, false),
      enablePullRequestPreview: false
    });
    amplifyBranch.cfnOptions.condition = amplifyBranchEnabledCondition;
    const amplifyBranchUrl = "https://" + amplifyBranchName.valueAsString + "." + amplifyApp.attrDefaultDomain;

    new events.Rule(this, "AmplifyDeploymentFailureRule", {
      description: "Notify the pilot owner when an Amplify deployment fails.",
      eventPattern: {
        source: ["aws.amplify"],
        detailType: ["Amplify Deployment Status Change"],
        detail: {
          appId: [amplifyApp.attrAppId],
          jobStatus: ["FAILED"]
        }
      },
      targets: [new targets.SnsTopic(alarmTopic)]
    });

    const repositoryEnvironment: Record<string, string> = {
      TABLE_NAME: table.tableName
    };
    const datasetEnvironment: Record<string, string> = {
      DATA_BUCKET: dataBucket.bucketName,
      DATA_PREFIX: "published/",
      RAW_PREFIX: "raw/"
    };
    const repoRoot = path.resolve(__dirname, "../..");
    const functionEntriesRoot = path.join(repoRoot, "services/functions/src/handlers");

    const createFunction = (functionId: string, options: PilotFunctionOptions): nodejs.NodejsFunction => {
      const functionName = `honor-pilot-${functionId
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()}`;
      const logGroup = new logs.LogGroup(this, `${functionId}LogGroup`, {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY
      });
      const handlerFunction = new nodejs.NodejsFunction(this, functionId, {
        functionName,
        description: `Honor Benefits pilot: ${functionId}`,
        entry: path.join(functionEntriesRoot, options.entry),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: options.memorySize ?? 256,
        timeout: options.timeout ?? Duration.seconds(30),
        logGroup,
        environment: options.environment,
        deadLetterQueue: dlq,
        retryAttempts: 2,
        bundling: {
          format: nodejs.OutputFormat.CJS,
          target: "node24",
          minify: false,
          sourceMap: true,
          sourcesContent: false
        }
      });
      const errorAlarm = new cloudwatch.Alarm(this, `${functionId}ErrorsAlarm`, {
        metric: handlerFunction.metricErrors({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${functionName} reported at least one error.`
      });
      errorAlarm.addAlarmAction({ bind: () => ({ alarmActionArn: alarmTopic.topicArn }) });
      return handlerFunction;
    };

    const facilitiesIngest = createFunction("IngestMmaFacilities", {
      entry: "ingest-mma-facilities.ts",
      environment: {
        ...repositoryEnvironment,
        ...datasetEnvironment,
        MMA_LIVE_INGESTION_ENABLED: mmaLiveIngestionEnabled.valueAsString,
        MMA_FACILITIES_URL: mmaFacilitiesUrl.valueAsString
      },
      memorySize: 1024,
      timeout: Duration.minutes(10)
    });
    const noticesIngest = createFunction("IngestMmaNotices", {
      entry: "ingest-mma-notices.ts",
      environment: {
        ...repositoryEnvironment,
        ...datasetEnvironment,
        MMA_LIVE_INGESTION_ENABLED: mmaLiveIngestionEnabled.valueAsString,
        MMA_NOTICES_URL: mmaNoticesUrl.valueAsString
      },
      memorySize: 512,
      timeout: Duration.minutes(5)
    });
    const ordinancesIngest = createFunction("IngestOrdinances", {
      entry: "ingest-ordinances.ts",
      environment: {
        ...repositoryEnvironment,
        ...datasetEnvironment,
        LAW_API_OC: lawApiOc.valueAsString,
        LAW_API_BASE_URL: lawApiBaseUrl.valueAsString
      },
      memorySize: 512,
      timeout: Duration.minutes(10)
    });
    const subscriptionsFunction = createFunction("Subscriptions", {
      entry: "subscriptions.ts",
      environment: repositoryEnvironment
    });
    const authOtpFunction = createFunction("AuthOtp", {
      entry: "auth-otp.ts",
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        PILOT_ALLOWED_EMAILS: pilotAllowedEmails.valueAsString,
        ADMIN_EMAILS: adminEmails.valueAsString
      }
    });
    const pushSubscriptionsFunction = createFunction("PushSubscriptions", {
      entry: "push-subscriptions.ts",
      environment: {
        ...repositoryEnvironment,
        USER_POOL_ID: userPool.userPoolId
      }
    });
    const adminReviewsFunction = createFunction("AdminReviews", {
      entry: "admin-reviews.ts",
      environment: {
        ...repositoryEnvironment,
        ADMIN_EMAILS: adminEmails.valueAsString
      }
    });
    const publishFunction = createFunction("Publish", {
      entry: "publish.ts",
      environment: {
        ...repositoryEnvironment,
        ...datasetEnvironment,
        AMPLIFY_APP_ID: amplifyApp.attrAppId,
        AMPLIFY_BRANCH: amplifyBranchName.valueAsString,
        ADMIN_EMAILS: adminEmails.valueAsString,
        PUBLISH_ENABLED: "false"
      },
      memorySize: 512,
      timeout: Duration.minutes(5)
    });
    const weeklyNotificationsFunction = createFunction("WeeklyNotifications", {
      entry: "weekly-notifications.ts",
      environment: {
        ...repositoryEnvironment,
        PILOT_SLUG: pilotSlug.valueAsString,
        PUBLIC_APP_URL: amplifyBranchUrl,
        VAPID_SUBJECT: vapidSubject.valueAsString,
        VAPID_PUBLIC_KEY: vapidPublicKey.valueAsString,
        VAPID_PRIVATE_KEY: vapidPrivateKey.valueAsString,
        SES_FROM_EMAIL: sesFromEmail.valueAsString
      },
      memorySize: 512,
      timeout: Duration.minutes(5)
    });
    publishFunction.addEnvironment("NOTIFICATION_FUNCTION_NAME", weeklyNotificationsFunction.functionName);
    weeklyNotificationsFunction.grantInvoke(publishFunction);

    for (const ingestFunction of [facilitiesIngest, noticesIngest, ordinancesIngest]) {
      table.grantReadWriteData(ingestFunction);
      dataBucket.grantReadWrite(ingestFunction);
    }
    for (const apiFunction of [
      subscriptionsFunction,
      pushSubscriptionsFunction,
      adminReviewsFunction,
      publishFunction,
      weeklyNotificationsFunction
    ]) {
      table.grantReadWriteData(apiFunction);
    }
    dataBucket.grantReadWrite(publishFunction);
    userPool.grant(pushSubscriptionsFunction, "cognito-idp:AdminDeleteUser");
    userPool.grant(authOtpFunction, "cognito-idp:AdminCreateUser");
    userPool.grant(authOtpFunction, "cognito-idp:AdminAddUserToGroup");
    authOtpFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:InitiateAuth",
          "cognito-idp:RespondToAuthChallenge",
          "cognito-idp:GetUser"
        ],
        resources: ["*"]
      })
    );
    weeklyNotificationsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: [sesIdentityArn],
        conditions: {
          StringEquals: {
            "ses:FromAddress": sesFromEmail.valueAsString
          }
        }
      })
    );
    publishFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["amplify:StartJob", "amplify:CreateDeployment", "amplify:StartDeployment"],
        resources: [
          this.formatArn({
            service: "amplify",
            resource: "apps",
            resourceName: `${amplifyApp.attrAppId}/branches/${amplifyBranchName.valueAsString}`,
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME
          }),
          this.formatArn({
            service: "amplify",
            resource: "apps",
            resourceName: `${amplifyApp.attrAppId}/branches/${amplifyBranchName.valueAsString}/jobs/*`,
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME
          })
        ]
      })
    );

    const scheduleTarget = (handlerFunction: lambda.IFunction, job: string): targets.LambdaFunction =>
      new targets.LambdaFunction(handlerFunction, {
        deadLetterQueue: dlq,
        retryAttempts: 2,
        maxEventAge: Duration.hours(2),
        event: events.RuleTargetInput.fromObject({ source: "schedule", job })
      });

    const ingestionScheduleState = (condition: CfnCondition): string =>
      Fn.conditionIf(condition.logicalId, "ENABLED", "DISABLED").toString();
    const dailyFacilitiesRule = new events.Rule(this, "DailyFacilitiesRule", {
      description: "Daily MMA facilities ingest at 03:00 KST (18:00 UTC).",
      schedule: events.Schedule.cron({ minute: "0", hour: "18" }),
      targets: [scheduleTarget(facilitiesIngest, "mma-facilities")]
    });
    (dailyFacilitiesRule.node.defaultChild as events.CfnRule).state =
      ingestionScheduleState(facilitiesIngestionScheduleEnabledCondition);
    const dailyNoticesRule = new events.Rule(this, "DailyNoticesRule", {
      description: "Daily MMA notices ingest at 03:15 KST (18:15 UTC).",
      schedule: events.Schedule.cron({ minute: "15", hour: "18" }),
      targets: [scheduleTarget(noticesIngest, "mma-notices")]
    });
    (dailyNoticesRule.node.defaultChild as events.CfnRule).state =
      ingestionScheduleState(noticesIngestionScheduleEnabledCondition);
    const weeklyOrdinancesRule = new events.Rule(this, "WeeklyOrdinancesRule", {
      description: "Weekly ordinance ingest on Monday at 03:30 KST (Sunday 18:30 UTC).",
      schedule: events.Schedule.cron({ minute: "30", hour: "18", weekDay: "SUN" }),
      targets: [scheduleTarget(ordinancesIngest, "ordinances")]
    });
    (weeklyOrdinancesRule.node.defaultChild as events.CfnRule).state =
      ingestionScheduleState(ordinancesIngestionScheduleEnabledCondition);
    new events.Rule(this, "WeeklyNotificationsRule", {
      description: "Weekly follower digest on Monday at 09:00 KST (00:00 UTC).",
      schedule: events.Schedule.cron({ minute: "0", hour: "0", weekDay: "MON" }),
      targets: [scheduleTarget(weeklyNotificationsFunction, "weekly-notifications")]
    });

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "honor-benefits-pilot",
      description: "Authenticated follow, push and owner-review API for the private pilot.",
      corsPreflight: {
        allowOrigins: [corsAllowedOrigin.valueAsString],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS
        ],
        allowHeaders: ["authorization", "content-type"],
        maxAge: Duration.hours(1)
      }
    });
    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer(
      "CognitoJwtAuthorizer",
      userPool.userPoolProviderUrl,
      { jwtAudience: [userPoolClient.userPoolClientId] }
    );
    const subscriptionsIntegration = new integrations.HttpLambdaIntegration(
      "SubscriptionsIntegration",
      subscriptionsFunction
    );
    const authOtpIntegration = new integrations.HttpLambdaIntegration(
      "AuthOtpIntegration",
      authOtpFunction
    );
    const pushIntegration = new integrations.HttpLambdaIntegration(
      "PushSubscriptionsIntegration",
      pushSubscriptionsFunction
    );
    const adminIntegration = new integrations.HttpLambdaIntegration(
      "AdminReviewsIntegration",
      adminReviewsFunction
    );
    const publishIntegration = new integrations.HttpLambdaIntegration(
      "PublishIntegration",
      publishFunction
    );
    const authOtpStartRoutes = httpApi.addRoutes({
      path: "/v1/auth/otp/start",
      methods: [apigwv2.HttpMethod.POST],
      integration: authOtpIntegration
    });
    const authOtpVerifyRoutes = httpApi.addRoutes({
      path: "/v1/auth/otp/verify",
      methods: [apigwv2.HttpMethod.POST],
      integration: authOtpIntegration
    });
    httpApi.addRoutes({
      path: "/v1/me/subscriptions",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
      integration: subscriptionsIntegration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/v1/me/subscriptions/{subscriptionId}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: subscriptionsIntegration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/v1/me/push-subscriptions",
      methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.DELETE],
      integration: pushIntegration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/v1/me/account",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: pushIntegration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/v1/admin/reviews",
      methods: [apigwv2.HttpMethod.GET],
      integration: adminIntegration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/v1/admin/reviews/{reviewId}",
      methods: [apigwv2.HttpMethod.POST],
      integration: adminIntegration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/v1/admin/review-batches",
      methods: [apigwv2.HttpMethod.GET],
      integration: adminIntegration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/v1/admin/review-batches/{batchId}",
      methods: [apigwv2.HttpMethod.GET],
      integration: adminIntegration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/v1/admin/review-batches/{batchId}/approve",
      methods: [apigwv2.HttpMethod.POST],
      integration: adminIntegration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/v1/admin/publish",
      methods: [apigwv2.HttpMethod.POST],
      integration: publishIntegration,
      authorizer: jwtAuthorizer
    });

    const apiAccessLogs = new logs.LogGroup(this, "HttpApiAccessLogs", {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY
    });
    const defaultStage = httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage | undefined;
    if (defaultStage === undefined) {
      throw new Error("The HTTP API default stage was not created.");
    }
    for (const route of [...authOtpStartRoutes, ...authOtpVerifyRoutes]) {
      const cfnRoute = route.node.defaultChild as apigwv2.CfnRoute | undefined;
      if (cfnRoute === undefined) {
        throw new Error("An HTTP API OTP route was not created.");
      }
      defaultStage.addDependency(cfnRoute);
    }
    defaultStage.defaultRouteSettings = {
      throttlingBurstLimit: 20,
      throttlingRateLimit: 10
    };
    defaultStage.routeSettings = {
      "POST /v1/auth/otp/start": {
        ThrottlingBurstLimit: 2,
        ThrottlingRateLimit: 1
      },
      "POST /v1/auth/otp/verify": {
        ThrottlingBurstLimit: 5,
        ThrottlingRateLimit: 2
      }
    };
    defaultStage.accessLogSettings = {
      destinationArn: apiAccessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: "$context.requestId",
        routeKey: "$context.routeKey",
        status: "$context.status",
        responseLength: "$context.responseLength",
        integrationError: "$context.integrationErrorMessage"
      })
    };

    const createBudget = (logicalId: string, budgetName: string, usdAmount: number): void => {
      new budgets.CfnBudget(this, logicalId, {
        budget: {
          budgetName,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: usdAmount, unit: "USD" },
          costFilters: {
            TagKeyValue: ["user:Environment$pilot"]
          }
        },
        notificationsWithSubscribers: [
          {
            notification: {
              comparisonOperator: "GREATER_THAN",
              notificationType: "ACTUAL",
              threshold: 100,
              thresholdType: "PERCENTAGE"
            },
            subscribers: [
              {
                address: alertEmail.valueAsString,
                subscriptionType: "EMAIL"
              }
            ]
          }
        ]
      });
    };
    // Fixed pilot guardrails using 1 USD ~= 1,400 KRW. Update amounts if FX materially changes.
    createBudget("ApproxTenThousandKrwBudget", "honor-pilot-approx-10000-krw", 7);
    createBudget("ApproxThirtyThousandKrwBudget", "honor-pilot-approx-30000-krw", 21);

    new CfnOutput(this, "DataBucketName", { value: dataBucket.bucketName });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "DeadLetterQueueUrl", { value: dlq.queueUrl });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "HttpApiEndpoint", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "AmplifyAppId", { value: amplifyApp.attrAppId });
    new CfnOutput(this, "AmplifyBranchNameOutput", { value: amplifyBranchName.valueAsString });
    new CfnOutput(this, "AmplifyBranchUrl", {
      value: amplifyBranchUrl,
      description: "When the branch is enabled, use this value for CorsAllowedOrigin.",
      condition: amplifyBranchEnabledCondition
    });
    new CfnOutput(this, "PilotUrl", {
      value: `${amplifyBranchUrl}/pilot/${pilotSlug.valueAsString}/`,
      condition: amplifyBranchEnabledCondition
    });
    new CfnOutput(this, "SesConfigurationSetName", {
      value: sesConfigurationSetName
    });
  }
}
