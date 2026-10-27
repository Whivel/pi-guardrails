import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configLoader } from "../../src/shared/config";
import {
  createFeatureRegisterPayload,
  createPromptClosedPayload,
  createPromptOpenedPayload,
  emitActionBlocked,
  emitRiskDetected,
  GUARDRAILS_FEATURE_REGISTER_EVENT,
  GUARDRAILS_FEATURE_REQUEST_EVENT,
  GUARDRAILS_PROMPT_CLOSED_EVENT,
  GUARDRAILS_PROMPT_OPENED_EVENT,
  setupLegacyPromptEventAlias,
} from "../../src/shared/events";
import { getPermissionGateToolInput } from "./command-input";
import { checkCommandSafety } from "./command-safety";
import { isCommandAllowed, saveCommandSessionGrant } from "./grants";
import { createPermissionGateConfirmComponent } from "./prompt";
import { formatAutoDenyReason, matchCommandPattern } from "./rules";
import { checkToolNameSafety } from "./tool-name-safety";

export default async function permissionGate(pi: ExtensionAPI) {
  await configLoader.load();

  pi.events.on(GUARDRAILS_FEATURE_REQUEST_EVENT, () => {
    pi.events.emit(
      GUARDRAILS_FEATURE_REGISTER_EVENT,
      createFeatureRegisterPayload("permissionGate"),
    );
    pi.events.emit(
      GUARDRAILS_FEATURE_REGISTER_EVENT,
      createFeatureRegisterPayload("toolsGate"),
    );
  });
  setupLegacyPromptEventAlias(pi, "permissionGate");
  setupLegacyPromptEventAlias(pi, "toolsGate");

  pi.on("tool_call", async (event, ctx) => {
    const config = configLoader.getConfig();
    if (!config.enabled) return;

    if (config.features.toolsGate) {
      const toolName = event.toolName;
      const decision = checkToolNameSafety(toolName, config.toolsGate);
      if (decision.kind === "auto-deny") {
        const description = decision.pattern.description?.trim();
        const reason = description
          ? `Tool name auto-denied: ${description}`
          : "Tool name matched an auto-deny pattern.";
        const action = {
          kind: "command" as const,
          command: toolName,
          origin: toolName,
        };
        emitActionBlocked(pi, {
          feature: "toolsGate",
          action,
          reason,
          block: { source: "permission", metadata: decision.pattern },
          context: { toolName, input: event.input },
        });
        return { block: true, reason };
      }

      if (decision.kind === "confirm") {
        const description = decision.pattern.description?.trim();
        const reason =
          description || `matched pattern "${decision.pattern.pattern}"`;
        const action = {
          kind: "command" as const,
          command: toolName,
          origin: toolName,
        };
        emitRiskDetected(pi, {
          feature: "toolsGate",
          risk: {
            kind: "dangerous",
            action,
            key: "tools-gate.tool-name",
            reason: `Tool name ${reason}`,
            metadata: { toolName, ...decision.pattern },
          },
          context: { toolName, input: event.input },
        });

        if (!config.toolsGate.requireConfirmation) {
          ctx.ui.notify(`Tool call matched rule: ${reason}`, "warning");
        } else {
          if (!ctx.hasUI) {
            const blockReason = `Tool call blocked (no UI to confirm): ${reason}`;
            emitActionBlocked(pi, {
              feature: "toolsGate",
              action,
              reason: blockReason,
              block: { source: "nonInteractive", metadata: decision.pattern },
              context: { toolName, input: event.input },
            });
            return { block: true, reason: blockReason };
          }

          const promptOpened = createPromptOpenedPayload({
            feature: "toolsGate",
            action,
            reason: `Tool name ${reason}`,
            prompt: { kind: "permission", metadata: decision.pattern },
            context: { toolName, input: event.input },
          });
          pi.events.emit(GUARDRAILS_PROMPT_OPENED_EVENT, promptOpened);
          let selection: string | undefined;
          try {
            selection = await ctx.ui.select(
              `Tool call: ${toolName}\nMatched rule: ${reason}\n\nAllow this tool call?`,
              ["Allow once", "Deny", "Decline and stop"],
            );
          } finally {
            pi.events.emit(
              GUARDRAILS_PROMPT_CLOSED_EVENT,
              createPromptClosedPayload(promptOpened),
            );
          }

          if (selection !== "Allow once") {
            const stopped = selection === "Decline and stop";
            const blockReason = stopped
              ? "User declined and stopped tool call"
              : "User denied tool call";
            emitActionBlocked(pi, {
              feature: "toolsGate",
              action,
              reason: blockReason,
              block: {
                source: stopped ? "user-stop" : "user",
                metadata: decision.pattern,
              },
              context: { toolName, input: event.input },
            });
            if (stopped) ctx.abort();
            return { block: true, reason: blockReason };
          }
          // Accepted Bash and PowerShell calls still undergo command checks.
        }
      }
    }

    if (!config.features.permissionGate) return;
    const toolInput = getPermissionGateToolInput(event);
    if (!toolInput) return;
    if (toolInput.kind === "invalid") {
      return { block: true, reason: toolInput.reason };
    }

    const { toolName, command, input } = toolInput;
    const action = { kind: "command" as const, command, origin: toolName };
    if (isCommandAllowed(command, toolName)) return;

    const autoDenyMatch = matchCommandPattern(
      command,
      config.permissionGate.autoDenyPatterns,
      config.permissionGate.caseInsensitive,
    );

    if (autoDenyMatch) {
      const reason = formatAutoDenyReason(autoDenyMatch);

      emitActionBlocked(pi, {
        feature: "permissionGate",
        action,
        reason,
        block: { source: "permission", metadata: autoDenyMatch },
        context: { toolName, input },
      });

      return { block: true, reason };
    }

    const safety = await checkCommandSafety(
      toolInput,
      action,
      config.permissionGate,
    );
    if (safety.kind === "safe") return;

    emitRiskDetected(pi, {
      feature: "permissionGate",
      risk: safety,
      context: { toolName, input },
    });

    if (!config.permissionGate.requireConfirmation) {
      ctx.ui.notify(`Dangerous command detected: ${safety.reason}`, "warning");
      return;
    }

    if (!ctx.hasUI) {
      const reason = `Dangerous command blocked (no UI to confirm): ${safety.reason}`;
      emitActionBlocked(pi, {
        feature: "permissionGate",
        action: safety.action,
        reason,
        block: { source: "nonInteractive", metadata: safety.metadata },
        context: { toolName, input },
      });
      return { block: true, reason };
    }

    type ConfirmResult = "allow" | "allow-session" | "deny" | "stop";
    const promptOpened = createPromptOpenedPayload({
      feature: "permissionGate",
      action: safety.action,
      reason: safety.reason,
      prompt: {
        kind: "permission",
        metadata: safety.metadata,
      },
      context: { toolName, input },
    });
    pi.events.emit(GUARDRAILS_PROMPT_OPENED_EVENT, promptOpened);

    let result: ConfirmResult;
    try {
      const customResult = await ctx.ui.custom<ConfirmResult>(
        createPermissionGateConfirmComponent(command, safety.reason),
      );

      if (customResult === undefined) {
        const indentedCommand = command.replace(/^/gm, "    ");
        const selection = await ctx.ui.select(
          `Dangerous command: ${safety.reason}\n\n${indentedCommand}`,
          ["Allow once", "Allow for session", "Deny", "Decline and stop"],
        );
        if (selection === "Allow once") result = "allow";
        else if (selection === "Allow for session") result = "allow-session";
        else if (selection === "Decline and stop") result = "stop";
        else result = "deny";
      } else {
        result = customResult;
      }
    } finally {
      pi.events.emit(
        GUARDRAILS_PROMPT_CLOSED_EVENT,
        createPromptClosedPayload(promptOpened),
      );
    }

    if (result === "allow") return;
    if (result === "allow-session") {
      await saveCommandSessionGrant(command, toolName);
      return;
    }

    if (result === "stop") {
      const reason = "User declined and stopped dangerous command";
      emitActionBlocked(pi, {
        feature: "permissionGate",
        action: safety.action,
        reason,
        block: { source: "user-stop", metadata: safety.metadata },
        context: { toolName, input },
      });
      ctx.abort();
      return { block: true, reason };
    }

    const reason = "User denied dangerous command";
    emitActionBlocked(pi, {
      feature: "permissionGate",
      action: safety.action,
      reason,
      block: { source: "user", metadata: safety.metadata },
      context: { toolName, input },
    });
    return { block: true, reason };
  });
}
