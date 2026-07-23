import assert from "node:assert/strict";
import test from "node:test";
import { buildPendingEditPreviewData } from "../src/pending-diff-preview.ts";

test("pending edit preview trusts only supplied old/new evidence", () => {
  const preview = buildPendingEditPreviewData(
    { path: "sample.txt", oldText: "before\n", newText: "after\n" },
    process.cwd(),
  );
  assert.deepEqual(preview, {
    filePath: "sample.txt",
    previousContent: "before\n",
    nextContent: "after\n",
    fileExistedBeforeWrite: true,
    headerLabel: "pending edit",
  });
});
