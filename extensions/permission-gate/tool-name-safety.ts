import type { PatternConfig, ResolvedConfig } from "../../src/shared/config";
import { compileCommandPatterns } from "../../src/shared/matching";

type ToolsGateConfig = ResolvedConfig["toolsGate"];

export type ToolNameGateDecision =
  | { kind: "allow" }
  | { kind: "pass" }
  | { kind: "auto-deny"; pattern: PatternConfig }
  | { kind: "confirm"; pattern: PatternConfig };

/** Matches configured tool-name patterns before command-tool routing occurs. */
export function checkToolNameSafety(
  toolName: string,
  config: ToolsGateConfig,
): ToolNameGateDecision {
  const caseInsensitive = config.caseInsensitive;
  if (
    matchesToolNamePattern(toolName, config.allowedPatterns, caseInsensitive)
  ) {
    return { kind: "allow" };
  }

  const autoDeny = findToolNamePattern(
    toolName,
    config.autoDenyPatterns,
    caseInsensitive,
  );
  if (autoDeny) return { kind: "auto-deny", pattern: autoDeny };

  const match = findToolNamePattern(toolName, config.patterns, caseInsensitive);
  return match ? { kind: "confirm", pattern: match } : { kind: "pass" };
}

export function matchesToolNamePattern(
  toolName: string,
  patterns: PatternConfig[],
  caseInsensitive = false,
): boolean {
  return findToolNamePattern(toolName, patterns, caseInsensitive) !== null;
}

function findToolNamePattern(
  toolName: string,
  patterns: PatternConfig[],
  caseInsensitive: boolean,
): PatternConfig | null {
  const compiled = compileCommandPatterns(patterns, caseInsensitive);
  for (const pattern of compiled) {
    if (pattern.test(toolName)) return pattern.source;
  }
  return null;
}
