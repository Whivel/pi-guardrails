import { describe, expect, it } from "vitest";
import {
  matchDangerousPowerShellCommand,
  walkPowerShellCommands,
} from "./powershell";
import type {
  PowerShellAstNode,
  PowerShellParseResponse,
} from "./powershell-types";

function command(
  name: string | null,
  parameters: string[] = [],
  children: PowerShellAstNode[] = [],
): PowerShellAstNode {
  return {
    kind: "command",
    children,
    commandName:
      name === null
        ? { kind: "dynamic", text: "$command" }
        : { kind: "literal", value: name },
    elements: [
      ...(name === null
        ? []
        : [{ kind: "argument", value: { kind: "literal", value: name } }]),
      ...parameters.map((parameter) => ({
        kind: "parameter",
        name: parameter,
        spelling: `-${parameter}`,
      })),
    ],
  };
}

function parsed(...commands: PowerShellAstNode[]): PowerShellParseResponse {
  return {
    protocolVersion: 1,
    ok: true,
    root: { kind: "script", children: commands },
    parseErrors: [],
  };
}

describe("PowerShell structural matchers", () => {
  it("matches recursive force delete with cmdlet or explicit alias case-insensitively", () => {
    for (const name of [
      "Remove-Item",
      "RM",
      "ri",
      "del",
      "erase",
      "rd",
      "rmdir",
    ]) {
      expect(
        matchDangerousPowerShellCommand(
          parsed(command(name, ["rEcUrSe", "FORCE"])),
        ),
      ).toEqual({
        description: "recursive force delete",
        pattern: "powershell.remove-item.recurse-force",
      });
    }
  });

  it("requires both recursive and force parameters; does not import Bash flags", () => {
    expect(
      matchDangerousPowerShellCommand(
        parsed(command("Remove-Item", ["Recurse"])),
      ),
    ).toBeUndefined();
    expect(
      matchDangerousPowerShellCommand(
        parsed(command("Remove-Item", ["Force"])),
      ),
    ).toBeUndefined();
    expect(
      matchDangerousPowerShellCommand(parsed(command("Remove-Item", ["rf"]))),
    ).toBeUndefined();
  });

  it("matches disk clearing and formatting, but not similarly named commands", () => {
    expect(
      matchDangerousPowerShellCommand(
        parsed(command("Clear-Disk", ["RemoveData"])),
      ),
    ).toMatchObject({ pattern: "powershell.clear-disk.remove-data" });
    expect(
      matchDangerousPowerShellCommand(parsed(command("Format-Volume"))),
    ).toMatchObject({ pattern: "powershell.format-volume" });
    expect(
      matchDangerousPowerShellCommand(parsed(command("Get-Format-Volume"))),
    ).toBeUndefined();
    expect(
      matchDangerousPowerShellCommand(parsed(command("Clear-Disk"))),
    ).toBeUndefined();
  });

  it("ignores dynamic command names rather than flattening them into literals", () => {
    expect(
      matchDangerousPowerShellCommand(
        parsed(command(null, ["Recurse", "Force"])),
      ),
    ).toBeUndefined();
  });

  it("visits nested commands once via children, including unknown wrapper nodes", () => {
    const nested = command("Format-Volume");
    const wrapper: PowerShellAstNode = {
      kind: "futureParserNode",
      children: [nested],
      elements: [{ kind: "argument", node: nested }],
    };
    expect([...walkPowerShellCommands(wrapper)]).toEqual([nested]);
    expect(matchDangerousPowerShellCommand(parsed(wrapper))).toMatchObject({
      pattern: "powershell.format-volume",
    });
  });

  it("uses source-order traversal before matcher priority", () => {
    const first = command("Format-Volume");
    const later = command("Remove-Item", ["Recurse", "Force"]);
    expect(matchDangerousPowerShellCommand(parsed(first, later))).toMatchObject(
      { pattern: "powershell.format-volume" },
    );
  });
});
