import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadToolDisplayConfig,
  normalizeToolDisplayConfig,
  saveToolDisplayConfig,
} from "../src/config-store.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

function withTempDir(name: string, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), name));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("config normalization clamps invalid values and migrates legacy read override", () => {
  const config = normalizeToolDisplayConfig({
    registerReadToolOverride: false,
    registerToolOverrides: { bash: false },
    readOutputMode: "invalid",
    searchOutputMode: "count",
    mcpOutputMode: "preview",
    previewLines: 999,
    expandedPreviewMaxLines: -1,
    bashCollapsedLines: 999,
    bashErrorOutputMode: "invalid",
    bashErrorPreviewLines: -1,
    diffViewMode: "stacked",
    diffSplitMinWidth: 1,
    diffCollapsedLines: 999,
    diffWordWrap: false,
  });

  assert.equal(config.builtInToolDisplays.read, false);
  assert.equal(config.builtInToolDisplays.grep, true);
  assert.equal(config.builtInToolDisplays.bash, false);
  assert.equal("registerToolOverrides" in config, false);
  assert.equal(config.readOutputMode, DEFAULT_TOOL_DISPLAY_CONFIG.readOutputMode);
  assert.equal(config.searchOutputMode, "count");
  assert.equal(config.mcpOutputMode, "preview");
  assert.equal(config.previewLines, 80);
  assert.equal(config.expandedPreviewMaxLines, 0);
  assert.equal(config.bashCollapsedLines, 80);
  assert.equal(config.bashErrorOutputMode, "preview");
  assert.equal(config.bashErrorPreviewLines, 1);
  assert.equal(config.diffViewMode, "unified");
  assert.equal(config.diffSplitMinWidth, 70);
  assert.equal(config.diffCollapsedLines, 240);
  assert.equal(config.diffWordWrap, false);
});

test("legacy registerToolOverrides config is accepted without rewriting the file", () => {
  withTempDir("pi-tool-display-legacy-register-", (dir) => {
    const configFile = join(dir, "config.json");
    const original = '{\n  "registerToolOverrides": { "read": false, "bash": false }\n}\n';
    writeFileSync(configFile, original, "utf8");

    const result = loadToolDisplayConfig(configFile);

    assert.equal(result.config.builtInToolDisplays.read, false);
    assert.equal(result.config.builtInToolDisplays.bash, false);
    assert.equal(readFileSync(configFile, "utf8"), original);
  });
});

test("canonical builtInToolDisplays takes precedence over legacy input", () => {
  const config = normalizeToolDisplayConfig({
    builtInToolDisplays: { read: true },
    registerToolOverrides: { read: false, bash: false },
  });
  assert.equal(config.builtInToolDisplays.read, true);
  assert.equal(config.builtInToolDisplays.bash, true);
});

test("legacy thinking-label config is ignored without rewriting the file", () => {
  withTempDir("pi-tool-display-legacy-thinking-", (dir) => {
    const configFile = join(dir, "config.json");
    const original = '{\n  "enableThinkingLabels": false,\n  "previewLines": 7\n}\n';
    writeFileSync(configFile, original, "utf8");

    const result = loadToolDisplayConfig(configFile);

    assert.equal("enableThinkingLabels" in result.config, false);
    assert.equal(result.config.previewLines, 7);
    assert.equal(readFileSync(configFile, "utf8"), original);
  });
});

test("config load reports parse errors and falls back to defaults", () => {
  withTempDir("pi-tool-display-config-load-", (dir) => {
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, "{not-json", "utf8");

    const result = loadToolDisplayConfig(configFile);

    assert.deepEqual(result.config, DEFAULT_TOOL_DISPLAY_CONFIG);
    assert.match(result.error ?? "", /Failed to parse/);
    assert.match(result.error ?? "", /config\.json/);
  });
});

test("config save writes normalized JSON and cleans temporary file on failure", () => {
  withTempDir("pi-tool-display-config-save-", (dir) => {
    const configFile = join(dir, "config.json");
    const saved = saveToolDisplayConfig(
      { ...DEFAULT_TOOL_DISPLAY_CONFIG, previewLines: 999 },
      configFile,
    );

    assert.equal(saved.success, true);
    const persisted = JSON.parse(readFileSync(configFile, "utf8")) as { previewLines?: number };
    assert.equal(persisted.previewLines, 80);

    const parentFile = join(dir, "not-a-directory");
    writeFileSync(parentFile, "blocks mkdir", "utf8");
    const blockedConfigFile = join(parentFile, "config.json");
    const failed = saveToolDisplayConfig(DEFAULT_TOOL_DISPLAY_CONFIG, blockedConfigFile);

    assert.equal(failed.success, false);
    assert.match(failed.error ?? "", /Failed to save/);
    assert.equal(existsSync(`${blockedConfigFile}.tmp`), false);
  });
});
