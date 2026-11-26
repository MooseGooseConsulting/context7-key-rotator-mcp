// Entry point bundled into dist-installer/install.mjs: `node install.mjs [check|apply] [--url URL]`.
import { homedir } from "node:os";
import * as addMcp from "add-mcp";
import skill from "../skills/context7-mcp/SKILL.md";
import { DEFAULT_URL, type Item, plan, realEnv } from "./core.js";

function parseArgs(argv: string[]): { mode: "check" | "apply"; url: string } {
  let mode: "check" | "apply" = "check";
  let url = DEFAULT_URL;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "check" || arg === "apply") mode = arg;
    else if (arg === "--url" && argv[index + 1]) url = argv[++index];
    else {
      console.error(`Usage: node install.mjs [check|apply] [--url ${DEFAULT_URL}]`);
      process.exit(64);
    }
  }
  return { mode, url };
}

const mark = { ok: "ok    ", change: "change", note: "note  " } as const;
const line = (item: Item, prefix: string = mark[item.status]) => console.log(`${prefix}  ${item.scope}: ${item.message}`);

const { mode, url } = parseArgs(process.argv.slice(2));
const env = realEnv(homedir());
const items = await plan(env, addMcp, url, skill);
const changes = items.filter((item) => item.fix);

if (mode === "check") {
  for (const item of items) line(item);
  console.log(changes.length ? `\n${changes.length} change(s) pending. Run: node install.mjs apply` : "\nNothing to change.");
  process.exit(changes.length ? 1 : 0);
}

let failed = 0;
for (const item of items) {
  if (!item.fix) {
    line(item);
    continue;
  }
  try {
    item.fix();
    line(item, "done  ");
  } catch (error) {
    failed++;
    line({ ...item, message: `${item.message} — failed: ${(error as Error).message}` }, "FAILED");
  }
}
if (changes.length) console.log(`\nBackups of changed files: ${env.backupRoot}`);
process.exit(failed ? 2 : 0);
