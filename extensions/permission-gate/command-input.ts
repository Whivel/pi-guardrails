import {
  isToolCallEventType,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

export type CommandToolName = "bash" | "powershell";

export type CommandInput = {
  kind: "command";
  toolName: CommandToolName;
  command: string;
  input: Record<string, unknown>;
};

export type InvalidPowerShellInput = {
  kind: "invalid";
  toolName: "powershell";
  input: unknown;
  reason: string;
};

export type PermissionGateToolInput = CommandInput | InvalidPowerShellInput;

/** Route only recognized command tools; each tool gets its own input validation. */
export function getPermissionGateToolInput(
  event: ToolCallEvent,
): PermissionGateToolInput | undefined {
  return getBashInput(event) ?? getPowerShellInput(event);
}

function getBashInput(event: ToolCallEvent): CommandInput | undefined {
  if (!isToolCallEventType("bash", event)) return undefined;
  return {
    kind: "command",
    toolName: "bash",
    command: event.input.command,
    input: event.input,
  };
}

function getPowerShellInput(
  event: ToolCallEvent,
): PermissionGateToolInput | undefined {
  if (!isToolCallEventType("powershell", event)) return undefined;
  const input = event.input;
  if (!isRecord(input) || typeof input.command !== "string") {
    return {
      kind: "invalid",
      toolName: "powershell",
      input,
      reason: "Invalid PowerShell tool input: input.command must be a string.",
    };
  }
  return {
    kind: "command",
    toolName: "powershell",
    command: input.command,
    input,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
