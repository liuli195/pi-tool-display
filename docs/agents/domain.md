# Domain Docs

工程技能探索代码库时，应按以下规则读取领域文档。

## 当前结构

本仓库采用 single-context 布局。

- 当前没有 `CONTEXT.md`；不存在时静默继续。
- 规格与架构约束位于 `docs/comet/specs/`，替代 `docs/adr/`。

## 探索前读取

读取与任务相关的规格：

- `docs/comet/specs/pure-display-tool-rendering.md`
- `docs/comet/specs/visual-preview-and-config-lifecycle-corrections.md`

以后新增规格时，也应检查 `docs/comet/specs/` 下的相关文件。

## 词汇

若根目录以后出现 `CONTEXT.md`，使用其中定义的领域词汇，避免使用其明确排斥的同义词。

## 规格冲突

如果输出与现有规格冲突，必须明确指出相关规格及冲突内容，不得静默覆盖。
