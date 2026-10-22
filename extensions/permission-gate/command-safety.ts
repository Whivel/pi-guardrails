import { checkAction, type Action, type Rule } from "../../src/core";
import { matchDangerousPowerShellCommand } from "../../src/core/commands/powershell";
import type { PowerShellParseResponse } from "../../src/core/commands/powershell-types";
import type { ResolvedConfig } from "../../src/shared/config/types";
import type { CommandInput } from "./command-input";
import { parsePowerShellCommand } from "./powershell-parser";
import { createPermissionGateRule, type PermissionGateMeta } from "./rules";
type PermissionGateConfig = ResolvedConfig["permissionGate"];
type PowerShellParseState = {
  parse?: PowerShellParseResponse;
  parseError?: string;
};

function createPowerShellBuiltinRule({
  parse,
}: PowerShellParseState): Rule<PermissionGateMeta> {
  return {
    key: "permission-gate.dangerous-command",
    async check(action: Action) {
      if (action.kind !== "command" || !parse) return { kind: "pass" };
      const match = matchDangerousPowerShellCommand(parse);
      if (!match) return { kind: "pass" };
      return {
        kind: "match",
        reason: match.description,
        metadata: {
          command: action.command,
          description: match.description,
          pattern: match.pattern,
        },
      };
    },
  };
}

function createPowerShellParseFailureRule({
  parse,
  parseError,
}: PowerShellParseState): Rule<PermissionGateMeta> {
  return {
    key: "permission-gate.dangerous-command",
    async check(action: Action) {
      if (action.kind !== "command") return { kind: "pass" };
      if (parse && parse.parseErrors.length === 0) return { kind: "pass" };
      const detail =
        parseError ??
        parse?.parseErrors[0]?.message ??
        "PowerShell syntax could not be fully analyzed";
      const description = `PowerShell command could not be fully analyzed: ${detail}`;
      return {
        kind: "match",
        reason: description,
        metadata: {
          command: action.command,
          description,
          pattern: "powershell.parser-error",
        },
      };
    },
  };
}

/** Selects a dialect-specific analyzer; Bash text never reaches the PowerShell parser. */
export async function checkCommandSafety(
  toolInput: CommandInput,
  action: Action,
  config: PermissionGateConfig,
) {
  if (toolInput.toolName === "bash") {
    return checkBashCommandSafety(action, config);
  }
  return checkPowerShellCommandSafety(toolInput.command, action, config);
}

async function checkBashCommandSafety(
  action: Action,
  config: PermissionGateConfig,
) {
  return checkAction(action, [
    createPermissionGateRule({
      patterns: config.patterns,
      useBuiltinMatchers: config.useBuiltinMatchers,
      caseInsensitive: config.caseInsensitive,
    }),
  ]);
}

async function checkPowerShellCommandSafety(
  command: string,
  action: Action,
  config: PermissionGateConfig,
) {
  let parse: Awaited<ReturnType<typeof parsePowerShellCommand>> | undefined;
  let parseError: string | undefined;
  if (config.useBuiltinMatchers) {
    try {
      parse = await parsePowerShellCommand(command);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }

  const rules: Rule<PermissionGateMeta>[] = [];
  if (config.useBuiltinMatchers) {
    rules.push(createPowerShellBuiltinRule({ parse }));
  }
  rules.push(
    createPermissionGateRule({
      patterns: config.patterns,
      useBuiltinMatchers: false,
      caseInsensitive: config.caseInsensitive,
    }),
  );
  if (config.useBuiltinMatchers) {
    rules.push(createPowerShellParseFailureRule({ parse, parseError }));
  }

  return checkAction(action, rules);
}
