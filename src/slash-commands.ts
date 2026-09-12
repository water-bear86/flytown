/**
 * Slash commands for the CLI (`flytown /ask ...`, `flytown /swarm ...`).
 *
 *   /ask <task>     single mode: one forager, one answer (`flytown ask forager`)
 *   /swarm <task>   swarm mode: planner DAG plus multi-agent flights (`flytown plan`)
 *   /run <task>     the selected default mode
 */
export type SlashMode = "single" | "swarm";

export type SlashCommandKind =
  | "run"
  | "ask"
  | "swarm"
  | "plan"
  | "history"
  | "resume"
  | "provider"
  | "reset"
  | "context"
  | "help";

export interface SlashCommandDefaults {
  mode?: SlashMode;
}

export interface ParsedSlashCommand {
  kind: SlashCommandKind;
  mode: SlashMode;
  task: string;
  args: string[];
}

export interface SlashRunRequest {
  endpoint: "/api/ask" | "/api/plan";
  payload: Record<string, unknown>;
  mode: SlashMode;
}

const DEFAULT_MAX_NODES = 6;
const DEFAULT_MAX_REPLAN = 2;

export function parseSlashCommand(
  line: string,
  defaults: SlashCommandDefaults = {},
): ParsedSlashCommand {
  const trimmed = line.trim();
  const fallbackMode = defaults.mode ?? "single";
  if (!trimmed.startsWith("/")) {
    return {
      kind: "run",
      mode: fallbackMode,
      task: trimmed,
      args: trimmed ? [trimmed] : [],
    };
  }

  const tokens = parseCommandLine(trimmed);
  const commandToken = tokens.shift() ?? "/run";
  const command = normalizeCommandKind(commandToken.slice(1));
  const args = tokens;
  const task = args.join(" ").trim();
  const mode = modeForCommand(command, fallbackMode);

  return {
    kind: command,
    mode,
    task,
    args,
  };
}

export function commandToRunRequest(command: ParsedSlashCommand): SlashRunRequest {
  if (command.mode === "swarm") {
    return {
      endpoint: "/api/plan",
      payload: {
        task: command.task,
        maxNodes: DEFAULT_MAX_NODES,
        maxReplan: DEFAULT_MAX_REPLAN,
        remember: true,
        outputFormat: "markdown",
      },
      mode: "swarm",
    };
  }
  return {
    endpoint: "/api/ask",
    payload: {
      task: command.task,
      remember: true,
      outputFormat: "markdown",
    },
    mode: "single",
  };
}

export function commandToCliArgs(command: ParsedSlashCommand): string[] {
  if (command.mode === "swarm") {
    return ["plan", command.task, "--remember", "--format", "markdown"];
  }
  return ["ask", "forager", "--task", command.task, "--format", "markdown"];
}

export function parseCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (const ch of line) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function normalizeCommandKind(value: string): SlashCommandKind {
  switch (value.toLowerCase()) {
    case "ask":
    case "single":
    case "forager":
      return "ask";
    case "swarm":
    case "flytown":
      return "swarm";
    case "plan":
      return "plan";
    case "history":
    case "runs":
      return "history";
    case "resume":
      return "resume";
    case "provider":
    case "providers":
      return "provider";
    case "reset":
      return "reset";
    case "context":
      return "context";
    case "help":
    case "?":
      return "help";
    case "run":
    default:
      return "run";
  }
}

function modeForCommand(command: SlashCommandKind, fallback: SlashMode): SlashMode {
  switch (command) {
    case "ask":
      return "single";
    case "swarm":
    case "plan":
      return "swarm";
    default:
      return fallback;
  }
}
