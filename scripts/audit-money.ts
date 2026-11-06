import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `bun run audit:money` — §5: "Nunca usar number/float para dinheiro, nem em DTOs, testes ou logs."
 *
 * Heuristic static audit over src/, test/ and scripts/: a line is flagged when it mentions a money
 * identifier (amount, balance, money, Money, minor…) together with a numeric conversion or float
 * arithmetic (parseFloat, parseInt, Number(), toFixed, Math.*, a `number` type annotation, a numeric
 * literal assigned to amount, ×/÷ 100). Intentional uses (e.g. a test proving that a numeric amount
 * is REJECTED) must carry `audit-money: allow <reason>` on the same or the previous line.
 * Exit code 1 when anything is flagged.
 */
const ROOTS = ["src", "test", "scripts"];
const MONEY = /\b(amount|cents|balance\w*|money|Money|minor\w*|initialBalance|resultingBalance|storedBalance|calculatedBalance|difference)\b/;
const FLOAT_USE = [
  /BigInt\s*\(\s*Math\./, // money built from float arithmetic, even when converted afterwards
  /BigInt\s*\([^)]*[*/]/,
  /parseFloat\s*\(/,
  /parseInt\s*\(/,
  /\bNumber\s*\(/,
  /\.toFixed\s*\(/,
  /\bMath\.\w+\s*\(/,
  /\b(amount|balance\w*|money)\s*[:?]\s*number\b/,
  /\bamount\s*:\s*-?\d+(\.\d+)?\s*[,}]/,
  /(?<!\/)[*/](?!\/)\s*100\b(?!n)/, // ×/÷ 100, but not a `// 100 …` comment
];
const ALLOW = /audit-money:\s*allow\b/;

interface Finding {
  file: string;
  line: number;
  text: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : walk(path);
    return /\.ts$/.test(name) ? [path] : [];
  });
}

const findings: Finding[] = [];
let scanned = 0;
for (const file of ROOTS.flatMap((root) => walk(root))) {
  if (file.endsWith("audit-money.ts")) continue;
  scanned++;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((text, index) => {
    if (!MONEY.test(text)) return;
    if (!FLOAT_USE.some((pattern) => pattern.test(text))) return;
    if (ALLOW.test(text) || ALLOW.test(lines[index - 1] ?? "")) return;
    findings.push({ file: file.replaceAll("\\", "/"), line: index + 1, text: text.trim() });
  });
}

if (findings.length === 0) {
  console.log(`audit-money: OK — ${scanned} files scanned, no float/number handling of money found.`);
  process.exit(0);
}
console.log(`audit-money: ${findings.length} suspicious line(s) in ${scanned} files:\n`);
for (const f of findings) console.log(`  ${f.file}:${f.line}  ${f.text}`);
console.log("\nFix them, or mark intentional ones with `// audit-money: allow <reason>`.");
process.exit(1);
