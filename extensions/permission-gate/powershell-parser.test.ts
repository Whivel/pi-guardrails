import { describe, expect, it } from "vitest";
import { matchDangerousPowerShellCommand } from "../../src/core/commands/powershell";
import {
  getPowerShellParserPath,
  parsePowerShellCommand,
  PowerShellParserError,
  validatePowerShellParseResponse,
} from "./powershell-parser";

const EMPTY_RESPONSE = {
  protocolVersion: 1,
  ok: true,
  root: { kind: "script", children: [] },
  parseErrors: [],
};

function hasBundledParser(): boolean {
  return (
    (process.platform === "win32" || process.platform === "linux") &&
    process.arch === "x64"
  );
}

describe("PowerShell parser adapter", () => {
  it("selects only known OS/architecture artifacts", () => {
    expect(getPowerShellParserPath("win32", "x64")).toMatch(
      /pwsh-ast-parser\.exe$/,
    );
    expect(getPowerShellParserPath("linux", "x64")).toMatch(/pwsh-ast-parser$/);
    expect(() => getPowerShellParserPath("darwin", "arm64")).toThrow(
      /no bundled parser artifact/,
    );
  });

  it("validates protocol version and minimal AST/parse-error shape", () => {
    expect(validatePowerShellParseResponse(EMPTY_RESPONSE)).toMatchObject({
      ok: true,
    });
    expect(() =>
      validatePowerShellParseResponse({
        ...EMPTY_RESPONSE,
        protocolVersion: 2,
      }),
    ).toThrow(/incompatible protocol version/);
    expect(() =>
      validatePowerShellParseResponse({
        ...EMPTY_RESPONSE,
        root: { kind: "script" },
      }),
    ).toThrow(/invalid AST node/);
    expect(() =>
      validatePowerShellParseResponse({
        ...EMPTY_RESPONSE,
        parseErrors: [
          { errorId: "x", message: "bad", incompleteInput: "no", extent: null },
        ],
      }),
    ).toThrow(/invalid parse error/);
  });

  it("rejects oversized requests before starting a process", async () => {
    await expect(
      parsePowerShellCommand("x".repeat(1_048_576), {
        executablePath: "unused",
      }),
    ).rejects.toThrow(/1 MiB request limit/);
  });

  it("reports a missing executable as an operational parser error", async () => {
    await expect(
      parsePowerShellCommand("Get-ChildItem", {
        executablePath: "missing-pwsh-parser-test-executable",
      }),
    ).rejects.toBeInstanceOf(PowerShellParserError);
  });

  it.skipIf(!hasBundledParser())(
    "smokes the bundled parser and detects nested destructive commands",
    async () => {
      const response = await parsePowerShellCommand(
        "$items | ForEach-Object { & Remove-Item -Recurse -Force $_ }",
      );
      expect(response.parseErrors).toEqual([]);
      expect(matchDangerousPowerShellCommand(response)).toEqual({
        description: "recursive force delete",
        pattern: "powershell.remove-item.recurse-force",
      });
    },
  );

  it.skipIf(!hasBundledParser())(
    "returns partial AST and parse errors without treating it as valid",
    async () => {
      const response = await parsePowerShellCommand("if (");
      expect(response.parseErrors.length).toBeGreaterThan(0);
      expect(response.root.kind).toBe("script");
    },
  );
});
