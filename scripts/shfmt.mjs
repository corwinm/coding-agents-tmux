import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { format } from "@wasm-fmt/shfmt/node";

const repoRoot = path.resolve(import.meta.dirname, "..");
const defaultFiles = [
  "bin/coding-agents-tmux",
  "bin/opencode-tmux",
  "scripts/sync-tmux-plugin.sh",
  "scripts/tmux-menu-switch.sh",
  "scripts/tmux-popup-switch.sh",
];

function getMode(args) {
  if (args.includes("--check")) {
    return "check";
  }

  return "write";
}

function getTargets(args) {
  const fileArgs = args.filter((arg) => !arg.startsWith("--"));

  if (fileArgs.length === 0) {
    return defaultFiles;
  }

  return [
    ...new Set(
      fileArgs.map((filePath) => path.relative(repoRoot, path.resolve(repoRoot, filePath))),
    ),
  ];
}

async function main() {
  const mode = getMode(process.argv.slice(2));
  const targets = getTargets(process.argv.slice(2));
  const changedFiles = [];

  for (const relativePath of targets) {
    const absolutePath = path.join(repoRoot, relativePath);
    const source = await readFile(absolutePath, "utf8");
    const formatted = format(source, relativePath, { indent: 2 });

    if (formatted === source) {
      continue;
    }

    changedFiles.push(relativePath);

    if (mode === "write") {
      await writeFile(absolutePath, formatted, "utf8");
    }
  }

  if (mode === "check" && changedFiles.length > 0) {
    console.error("Shell format issues found in:");
    for (const relativePath of changedFiles) {
      console.error(`- ${relativePath}`);
    }
    process.exitCode = 1;
    return;
  }

  if (changedFiles.length === 0) {
    console.log(`Shell files already formatted (${targets.length} checked)`);
    return;
  }

  console.log(
    mode === "write"
      ? `Formatted shell files:\n${changedFiles.map((filePath) => `- ${filePath}`).join("\n")}`
      : `Shell format issues found in:\n${changedFiles.map((filePath) => `- ${filePath}`).join("\n")}`,
  );
}

await main();
