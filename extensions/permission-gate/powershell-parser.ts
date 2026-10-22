import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type {
  PowerShellAstNode,
  PowerShellExtent,
  PowerShellParseError,
  PowerShellParseResponse,
  PowerShellValue,
} from "../../src/core/commands/powershell-types";
export type {
  PowerShellAstNode,
  PowerShellParseResponse,
} from "../../src/core/commands/powershell-types";

export const POWERSHELL_PROTOCOL_VERSION = 1;
export const POWERSHELL_MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_AST_NODES = 100_000;

export class PowerShellParserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PowerShellParserError";
  }
}

export function getPowerShellParserPath(
  platform = process.platform,
  arch = process.arch,
): string {
  const binDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../bin",
  );
  if (platform === "win32" && arch === "x64") {
    return resolve(binDirectory, "pwsh-ast-parser.exe");
  }
  if (platform === "linux" && arch === "x64") {
    return resolve(binDirectory, "pwsh-ast-parser");
  }
  throw new PowerShellParserError(
    `PowerShell parsing is unavailable on ${platform}/${arch}: no bundled parser artifact.`,
  );
}

export function validatePowerShellParseResponse(
  input: unknown,
): PowerShellParseResponse {
  if (
    !isRecord(input) ||
    input.protocolVersion !== POWERSHELL_PROTOCOL_VERSION
  ) {
    throw new PowerShellParserError(
      "PowerShell parser returned incompatible protocol version.",
    );
  }
  if (input.ok !== true) {
    const error =
      isRecord(input.error) && typeof input.error.message === "string"
        ? input.error.message
        : "unspecified parser error";
    throw new PowerShellParserError(`PowerShell parser failed: ${error}`);
  }
  if (!Array.isArray(input.parseErrors)) {
    throw new PowerShellParserError(
      "PowerShell parser response has invalid parseErrors.",
    );
  }

  if (!isAstNode(input.root, 0, { count: 0 })) {
    throw new PowerShellParserError(
      "PowerShell parser response contains an invalid AST node.",
    );
  }
  const parseErrors: PowerShellParseError[] = [];
  for (const candidate of input.parseErrors) {
    if (!isRecord(candidate)) {
      throw new PowerShellParserError(
        "PowerShell parser response contains an invalid parse error.",
      );
    }
    const { errorId, message, incompleteInput, extent } = candidate;
    if (
      typeof errorId !== "string" ||
      typeof message !== "string" ||
      typeof incompleteInput !== "boolean" ||
      (extent !== null && !isExtent(extent))
    ) {
      throw new PowerShellParserError(
        "PowerShell parser response contains an invalid parse error.",
      );
    }
    parseErrors.push({ errorId, message, incompleteInput, extent });
  }

  return {
    protocolVersion: POWERSHELL_PROTOCOL_VERSION,
    ok: true,
    root: input.root,
    parseErrors,
  };
}

export async function parsePowerShellCommand(
  command: string,
  options: { executablePath?: string; timeoutMs?: number } = {},
): Promise<PowerShellParseResponse> {
  const executablePath = options.executablePath ?? getPowerShellParserPath();
  const request = JSON.stringify({
    protocolVersion: POWERSHELL_PROTOCOL_VERSION,
    command,
  });
  const requestBytes = Buffer.byteLength(request, "utf8");
  if (requestBytes > POWERSHELL_MAX_REQUEST_BYTES) {
    throw new PowerShellParserError(
      "PowerShell command exceeds parser 1 MiB request limit.",
    );
  }

  const output = await runParserProcess(
    executablePath,
    request,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  let response: unknown;
  try {
    response = JSON.parse(output);
  } catch {
    throw new PowerShellParserError("PowerShell parser returned invalid JSON.");
  }
  return validatePowerShellParseResponse(response);
}

async function runParserProcess(
  executablePath: string,
  request: string,
  timeoutMs: number,
): Promise<string> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(executablePath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    throw parserStartError(executablePath, error);
  }

  const stdout: Buffer[] = [];
  let outputBytes = 0;
  let stderr = "";
  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
    controller.abort();
  }, timeoutMs);

  const readStdout = async () => {
    for await (const chunk of child.stdout) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > MAX_RESPONSE_BYTES) {
        child.kill();
        throw new PowerShellParserError(
          "PowerShell parser response exceeds 16 MiB limit.",
        );
      }
      stdout.push(buffer);
    }
  };
  const readStderr = async () => {
    for await (const chunk of child.stderr) {
      if (stderr.length < 4096) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
        stderr += text.slice(0, 4096 - stderr.length);
      }
    }
  };

  child.stdin.on("error", () => {
    // The process may reject an oversized or malformed request and close stdin early.
  });
  child.stdin.end(request, "utf8");

  try {
    const [[code]] = await Promise.all([
      once(child, "close", { signal: controller.signal }),
      readStdout(),
      readStderr(),
    ]);
    if (timedOut) {
      throw new PowerShellParserError(
        `PowerShell parser timed out after ${timeoutMs} ms.`,
      );
    }

    const text = Buffer.concat(stdout).toString("utf8").trim();
    if (!text) {
      throw new PowerShellParserError(
        `PowerShell parser produced no response${code === null ? "" : ` (exit ${code})`}${stderr ? `: ${stderr.trim()}` : "."}`,
      );
    }
    return text;
  } catch (error) {
    child.kill();
    if (timedOut) {
      throw new PowerShellParserError(
        `PowerShell parser timed out after ${timeoutMs} ms.`,
      );
    }
    if (error instanceof PowerShellParserError) throw error;
    throw parserStartError(executablePath, error);
  } finally {
    clearTimeout(timer);
  }
}

function parserStartError(
  executablePath: string,
  error: unknown,
): PowerShellParserError {
  const detail = error instanceof Error ? error.message : String(error);
  return new PowerShellParserError(
    `Cannot start PowerShell parser at ${executablePath}: ${detail}`,
  );
}

function isAstNode(
  node: unknown,
  depth: number,
  state: { count: number },
): node is PowerShellAstNode {
  state.count++;
  if (depth > 512 || state.count > MAX_AST_NODES || !isRecord(node))
    return false;
  if (typeof node.kind !== "string" || !Array.isArray(node.children))
    return false;
  if (
    node.extent !== undefined &&
    node.extent !== null &&
    !isExtent(node.extent)
  )
    return false;
  if (
    node.commandName !== undefined &&
    node.commandName !== null &&
    !isValue(node.commandName)
  )
    return false;
  if (node.elements !== undefined && node.elements !== null) {
    if (!Array.isArray(node.elements)) return false;
    for (const element of node.elements) {
      if (!isRecord(element) || typeof element.kind !== "string") return false;
      if (
        element.name !== undefined &&
        element.name !== null &&
        typeof element.name !== "string"
      )
        return false;
      if (
        element.spelling !== undefined &&
        element.spelling !== null &&
        typeof element.spelling !== "string"
      )
        return false;
      if (
        element.value !== undefined &&
        element.value !== null &&
        !isValue(element.value)
      )
        return false;
      if (
        element.extent !== undefined &&
        element.extent !== null &&
        !isExtent(element.extent)
      )
        return false;
      // SAFETY: elements[].node mirrors syntax nodes; children is canonical traversal route.
      if (
        element.node !== undefined &&
        element.node !== null &&
        !isNodeHeader(element.node)
      )
        return false;
    }
  }
  return node.children.every((child) => isAstNode(child, depth + 1, state));
}

function isNodeHeader(value: unknown): value is PowerShellAstNode {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    Array.isArray(value.children)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValue(value: unknown): value is PowerShellValue {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  return (
    (value.value === undefined ||
      value.value === null ||
      ["string", "number", "boolean"].includes(typeof value.value)) &&
    (value.text === undefined ||
      value.text === null ||
      typeof value.text === "string")
  );
}

function isExtent(value: unknown): value is PowerShellExtent {
  if (!isRecord(value)) return false;
  const keys = [
    "startOffset",
    "endOffset",
    "startLine",
    "startColumn",
    "endLine",
    "endColumn",
  ] as const;
  return keys.every((key) => {
    const coordinate = value[key];
    return (
      typeof coordinate === "number" &&
      Number.isInteger(coordinate) &&
      coordinate >= 0
    );
  });
}
