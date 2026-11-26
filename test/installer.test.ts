import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disableTomlTable, editJsonc, type Env, plan } from "../installer/core.js";

const URL = "https://rotator.example/mcp";
const SKILL = "---\nname: context7-mcp\n---\nUpstash's skill\n";
const home = mkdtempSync(join(tmpdir(), "c7-installer-"));
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(home, path)), { recursive: true });
  writeFileSync(join(home, path), text);
};
const read = (path: string) => readFileSync(join(home, path), "utf8");

// A stand-in for the claude CLI that edits ~/.claude.json the way `claude mcp` does.
const commands: string[] = [];
const env: Env = {
  home,
  backupRoot: join(home, "backup"),
  has: (command) => command === "claude" || command === "codex",
  run: (command, args) => {
    commands.push([command, ...args].join(" "));
    const claudeJson = join(home, ".claude.json");
    if (command === "claude" && args[0] === "mcp" && args[1] === "add") editJsonc(claudeJson, ["mcpServers", args.at(-2)!], { type: "http", url: args.at(-1) });
    if (command === "claude" && args[0] === "mcp" && args[1] === "remove") editJsonc(claudeJson, ["mcpServers", args[2]], undefined);
    return { status: 0, stdout: "" };
  },
};

let addMcp: typeof import("add-mcp");

beforeAll(async () => {
  // add-mcp resolves every agent path from these when it loads.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const name of ["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "CODEX_HOME", "COPILOT_HOME", "KIMI_CODE_HOME", "PI_CODING_AGENT_DIR"]) delete process.env[name];

  write(".claude.json", JSON.stringify({ mcpServers: { context7: { type: "http", url: "https://mcp.context7.com/mcp" }, sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" } } }));
  write(".claude/settings.json", JSON.stringify({ enabledPlugins: { "context7@official": true } }));
  write(".claude/plugins/installed_plugins.json", JSON.stringify({ version: 2, plugins: { "context7@official": [{ installPath: join(home, "plugin-cache", "context7") }] } }));
  write("plugin-cache/context7/.mcp.json", JSON.stringify({ context7: { type: "http", url: "https://mcp.context7.com/mcp" } }));
  write(".claude/skills/context7/SKILL.md", "---\nname: context7\ndescription: Context7 docs\n---\n");
  write(".claude/skills/notes/SKILL.md", "---\nname: notes\n---\nMentions context7 only in the body.\n");

  write(".codex/config.toml", `# my comment\n[mcp_servers.context7]\nurl = "${URL}"\n\n[plugins."omo@sisyphuslabs"]\nenabled = true\n`);
  write(".codex/plugins/cache/sisyphuslabs/omo/5.1.75/.mcp.json", JSON.stringify({ mcpServers: { context7: { type: "http", url: "https://mcp.context7.com/mcp" }, lsp: { command: "lsp" } } }));

  write(".cursor/mcp.json", `{\n  // keep me\n  "mcpServers": {\n    "upstash": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },\n    "router": { "url": "https://llm.moosegoose.xyz/mcp" }\n  }\n}\n`);
  write(".omp/agent/mcp.json", JSON.stringify({ mcpServers: { context7: { type: "http", url: URL, enabled: true } } }));

  addMcp = await import("add-mcp");
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("installer", () => {
  it("finds each missing entry and competing server or skill, and leaves the rest alone", async () => {
    const items = await plan(env, addMcp, URL, SKILL);
    const text = items.map((item) => `${item.status} ${item.scope}: ${item.message}`);

    expect(text).toEqual(expect.arrayContaining([
      "change claude-code: add context7 → rotator (replaces context7 → mcp.context7.com)",
      "ok codex: context7 points at the rotator",
      "ok omp: context7 points at the rotator",
      "change cursor: add context7 → rotator",
      "change cursor: remove competing server upstash → command npx",
      "note cursor: router is the LiteLLM router, which also lists Context7 tools; the tools may appear twice",
      "change codex: turn off context7 → mcp.context7.com bundled by plugin omo@sisyphuslabs",
      "change claude-code: disable plugin context7@official, which only brings context7 → mcp.context7.com",
      "change skills ~/.claude/skills: move competing skill context7 to the backup",
      "change skills ~/.claude/skills: install context7-mcp",
      "change skills ~/.agents/skills: install context7-mcp",
      "change skills ~/.cursor/skills: install context7-mcp",
    ]));
    expect(text.join("\n")).not.toMatch(/sentry|notes|lsp/);
  });

  it("applies every change, keeps comments and backups, and then finds nothing left to do", async () => {
    for (const item of await plan(env, addMcp, URL, SKILL)) item.fix?.();

    expect(commands).toEqual(expect.arrayContaining([
      "claude mcp remove context7 -s user",
      `claude mcp add --transport http -s user context7 ${URL}`,
      "claude plugin disable context7@official -s user",
    ]));
    const cursor = read(".cursor/mcp.json");
    expect(cursor).toContain("// keep me");
    expect(cursor).toContain('"router"');
    expect(cursor).not.toContain("upstash");
    expect(cursor).toContain(URL);
    expect(read(".codex/config.toml")).toContain(`# my comment`);
    expect(read(".codex/config.toml")).toContain(`[plugins."omo@sisyphuslabs".mcp_servers.context7]\nenabled = false`);
    expect(read(".claude/skills/context7-mcp/SKILL.md")).toBe(SKILL);
    expect(existsSync(join(home, ".claude/skills/context7"))).toBe(false);
    expect(existsSync(join(env.backupRoot, ".claude/skills/context7/SKILL.md"))).toBe(true);
    expect(existsSync(join(env.backupRoot, ".cursor/mcp.json"))).toBe(true);
    expect(existsSync(join(home, ".claude/skills/notes/SKILL.md"))).toBe(true);

    // The plugin stays enabled in this fake home because the fake CLI does not edit settings.json.
    const left = (await plan(env, addMcp, URL, SKILL)).filter((item) => item.fix && !item.message.startsWith("disable plugin"));
    expect(left.map((item) => item.message)).toEqual([]);
  });
});

describe("disableTomlTable", () => {
  it("turns an enabled table off, adds `enabled` to a table without it, and adds a missing table", () => {
    expect(disableTomlTable('[a]\nenabled = true\nx = 1\n', "a")).toBe('[a]\nenabled = false\nx = 1\n');
    expect(disableTomlTable('[a]\nx = 1\n[b]\n', "a")).toBe('[a]\nenabled = false\nx = 1\n[b]\n');
    expect(disableTomlTable('[a]\nx = 1', 'p."n@m".mcp_servers.c')).toBe('[a]\nx = 1\n[p."n@m".mcp_servers.c]\nenabled = false\n');
  });
});
