import { configLoader } from "../../src/shared/config";
import { compileCommandPatterns } from "../../src/shared/matching";

export type CommandDialect = "bash" | "powershell";

// Session grants are process-local and dialect-scoped; persistent config patterns remain shared.
const sessionCommandGrants = new Set<string>();

export function isCommandAllowed(
  command: string,
  dialect: CommandDialect = "bash",
): boolean {
  const config = configLoader.getConfig();
  if (sessionCommandGrants.has(sessionGrantKey(dialect, command))) return true;
  return compileCommandPatterns(
    config.permissionGate.allowedPatterns,
    config.permissionGate.caseInsensitive,
  ).some((pattern) => pattern.test(command));
}

export async function saveCommandSessionGrant(
  command: string,
  dialect: CommandDialect = "bash",
): Promise<void> {
  sessionCommandGrants.add(sessionGrantKey(dialect, command));
}

function sessionGrantKey(dialect: CommandDialect, command: string): string {
  return JSON.stringify([dialect, command]);
}
