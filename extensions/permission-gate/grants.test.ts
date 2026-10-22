import { beforeEach, describe, expect, it, vi } from "vitest";
import { configLoader } from "../../src/shared/config";
import { isCommandAllowed, saveCommandSessionGrant } from "./grants";

vi.mock("../../src/shared/config", () => ({
  configLoader: {
    getConfig: vi.fn(),
    save: vi.fn(),
  },
}));

const getConfig = vi.mocked(configLoader.getConfig);

describe("command session grants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfig.mockReturnValue({
      permissionGate: { allowedPatterns: [], caseInsensitive: false },
    } as unknown as ReturnType<typeof configLoader.getConfig>);
  });

  it("stores an exact-match session grant scoped to its command dialect", async () => {
    const command = "rm -rf ./scratch (old) && printf '$HOME'\n";

    await saveCommandSessionGrant(command, "bash");

    expect(isCommandAllowed(command, "bash")).toBe(true);
    expect(isCommandAllowed("powershell " + command, "bash")).toBe(false);
    expect(isCommandAllowed(command, "powershell")).toBe(false);
    expect(
      isCommandAllowed(
        command.replace("./scratch", "./scratch-backup"),
        "bash",
      ),
    ).toBe(false);
  });

  it("keeps configured substring patterns shared across dialects", () => {
    getConfig.mockReturnValue({
      permissionGate: { allowedPatterns: [{ pattern: "git status" }] },
    } as unknown as ReturnType<typeof configLoader.getConfig>);

    expect(isCommandAllowed("cd /repo && git status", "bash")).toBe(true);
    expect(isCommandAllowed("cd /repo && git status", "powershell")).toBe(true);
  });

  it("matches configured allow patterns case-insensitively when configured", () => {
    getConfig.mockReturnValue({
      permissionGate: {
        allowedPatterns: [{ pattern: "git status" }],
        caseInsensitive: true,
      },
    } as unknown as ReturnType<typeof configLoader.getConfig>);

    expect(isCommandAllowed("GIT STATUS --SHORT", "powershell")).toBe(true);
  });
});
