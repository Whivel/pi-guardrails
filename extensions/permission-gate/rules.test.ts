import { describe, expect, it } from "vitest";
import {
  createPermissionGateRule,
  formatAutoDenyReason,
  matchCommandPattern,
  matchesAnyCommandPattern,
} from "./rules";

describe("createPermissionGateRule", () => {
  it("passes file actions", async () => {
    const rule = createPermissionGateRule({
      patterns: [{ pattern: "rm -rf", description: "recursive delete" }],
      useBuiltinMatchers: false,
    });
    await expect(
      rule.check({ kind: "file", path: "package.json" }),
    ).resolves.toEqual({
      kind: "pass",
    });
  });

  it("matches configured dangerous command patterns", async () => {
    const rule = createPermissionGateRule({
      patterns: [
        { pattern: "terraform destroy", description: "Destroy infra" },
      ],
      useBuiltinMatchers: false,
    });

    await expect(
      rule.check({
        kind: "command",
        command: "terraform destroy -auto-approve",
      }),
    ).resolves.toEqual({
      kind: "match",
      reason: "Destroy infra",
      metadata: {
        command: "terraform destroy -auto-approve",
        description: "Destroy infra",
        pattern: "terraform destroy",
      },
    });
  });

  it("can use builtin dangerous command matchers", async () => {
    const rule = createPermissionGateRule({
      patterns: [],
      useBuiltinMatchers: true,
    });
    await expect(
      rule.check({ kind: "command", command: "rm -rf dist" }),
    ).resolves.toMatchObject({ kind: "match" });
  });

  it("matches configured patterns case-insensitively when enabled", async () => {
    const rule = createPermissionGateRule({
      patterns: [
        {
          pattern: "^terraform\\s+apply",
          description: "Terraform apply",
          regex: true,
        },
      ],
      useBuiltinMatchers: false,
      caseInsensitive: true,
    });

    await expect(
      rule.check({ kind: "command", command: "TERRAFORM APPLY -auto-approve" }),
    ).resolves.toMatchObject({ kind: "match", reason: "Terraform apply" });
  });

  it("applies case-insensitive matching to built-in command patterns too", async () => {
    const rule = createPermissionGateRule({
      patterns: [{ pattern: "sudo", description: "superuser command" }],
      useBuiltinMatchers: true,
      caseInsensitive: true,
    });

    await expect(
      rule.check({ kind: "command", command: "SUDO cat /etc/shadow" }),
    ).resolves.toMatchObject({ kind: "match", reason: "superuser command" });
  });
});

describe("matchesAnyCommandPattern", () => {
  it("matches substring and regex command patterns", () => {
    expect(
      matchesAnyCommandPattern("npm publish --dry-run", [
        { pattern: "npm publish" },
      ]),
    ).toBe(true);
    expect(
      matchesAnyCommandPattern("DROP TABLE users", [
        { pattern: "^DROP TABLE", regex: true },
      ]),
    ).toBe(true);
    expect(
      matchesAnyCommandPattern("npm test", [{ pattern: "npm publish" }]),
    ).toBe(false);
  });
});

describe("matchCommandPattern", () => {
  it("returns the matched PatternConfig", () => {
    const patterns = [{ pattern: "npm publish" }, { pattern: "rm -rf" }];
    expect(matchCommandPattern("npm publish --dry-run", patterns)).toBe(
      patterns[0],
    );
  });

  it("returns the matching regex pattern", () => {
    const patterns = [{ pattern: "^DROP TABLE", regex: true }];
    expect(matchCommandPattern("DROP TABLE users", patterns)).toBe(patterns[0]);
  });

  it("matches literal and regex auto-deny or allow patterns case-insensitively", () => {
    expect(
      matchCommandPattern(
        "GIT PUSH --FORCE",
        [{ pattern: "git push --force" }],
        true,
      ),
    ).toEqual({ pattern: "git push --force" });
    expect(
      matchCommandPattern(
        "DROP TABLE users",
        [{ pattern: "^drop table", regex: true }],
        true,
      ),
    ).toEqual({ pattern: "^drop table", regex: true });
  });

  it("returns null when no pattern matches", () => {
    expect(
      matchCommandPattern("npm test", [{ pattern: "npm publish" }]),
    ).toBeNull();
  });

  it("preserves description on the returned pattern", () => {
    const patterns = [
      {
        pattern: "python -m venv",
        description: "Use the project .venv instead",
      },
    ];
    expect(
      matchCommandPattern("python -m venv .venv", patterns)?.description,
    ).toBe("Use the project .venv instead");
  });
});

describe("formatAutoDenyReason", () => {
  it("uses description when present", () => {
    expect(
      formatAutoDenyReason({
        pattern: "python -m venv",
        description: "Use the project .venv instead",
      }),
    ).toBe("Command auto-denied: Use the project .venv instead");
  });

  it("falls back when description is missing or blank", () => {
    const expected =
      "Command matched auto-deny pattern and was blocked automatically.";
    expect(formatAutoDenyReason({ pattern: "python -m venv" })).toBe(expected);
    expect(
      formatAutoDenyReason({ pattern: "python -m venv", description: "" }),
    ).toBe(expected);
    expect(
      formatAutoDenyReason({ pattern: "python -m venv", description: "  " }),
    ).toBe(expected);
  });
});
