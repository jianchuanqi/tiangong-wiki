const { readFileSync } = require("node:fs");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const ref = process.env.GITHUB_REF || "";
const tag = ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : "";
const expected = `v${pkg.version}`;

if (!tag) {
  console.error(`GITHUB_REF must be a tag ref, got ${JSON.stringify(ref)}.`);
  process.exit(1);
}

if (tag !== expected) {
  console.error(`Release tag ${tag} does not match package.json version ${expected}.`);
  process.exit(1);
}

console.log(`Release tag ${tag} matches package version ${pkg.version}.`);
