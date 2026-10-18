import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/security-audit.mjs <npm-audit-json>");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(file, "utf8"));
} catch {
  console.error("npm audit did not produce valid JSON; refusing to pass the security gate.");
  process.exit(2);
}

const vulnerabilities = report.vulnerabilities ?? {};
const highOrCritical = Object.entries(vulnerabilities).filter(([, item]) =>
  ["high", "critical"].includes(item.severity),
);
const advisoryUrl = "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm";
const allowedAggregateChain = new Map([
  ["micromatch", ["braces"]],
  ["fast-glob", ["micromatch"]],
  ["@next/eslint-plugin-next", ["fast-glob"]],
  ["eslint-config-next", ["@next/eslint-plugin-next"]],
]);
const exceptions = [];
const blockers = [];

for (const [name, item] of highOrCritical) {
  const via = item.via ?? [];
  const exactBracesAdvisory = name === "braces" &&
    item.isDirect === false &&
    item.severity === "high" &&
    via.some((entry) => typeof entry === "object" && entry.url === advisoryUrl);

  const aggregateOnly = allowedAggregateChain.has(name) &&
    via.length > 0 &&
    via.every((entry) => typeof entry === "string" && allowedAggregateChain.get(name).includes(entry));

  if (exactBracesAdvisory || aggregateOnly) {
    exceptions.push({ name, severity: item.severity, via, nodes: item.nodes ?? [] });
  } else {
    blockers.push({ name, severity: item.severity, via });
  }
}

if (exceptions.length) {
  console.warn(
    "TEMPORARY SECURITY EXCEPTION: the unpatched braces GHSA-vfj7-8cjw-p6xm advisory is present in development lint tooling. npm audit reports its transitive aggregate chain through micromatch, fast-glob, @next/eslint-plugin-next, and eslint-config-next. Production dependencies are independently audited with npm audit --omit=dev. This exception is limited to that exact chain; keep the finding visible and remove it when upstream publishes a fix.",
  );
  console.warn(JSON.stringify(exceptions, null, 2));
}

if (blockers.length) {
  console.error("Blocking high/critical dependency advisories remain:");
  console.error(JSON.stringify(blockers, null, 2));
  process.exit(1);
}

console.log(
  `Dependency audit gate passed: no unexcepted high/critical advisories. ${exceptions.length} development-tooling packages remain under the documented upstream braces advisory exception.`,
);
