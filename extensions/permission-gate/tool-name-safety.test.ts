import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/shared/config/defaults";
import { checkToolNameSafety } from "./tool-name-safety";

describe("checkToolNameSafety", () => {
  const config = () => structuredClone(DEFAULT_CONFIG.toolsGate);

  it("passes when no tool-name patterns match", () => {
    expect(checkToolNameSafety("read", config())).toEqual({ kind: "pass" });
  });

  it("matches tool names by case-sensitive substring by default", () => {
    const toolsGate = config();
    toolsGate.patterns = [
      { pattern: "browser", description: "browser access" },
    ];

    expect(checkToolNameSafety("browser_search", toolsGate)).toEqual({
      kind: "confirm",
      pattern: { pattern: "browser", description: "browser access" },
    });
    expect(checkToolNameSafety("Browser_search", toolsGate)).toEqual({
      kind: "pass",
    });
  });

  it("supports case-insensitive regex patterns", () => {
    const toolsGate = config();
    toolsGate.caseInsensitive = true;
    toolsGate.patterns = [
      { pattern: "^browser_.*", description: "browser tool", regex: true },
    ];

    expect(checkToolNameSafety("BROWSER_SEARCH", toolsGate).kind).toBe(
      "confirm",
    );
  });

  it("lets allowed patterns bypass prompt and auto-deny rules", () => {
    const toolsGate = config();
    toolsGate.patterns = [{ pattern: "browser", description: "browser" }];
    toolsGate.allowedPatterns = [{ pattern: "browser_safe" }];
    toolsGate.autoDenyPatterns = [{ pattern: "browser", description: "deny" }];

    expect(checkToolNameSafety("browser_safe", toolsGate)).toEqual({
      kind: "allow",
    });
  });

  it("returns matching auto-deny pattern before confirmation pattern", () => {
    const toolsGate = config();
    toolsGate.patterns = [{ pattern: "browser", description: "confirm" }];
    toolsGate.autoDenyPatterns = [
      { pattern: "browser_admin", description: "deny" },
    ];

    expect(checkToolNameSafety("browser_admin", toolsGate)).toEqual({
      kind: "auto-deny",
      pattern: { pattern: "browser_admin", description: "deny" },
    });
  });
});
