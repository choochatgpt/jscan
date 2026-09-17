#!/usr/bin/env node
/**
 * Ship a change to Netlify: rebuild dist/, then publish it.
 *
 * The build runs first and in this same command, so there is no way to publish
 * stale code -- the failure mode where you edit js/20-detect.js, forget to
 * re-copy it into dist/, and then conclude the fix did not work. That is the
 * only real hazard of drag-and-drop deploys, and it costs one line to remove.
 *
 * One-time setup, if you have not done it:
 *     npx netlify-cli login
 *
 * Then, for every change, from the project root:
 *     node tools/deploy.mjs
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// shell:true so this works the same from PowerShell, cmd and Git Bash -- on
// Windows npx is a .cmd shim, which spawn cannot execute without a shell.
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: true
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("--- building ---");
run(process.execPath, [resolve(ROOT, "tools", "build.mjs")]);

console.log("\n--- deploying ---");
run("npx", ["netlify-cli", "deploy", "--prod", "--dir=dist"]);
