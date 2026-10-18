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

const allowedUnpatchedDevAdvisory = "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm";
const exceptions = [];
const blockers = [];

for (const [name, item] of highOrCritical) {
  const hasExactAdvisory = (item.via ?? []).some(
    (entry) => typeof entry === "object" && entry.url === allowedUnpatchedDevAdvisory,
  );
  const isScopedBracesFinding =
    name === "braces" &&
    item.isDirect === false &&
    item.fixAvailable === false &&
    item.severity === "high" &&
    hasExactAdvisory;

  if (isScopedBracesFinding) {
    exceptions.push({ name, severity: item.severity, nodes: item.nodes ?? [] });
  } else {
    blockers.push({ name, severity: item.severity, via: item.via ?? [] });
  }
}

if (exceptions.length) {
  console.warn(
    "TEMPORARY SECURITY EXCEPTION: braces GHSA-vfj7-8cjw-p6xm is unpatched upstream and occurs only in development tooling. Production dependencies are independently audited with npm audit --omit=dev. Keep this finding visible and remove this exception when upstream publishes a fix.",
  );
  console.warn(JSON.stringify(exceptions, null, 2));
}

if (blockers.length) {
  console.error("Blocking high/critical dependency advisories remain:");
  console.error(JSON.stringify(blockers, null, 2));
  process.exit(1);
}

console.log(
  `Dependency audit gate passed: no unexcepted high/critical advisories. ${exceptions.length} narrowly scoped unpatched development-tooling advisory remains documented.`,
);
