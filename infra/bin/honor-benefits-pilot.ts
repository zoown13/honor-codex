#!/usr/bin/env node
import "source-map-support/register";
import { App } from "aws-cdk-lib";
import { HonorBenefitsPilotStack } from "../lib/honor-benefits-pilot-stack";

const app = new App();
const region = process.env.CDK_DEFAULT_REGION ?? "ap-northeast-2";
const deploymentEnv = process.env.CDK_DEFAULT_ACCOUNT
  ? { account: process.env.CDK_DEFAULT_ACCOUNT, region }
  : { region };

new HonorBenefitsPilotStack(app, "HonorBenefitsPilotStack", {
  env: deploymentEnv,
  description: "병역명문가 혜택찾기 10명 미만 비공개 파일럿"
});
