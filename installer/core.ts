// Registers this rotator in each coding agent on the machine, finds Context7 servers and skills
// that compete with it, and installs Upstash's Context7 skill. See installer/README.md.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";

export const DEFAULT_URL = "https://context7.tyrannosaurus-magellanic.ts.net/mcp";
export const SERVER_NAME = "context7";
export const SKILL_NAME = "context7-mcp";

export type RunResult = { status: number | null; stdout: string };
export type Env = {
  home: string;
  /** Runs an agent CLI. The argv never holds a secret; output is parsed, never printed. */
  run: (command: string, args: string[]) => RunResult;
  /** True when the command is on PATH. */
  has: (command: string) => boolean;
  backupRoot: string;
};

export function realEnv(home: string): Env {
  const win = process.platform === "win32";
  const run = (command: string, args: string[]): RunResult => {
    // Agent CLIs are .cmd shims on Windows, which only a shell can start. No argument has spaces.
    const result = spawnSync(command, args, { encoding: "utf8", shell: win, timeout: 60_000 });
    return { status: result.status, stdout: result.stdout ?? "" };
  };
  const has = (command: string) => run(win ? "where" : "which", [command]).status === 0;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return { home, run, has, backupRoot: join(home, ".context7-rotator", "backups", stamp) };
}

/** One finding. `fix` is set when apply can change it; without it the line is a note. */
export type Item = { scope: string; status: "ok" | "change" | "note"; message: string; fix?: () => void };

type Server = { name: string; config: Record<string, unknown> };

const urlOf = (config: Record<string, unknown>) =>
  [config.url, config.serverUrl, config.httpUrl, config.uri].find((value): value is string => typeof value === "string");

/** The host of a server's URL, or its command: the only parts ever printed about another server. */
function describe(config: Record<string, unknown>): string {
  const url = urlOf(config);
  if (url) {
    try {
      return new URL(url).host;
    } catch {
      return "(unparsable URL)";
    }
  }
  return typeof config.command === "string" ? `command ${config.command}` : "(no URL)";
}

/** A server that is Context7 by name, URL, command or args. */
export function isContext7(server: Server): boolean {
  if (/context7|ctx7/i.test(server.name)) return true;
  const url = urlOf(server.config) ?? "";
  const argv = [server.config.command, ...(Array.isArray(server.config.args) ? server.config.args : [])].join(" ");
  return /context7/i.test(url) || /@upstash\/context7-mcp|\bctx7\b/.test(argv);
}

export const isOurs = (server: Server, url: string) => server.name === SERVER_NAME && urlOf(server.config) === url;

function backup(env: Env, path: string): void {
  if (!existsSync(path)) return;
  const target = join(env.backupRoot, relative(env.home, path));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(path, target, { recursive: true });
}

function readJsonc(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const parsed: unknown = parseJsonc(readFileSync(path, "utf8"));
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
}

/** Sets or removes one key in a JSON(C) file, leaving every other byte as it was. */
export function editJsonc(path: string, keyPath: string[], value: unknown): void {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "{}\n";
  const edits = modify(text, keyPath, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, applyEdits(text, edits));
}

const serversIn = (value: unknown): Server[] =>
  value && typeof value === "object"
    ? Object.entries(value as Record<string, unknown>).map(([name, config]) => ({ name, config: (config ?? {}) as Record<string, unknown> }))
    : [];

/**
 * How one agent's MCP entries are read and changed. Claude, Codex and Devin are changed through
 * their own CLI: Claude rewrites ~/.claude.json while it runs, and add-mcp would re-serialize
 * Codex's TOML and drop its comments. omp has no CLI and add-mcp does not know it.
 */
export type Agent = {
  name: string;
  configPath: string;
  servers: () => Server[];
  add: (url: string) => void;
  remove: (name: string) => void;
};

/** add-mcp agent names this installer manages, from add-mcp's own list. */
export const ADD_MCP_AGENTS = [
  "antigravity",
  "cursor",
  "gemini-cli",
  "github-copilot-cli",
  "kilo-code",
  "opencode",
  "vscode",
  "kimi-code",
  "goose",
] as const;

type AddMcp = typeof import("add-mcp");

function cliAgent(env: Env, name: string, configPath: string, servers: () => Server[], add: string[], remove: (server: string) => string[]): Agent {
  const command = add[0];
  const checked = (args: string[]) => {
    const result = env.run(command, args);
    if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(" ")} failed (exit ${result.status})`);
  };
  return {
    name,
    configPath,
    servers,
    add: (url) => checked([...add.slice(1), url]),
    remove: (server) => checked(remove(server)),
  };
}

export async function findAgents(env: Env, addMcp: AddMcp): Promise<Agent[]> {
  const found: Agent[] = [];
  const listed = await addMcp.listInstalledServers({ global: true, agents: ["claude-code", "codex", ...ADD_MCP_AGENTS] });
  const serversOf = (agentType: string) => () =>
    (listed.find((entry) => entry.agentType === agentType)?.servers ?? []).map((server) => ({ name: server.serverName, config: server.config }));
  const pathOf = (agentType: string) => listed.find((entry) => entry.agentType === agentType)?.configPath ?? "";

  if (env.has("claude")) {
    found.push(cliAgent(env, "claude-code", pathOf("claude-code"), serversOf("claude-code"),
      ["claude", "mcp", "add", "--transport", "http", "-s", "user", SERVER_NAME],
      (server) => ["mcp", "remove", server, "-s", "user"]));
  }
  if (env.has("codex")) {
    found.push(cliAgent(env, "codex", pathOf("codex"), serversOf("codex"),
      ["codex", "mcp", "add", SERVER_NAME, "--url"],
      (server) => ["mcp", "remove", server]));
  }
  if (env.has("devin")) {
    // `devin mcp list` also shows the Claude, Cursor and project servers Devin loads; only its own
    // user file (~/.config/devin, or %APPDATA%\devin on Windows) is Devin's to change.
    const configPath = process.platform === "win32"
      ? join(process.env.APPDATA ?? join(env.home, "AppData", "Roaming"), "devin", "mcp_config.json")
      : join(env.home, ".config", "devin", "mcp_config.json");
    const servers = () => {
      const result = env.run("devin", ["mcp", "list", "--json"]);
      if (result.status !== 0) throw new Error(`devin mcp list failed (exit ${result.status})`);
      const entries = JSON.parse(result.stdout) as Array<{ name: string; source: string; url?: string; command?: string; args?: string[] }>;
      return entries
        .filter((entry) => /(^|[\\/])devin[\\/]mcp_config\.json$/.test(entry.source))
        .map(({ name, url, command, args }) => ({ name, config: { url, command, args } }));
    };
    found.push(cliAgent(env, "devin", configPath, servers,
      ["devin", "mcp", "add", SERVER_NAME, "-s", "user", "--url"],
      (server) => ["mcp", "remove", server, "-s", "user"]));
  }
  const ompPath = join(env.home, ".omp", "agent", "mcp.json");
  if (existsSync(join(env.home, ".omp")) || env.has("omp")) {
    found.push({
      name: "omp",
      configPath: ompPath,
      servers: () => serversIn(readJsonc(ompPath)?.mcpServers),
      add: (url) => editJsonc(ompPath, ["mcpServers", SERVER_NAME], { type: "http", url, enabled: true }),
      remove: (server) => editJsonc(ompPath, ["mcpServers", server], undefined),
    });
  }
  const detected = new Set(await addMcp.detectGlobalAgents());
  for (const agentType of ADD_MCP_AGENTS) {
    if (!detected.has(agentType)) continue;
    found.push({
      name: agentType,
      configPath: pathOf(agentType),
      servers: serversOf(agentType),
      add: (url) => {
        const result = addMcp.upsertServer(agentType, SERVER_NAME, { type: "http", url });
        if (!result.success) throw new Error(result.error ?? "add-mcp could not write the entry");
      },
      remove: (server) => {
        const result = addMcp.removeServer(agentType, server);
        if (!result.success) throw new Error(result.error ?? "add-mcp could not remove the entry");
      },
    });
  }
  return found;
}

/** Our entry, and every other Context7 entry, in one agent. */
export function checkAgent(env: Env, agent: Agent, url: string): Item[] {
  let servers: Server[];
  try {
    servers = agent.servers();
  } catch (error) {
    return [{ scope: agent.name, status: "note", message: `could not read its MCP config: ${(error as Error).message}` }];
  }
  const items: Item[] = [];
  const withBackup = (change: () => void) => () => {
    backup(env, agent.configPath);
    change();
  };
  const ours = servers.find((server) => isOurs(server, url));
  const sameName = servers.find((server) => server.name === SERVER_NAME);
  if (ours) {
    items.push({ scope: agent.name, status: "ok", message: `${SERVER_NAME} points at the rotator` });
  } else {
    const replacing = sameName ? ` (replaces ${SERVER_NAME} → ${describe(sameName.config)})` : "";
    items.push({
      scope: agent.name,
      status: "change",
      message: `add ${SERVER_NAME} → rotator${replacing}`,
      fix: withBackup(() => {
        if (sameName) agent.remove(SERVER_NAME);
        agent.add(url);
      }),
    });
  }
  for (const server of servers) {
    if (server.name === SERVER_NAME) continue;
    if (isContext7(server) || urlOf(server.config) === url) {
      items.push({
        scope: agent.name,
        status: "change",
        message: `remove competing server ${server.name} → ${describe(server.config)}`,
        fix: withBackup(() => agent.remove(server.name)),
      });
    } else if (/llm\.moosegoose\.xyz/.test(urlOf(server.config) ?? "")) {
      items.push({ scope: agent.name, status: "note", message: `${server.name} is the LiteLLM router, which also lists Context7 tools; the tools may appear twice` });
    }
  }
  return items;
}

/** The text of a TOML table name part, quoted unless it is a bare key. */
const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));

/** `enabled` of each `[table]` in a TOML file, from a line scan (enough for Codex's flat tables). */
function tomlEnabled(text: string): Map<string, boolean> {
  const tables = new Map<string, boolean>();
  let current: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) {
      current = header[1].trim();
      continue;
    }
    const enabled = /^\s*enabled\s*=\s*(true|false)\b/.exec(line);
    if (current && enabled) tables.set(current, enabled[1] === "true");
  }
  return tables;
}

/** Sets `enabled = false` in `[table]`, adding the table at the end if it is missing. */
export function disableTomlTable(text: string, table: string): string {
  const lines = text.split(/\n/);
  const start = lines.findIndex((line) => line.replace(/\r$/, "").trim() === `[${table}]`);
  if (start === -1) return `${text.replace(/\n*$/, "\n")}[${table}]\nenabled = false\n`;
  for (let index = start + 1; index < lines.length && !/^\s*\[/.test(lines[index]); index++) {
    if (/^\s*enabled\s*=/.test(lines[index])) {
      lines[index] = lines[index].replace(/enabled\s*=\s*(true|false)/, "enabled = false");
      return lines.join("\n");
    }
  }
  lines.splice(start + 1, 0, "enabled = false");
  return lines.join("\n");
}

function newestDir(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readdirSync(path)
    .map((name) => join(path, name))
    .filter((entry) => statSync(entry).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/** Codex plugins that bundle their own Context7 server, which the plugin entry keeps on. */
export function checkCodexPlugins(env: Env): Item[] {
  const configPath = join(env.home, ".codex", "config.toml");
  if (!existsSync(configPath)) return [];
  const enabled = tomlEnabled(readFileSync(configPath, "utf8"));
  const items: Item[] = [];
  for (const [table, on] of enabled) {
    const plugin = /^plugins\."([^"]+)@([^"]+)"$/.exec(table);
    if (!plugin || !on) continue;
    const [, name, marketplace] = plugin;
    const version = newestDir(join(env.home, ".codex", "plugins", "cache", marketplace, name));
    const servers = version ? serversIn(readJsonc(join(version, ".mcp.json"))?.mcpServers) : [];
    for (const server of servers.filter(isContext7)) {
      const override = `plugins."${name}@${marketplace}".mcp_servers.${tomlKey(server.name)}`;
      if (enabled.get(override) === false) continue;
      items.push({
        scope: "codex",
        status: "change",
        message: `turn off ${server.name} → ${describe(server.config)} bundled by plugin ${name}@${marketplace}`,
        fix: () => {
          backup(env, configPath);
          writeFileSync(configPath, disableTomlTable(readFileSync(configPath, "utf8"), override));
        },
      });
    }
  }
  return items;
}

/** Claude Code plugins that bring a Context7 server: disabled if that is all they bring. */
export function checkClaudePlugins(env: Env): Item[] {
  const installed = readJsonc(join(env.home, ".claude", "plugins", "installed_plugins.json"));
  const enabled = (readJsonc(join(env.home, ".claude", "settings.json"))?.enabledPlugins ?? {}) as Record<string, unknown>;
  const plugins = (installed?.plugins ?? {}) as Record<string, unknown>;
  const items: Item[] = [];
  for (const [id, entries] of Object.entries(plugins)) {
    if (enabled[id] !== true) continue;
    const entry = (Array.isArray(entries) ? entries[0] : entries) as { installPath?: string } | undefined;
    if (!entry?.installPath) continue;
    const mcp = readJsonc(join(entry.installPath, ".mcp.json"));
    const servers = serversIn(mcp?.mcpServers ?? mcp);
    const context7 = servers.filter(isContext7);
    if (!context7.length) continue;
    if (context7.length === servers.length) {
      items.push({
        scope: "claude-code",
        status: "change",
        message: `disable plugin ${id}, which only brings ${context7.map((server) => `${server.name} → ${describe(server.config)}`).join(", ")}`,
        fix: () => {
          const result = env.run("claude", ["plugin", "disable", id, "-s", "user"]);
          if (result.status !== 0) throw new Error(`claude plugin disable failed (exit ${result.status})`);
        },
      });
    } else {
      items.push({ scope: "claude-code", status: "note", message: `plugin ${id} brings ${context7.map((server) => server.name).join(", ")} with other servers; disable that server in the plugin yourself` });
    }
  }
  return items;
}

/**
 * Each agent's global skills folder, from vercel-labs/skills v1.9.0, except Devin, which also reads
 * ~/.agents/skills (`devin skills paths`). omp is a pi fork and pi
 * reads ~/.agents/skills (inferred: omp's own docs do not say).
 */
export const SKILL_DIRS: Record<string, string> = {
  "claude-code": ".claude/skills",
  codex: ".agents/skills",
  omp: ".agents/skills",
  antigravity: ".gemini/config/skills",
  cursor: ".cursor/skills",
  devin: ".agents/skills",
  "gemini-cli": ".gemini/skills",
  "github-copilot-cli": ".copilot/skills",
  "kilo-code": ".kilo/skills",
  opencode: ".config/opencode/skills",
};

const frontmatter = (text: string) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";

/** Our skill in each present agent's folder, and other Context7 skills moved out of the way. */
export function checkSkills(env: Env, agentNames: string[], skill: string): Item[] {
  const dirs = [...new Set(agentNames.map((name) => SKILL_DIRS[name]).filter(Boolean))].map((dir) => join(env.home, dir));
  const items: Item[] = [];
  for (const dir of dirs) {
    const label = relative(env.home, dir).replace(/\\/g, "/");
    const ours = join(dir, SKILL_NAME, "SKILL.md");
    const current = existsSync(ours) ? readFileSync(ours, "utf8") : undefined;
    const others = existsSync(dir)
      ? readdirSync(dir).filter((name) => {
          if (name === SKILL_NAME) return false;
          const file = join(dir, name, "SKILL.md");
          return /context7|find-docs|ctx7/i.test(name) || (existsSync(file) && /context7/i.test(frontmatter(readFileSync(file, "utf8"))));
        })
      : [];
    for (const name of others) {
      items.push({
        scope: `skills ~/${label}`,
        status: "change",
        message: `move competing skill ${name} to the backup`,
        fix: () => {
          const from = join(dir, name);
          const to = join(env.backupRoot, relative(env.home, from));
          mkdirSync(dirname(to), { recursive: true });
          renameSync(from, to);
        },
      });
    }
    if (current === skill) {
      items.push({ scope: `skills ~/${label}`, status: "ok", message: `${SKILL_NAME} is Upstash's current skill` });
    } else {
      items.push({
        scope: `skills ~/${label}`,
        status: "change",
        message: current === undefined ? `install ${SKILL_NAME}` : `replace ${SKILL_NAME} with Upstash's current skill`,
        fix: () => {
          backup(env, join(dir, SKILL_NAME));
          mkdirSync(dirname(ours), { recursive: true });
          writeFileSync(ours, skill);
        },
      });
    }
  }
  return items;
}

/** ctx7's rule section marker (upstash/context7 packages/cli/src/setup/agents.ts). */
const CTX7_RULE_MARKER = "<!-- context7 -->";

/** Rules that `ctx7 setup` appended to agent instruction files: reported, never edited. */
export function checkRules(env: Env): Item[] {
  const files = [".codex/AGENTS.md", ".claude/CLAUDE.md", ".gemini/GEMINI.md", ".config/kilo/AGENTS.md", ".config/opencode/AGENTS.md"];
  return files
    .filter((file) => existsSync(join(env.home, file)) && readFileSync(join(env.home, file), "utf8").includes(CTX7_RULE_MARKER))
    .map((file) => ({ scope: "rules", status: "note" as const, message: `~/${file} has a ctx7 Context7 section; remove it if this skill replaces it` }));
}

export async function plan(env: Env, addMcp: AddMcp, url: string, skill: string): Promise<Item[]> {
  const agents = await findAgents(env, addMcp);
  return [
    ...agents.flatMap((agent) => checkAgent(env, agent, url)),
    ...(agents.some((agent) => agent.name === "codex") ? checkCodexPlugins(env) : []),
    ...(agents.some((agent) => agent.name === "claude-code") ? checkClaudePlugins(env) : []),
    ...checkSkills(env, agents.map((agent) => agent.name), skill),
    ...checkRules(env),
  ];
}
