#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, ".env.deploy.local");
const configRelativePath = ".env.deploy.local";
const cliArgs = process.argv.slice(2);
if (cliArgs[0] === "--") cliArgs.shift();
const [mode, source, extraArgument] = cliArgs;
const supportedModes = new Set(["gate-off", "configure", "gate-on"]);
const scheduleParameters = {
  facilities: "FacilitiesIngestionScheduleEnabled",
  notices: "NoticesIngestionScheduleEnabled",
  ordinances: "OrdinancesIngestionScheduleEnabled"
};

if (extraArgument !== undefined ||
    !supportedModes.has(mode) ||
    (mode === "gate-on" && !(source in scheduleParameters)) ||
    (mode === "configure" && source !== undefined) ||
    (mode === "gate-off" && source !== undefined && !(source in scheduleParameters))) {
  fail("Usage: pnpm deploy:live -- <gate-off [facilities|notices|ordinances]|configure|gate-on <facilities|notices|ordinances>>");
}

assertIgnoredAndUntracked(configRelativePath);

const parameters = [];
if (mode === "configure" || (mode === "gate-off" && source === undefined)) {
  for (const parameter of Object.values(scheduleParameters)) {
    parameters.push(`HonorBenefitsPilotStack:${parameter}=false`);
  }
} else {
  const parameter = scheduleParameters[source];
  parameters.push(`HonorBenefitsPilotStack:${parameter}=${mode === "gate-on" ? "true" : "false"}`);
}

if (mode === "configure") {
  const env = parseEnv(await readFile(configPath, "utf8"));
  const kakaoKey = required(env, "NEXT_PUBLIC_KAKAO_MAP_APP_KEY");
  const lawOc = required(env, "LAW_API_OC");
  if (env.MMA_LIVE_INGESTION_ENABLED?.trim().toLowerCase() !== "true") {
    fail("MMA_LIVE_INGESTION_ENABLED must be true in .env.deploy.local");
  }
  assertSecretsAreNotTracked([kakaoKey, lawOc]);
  parameters.push(
    `HonorBenefitsPilotStack:KakaoJavascriptKey=${kakaoKey}`,
    `HonorBenefitsPilotStack:LawApiOc=${lawOc}`,
    "HonorBenefitsPilotStack:MmaLiveIngestionEnabled=true"
  );
}

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) fail("Run this script through the pnpm deploy:live command.");

const operation = source ? `${mode}:${source}` : mode;
process.stdout.write(`Starting secret-redacted live integration deployment: ${operation}\n`);
const args = [
  npmExecPath,
  "--filter",
  "@honor/infra",
  "exec",
  "cdk",
  "deploy",
  "HonorBenefitsPilotStack",
  "--profile",
  "honor-pilot-deployer",
  "--require-approval",
  "never",
  "--ci",
  "--rollback",
  "--force",
  "--previous-parameters=true"
];
for (const parameter of parameters) args.push("--parameters", parameter);

const result = spawnSync(process.execPath, args, {
  cwd: root,
  env: {
    ...process.env,
    AWS_PROFILE: "honor-pilot-deployer",
    AWS_REGION: "ap-northeast-2",
    AWS_DEFAULT_REGION: "ap-northeast-2"
  },
  stdio: "inherit",
  shell: false
});
if (result.error) fail("Unable to start the deployment process.");
if (result.status !== 0) fail(`Deployment failed with exit code ${result.status ?? "unknown"}.`);
process.stdout.write(`Live integration deployment completed: ${operation}\n`);

function assertIgnoredAndUntracked(relativePath) {
  const ignored = spawnSync("git", ["check-ignore", "-q", "--", relativePath], {
    cwd: root,
    stdio: "ignore",
    shell: false
  });
  if (ignored.status !== 0) fail(relativePath + " must be ignored by Git.");

  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
    cwd: root,
    stdio: "ignore",
    shell: false
  });
  if (tracked.status === 0) fail(relativePath + " must not be tracked by Git.");
}

function assertSecretsAreNotTracked(secrets) {
  const listed = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    shell: false
  });
  if (listed.status !== 0) fail("Unable to inspect tracked files before deployment.");

  const matches = [];
  for (const relativePath of listed.stdout.split("\0").filter(Boolean)) {
    try {
      const filePath = path.join(root, relativePath);
      if (statSync(filePath).size > 10 * 1024 * 1024) continue;
      const body = readFileSync(filePath, "utf8");
      if (secrets.some((secret) => body.includes(secret))) matches.push(relativePath);
    } catch {
      continue;
    }
  }
  if (matches.length > 0) {
    fail("A deployment credential was found in tracked file(s): " + matches.join(", "));
  }
}

function parseEnv(input) {
  const values = {};
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) fail("Invalid .env.deploy.local line.");
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) fail(key + " is required in .env.deploy.local");
  return value;
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}
