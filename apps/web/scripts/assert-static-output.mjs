import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(webRoot, "out");
const pilotSlug = process.env.NEXT_PUBLIC_PILOT_SLUG?.trim() || "honor-family-pilot-demo";

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const requiredFiles = [
  path.join(outDir, "404.html"),
  path.join(outDir, "pilot", pilotSlug, "index.html")
];
const missingFiles = [];
for (const filePath of requiredFiles) {
  if (!(await exists(filePath))) missingFiles.push(path.relative(webRoot, filePath));
}
if (missingFiles.length > 0) {
  throw new Error("Missing required private pilot artifacts: " + missingFiles.join(", "));
}

const rootIndex = path.join(outDir, "index.html");
if (await exists(rootIndex)) {
  throw new Error("Static export must not contain out/index.html; Amplify would serve the root with HTTP 200.");
}

process.stdout.write("Private pilot static output contract: PASS\n");
