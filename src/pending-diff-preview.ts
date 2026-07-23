export interface PendingDiffPreviewData {
  filePath: string;
  previousContent?: string;
  nextContent?: string;
  fileExistedBeforeWrite: boolean;
  headerLabel: string;
  notice?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function buildPendingEditPreviewData(input: unknown, _cwd: string): PendingDiffPreviewData | undefined {
  const value = record(input);
  const filePath = typeof value.file_path === "string" && value.file_path.trim()
    ? value.file_path.trim()
    : typeof value.path === "string" && value.path.trim() ? value.path.trim() : undefined;
  const replacement = Array.isArray(value.edits) && value.edits.length === 1
    ? record(value.edits[0])
    : value;
  if (!filePath || typeof replacement.oldText !== "string" || typeof replacement.newText !== "string") return undefined;
  return {
    filePath,
    previousContent: replacement.oldText,
    nextContent: replacement.newText,
    fileExistedBeforeWrite: true,
    headerLabel: "pending edit",
  };
}
