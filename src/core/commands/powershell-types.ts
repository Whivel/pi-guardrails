export interface PowerShellExtent {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface PowerShellValue {
  kind: string;
  value?: string | number | boolean | null;
  text?: string | null;
}

export interface PowerShellElement {
  kind: string;
  name?: string | null;
  spelling?: string | null;
  value?: PowerShellValue | null;
  node?: PowerShellAstNode | null;
  extent?: PowerShellExtent | null;
}

export interface PowerShellAstNode {
  kind: string;
  extent?: PowerShellExtent | null;
  children: PowerShellAstNode[];
  commandName?: PowerShellValue | null;
  invocationOperator?: string | null;
  elements?: PowerShellElement[] | null;
  text?: string | null;
  value?: PowerShellValue | null;
  [key: string]: unknown;
}

export interface PowerShellParseError {
  errorId: string;
  message: string;
  incompleteInput: boolean;
  extent: PowerShellExtent | null;
}

export interface PowerShellParseResponse {
  protocolVersion: 1;
  ok: true;
  root: PowerShellAstNode;
  parseErrors: PowerShellParseError[];
}
