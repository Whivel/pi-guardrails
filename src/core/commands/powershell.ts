import type { DangerousCommandMatch } from "./dangerous";
import type {
  PowerShellAstNode,
  PowerShellParseResponse,
} from "./powershell-types";

interface StructuralPowerShellMatcher {
  id: string;
  description: string;
  matches: (commandName: string, parameters: Set<string>) => boolean;
}

const REMOVE_ITEM_ALIASES = new Set([
  "remove-item",
  "ri",
  "rm",
  "del",
  "erase",
  "rd",
  "rmdir",
]);

// Order is policy: destructive file removal, disk data removal, then formatting.
const POWERSHELL_MATCHERS: StructuralPowerShellMatcher[] = [
  {
    id: "powershell.remove-item.recurse-force",
    description: "recursive force delete",
    matches: (name, parameters) =>
      REMOVE_ITEM_ALIASES.has(name.toLowerCase()) &&
      parameters.has("recurse") &&
      parameters.has("force"),
  },
  {
    id: "powershell.clear-disk.remove-data",
    description: "disk data removal",
    matches: (name, parameters) =>
      name.toLowerCase() === "clear-disk" &&
      (parameters.has("removedata") || parameters.has("removeoem")),
  },
  {
    id: "powershell.format-volume",
    description: "volume format",
    matches: (name) => name.toLowerCase() === "format-volume",
  },
];

/**
 * Visit children only. The v1 protocol also mirrors some child nodes at
 * elements[].node; following both routes visits those syntax nodes twice.
 */
export function* walkPowerShellCommands(
  root: PowerShellAstNode,
): Generator<PowerShellAstNode> {
  if (root.kind === "command") yield root;
  for (const child of root.children) yield* walkPowerShellCommands(child);
}

export function matchDangerousPowerShellCommand(
  response: PowerShellParseResponse,
): DangerousCommandMatch | undefined {
  // AST depth-first/source order wins; within one invocation, registry order wins.
  for (const command of walkPowerShellCommands(response.root)) {
    const name = commandNameLiteral(command);
    if (!name) continue;
    const parameters = new Set(
      (command.elements ?? []).flatMap((element) =>
        element.kind === "parameter" && typeof element.name === "string"
          ? [element.name.toLowerCase()]
          : [],
      ),
    );
    for (const matcher of POWERSHELL_MATCHERS) {
      if (matcher.matches(name, parameters)) {
        return { description: matcher.description, pattern: matcher.id };
      }
    }
  }
  return undefined;
}

function commandNameLiteral(command: PowerShellAstNode): string | undefined {
  const name = command.commandName;
  if (!name || name.kind !== "literal" || typeof name.value !== "string")
    return undefined;
  return name.value;
}
