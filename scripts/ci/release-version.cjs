const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

const command = process.argv[2];
if (command !== "assert-unpublished") {
  console.error("Usage: node scripts/ci/release-version.cjs assert-unpublished");
  process.exit(2);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const spec = `${pkg.name}@${pkg.version}`;
const result = spawnSync("npm", ["view", spec, "version", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.status === 0) {
  console.error(`${spec} is already published.`);
  process.exit(1);
}

const combined = `${result.stdout}\n${result.stderr}`;
if (combined.includes("E404") || combined.includes("404 Not Found")) {
  console.log(`${spec} is not published yet.`);
  process.exit(0);
}

console.error(`Unable to check npm version availability for ${spec}.`);
if (result.stdout.trim()) {
  console.error(result.stdout.trim());
}
if (result.stderr.trim()) {
  console.error(result.stderr.trim());
}
process.exit(result.status || 1);
