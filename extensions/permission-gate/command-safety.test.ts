import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkCommandSafety } from "./command-safety";
import { parsePowerShellCommand } from "./powershell-parser";
import type { CommandInput } from "./command-input";
import type { PowerShellParseResponse } from "../../src/core/commands/powershell-types";

vi.mock("./powershell-parser", () => ({
  parsePowerShellCommand: vi.fn(),
}));

const parse = vi.mocked(parsePowerShellCommand);
const gateConfig = {
  patterns: [],
  useBuiltinMatchers: true,
  caseInsensitive: false,
  requireConfirmation: true,
  allowedPatterns: [],
  autoDenyPatterns: [],
};

const parsedPowerShell: PowerShellParseResponse = {
  protocolVersion: 1,
  ok: true,
  root: {
    kind: "script",
    children: [
      {
        kind: "command",
        commandName: { kind: "literal", value: "Format-Volume" },
        children: [],
        elements: [],
      },
    ],
  },
  parseErrors: [],
};

describe("dialect-specific command safety", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps Bash on its own checker without starting the PowerShell parser", async () => {
    const toolInput: CommandInput = {
      kind: "command",
      toolName: "bash",
      command: "rm -rf ./tmp",
      input: { command: "rm -rf ./tmp" },
    };
    const result = await checkCommandSafety(
      toolInput,
      { kind: "command", command: toolInput.command, origin: "bash" },
      gateConfig,
    );

    expect(result.kind).toBe("dangerous");
    expect(parse).not.toHaveBeenCalled();
  });

  it("sends only PowerShell command text to PowerShell parser", async () => {
    parse.mockResolvedValue(parsedPowerShell);
    const toolInput: CommandInput = {
      kind: "command",
      toolName: "powershell",
      command: "Format-Volume -DriveLetter E",
      input: { command: "Format-Volume -DriveLetter E", timeout: 10 },
    };
    const result = await checkCommandSafety(
      toolInput,
      { kind: "command", command: toolInput.command, origin: "powershell" },
      gateConfig,
    );

    expect(parse).toHaveBeenCalledExactlyOnceWith(
      "Format-Volume -DriveLetter E",
    );
    expect(result).toMatchObject({
      kind: "dangerous",
      reason: "volume format",
      action: { origin: "powershell" },
    });
  });

  it("fails closed when PowerShell parser is unavailable or returns parse errors", async () => {
    const toolInput: CommandInput = {
      kind: "command",
      toolName: "powershell",
      command: "Get-ChildItem",
      input: { command: "Get-ChildItem" },
    };
    parse.mockRejectedValueOnce(new Error("binary missing"));
    const unavailable = await checkCommandSafety(
      toolInput,
      { kind: "command", command: toolInput.command, origin: "powershell" },
      gateConfig,
    );
    expect(unavailable).toMatchObject({
      kind: "dangerous",
      reason: expect.stringContaining("binary missing"),
      metadata: { pattern: "powershell.parser-error" },
    });

    parse.mockResolvedValueOnce({
      ...parsedPowerShell,
      root: { kind: "script", children: [] },
      parseErrors: [
        {
          errorId: "IncompleteInput",
          message: "incomplete syntax",
          incompleteInput: true,
          extent: null,
        },
      ],
    });
    const incomplete = await checkCommandSafety(
      toolInput,
      { kind: "command", command: toolInput.command, origin: "powershell" },
      gateConfig,
    );
    expect(incomplete).toMatchObject({
      kind: "dangerous",
      reason: expect.stringContaining("incomplete syntax"),
    });
  });

  it("reuses configured command rules when PowerShell parser fails", async () => {
    parse.mockRejectedValue(new Error("binary missing"));
    const toolInput: CommandInput = {
      kind: "command",
      toolName: "powershell",
      command: "Get-ChildItem -Recurse",
      input: { command: "Get-ChildItem -Recurse", timeout: 10 },
    };
    const result = await checkCommandSafety(
      toolInput,
      { kind: "command", command: toolInput.command, origin: "powershell" },
      {
        ...gateConfig,
        patterns: [{ pattern: "Get-ChildItem", description: "custom rule" }],
      },
    );

    expect(result).toMatchObject({ kind: "dangerous", reason: "custom rule" });
    expect(parse).toHaveBeenCalledExactlyOnceWith("Get-ChildItem -Recurse");
  });
});
