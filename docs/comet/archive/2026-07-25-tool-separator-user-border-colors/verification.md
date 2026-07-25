# Acceptance evidence

<!-- comet-native:acceptance-evidence:start -->
[
  {
    "acceptance_id": "acceptance-1c255c4e5bc5eb25e1c87aa8d107e4e91f07231886b8e3918e77a3f8bfb01466",
    "evidence_refs": [
      "src/config-store.ts",
      "tests/config-store.test.ts"
    ]
  },
  {
    "acceptance_id": "acceptance-35954016d179bbfc25bf8996efc92502d3707834814e93d85ec1667e021ad79b",
    "evidence_refs": [
      "tests/index-integration.test.ts",
      "tests/real-runtime-contract.test.ts"
    ]
  },
  {
    "acceptance_id": "acceptance-426d702cd385d58526fe6c4dbd694b89c6dae85d9cb8d78e3aa96eda70752efa",
    "evidence_refs": [
      "src/pi-host-adapter.ts",
      "tests/pure-grep-display.test.ts"
    ]
  },
  {
    "acceptance_id": "acceptance-4943a9c01cec73b67827bcbe5dc789a1902393ca5ac87ae3ef1c91c49a936e93",
    "evidence_refs": [
      "src/user-message-box-renderer.ts",
      "tests/user-message-box.test.ts"
    ]
  },
  {
    "acceptance_id": "acceptance-53a0415eeb28646d3868ab563198fe0165bf8d0d88b827fb34250258807c90aa",
    "evidence_refs": [
      "src/pi-host-adapter.ts",
      "tests/pure-grep-display.test.ts"
    ]
  },
  {
    "acceptance_id": "acceptance-63a676385379113e068432deea1531a0ed80f5df89c177c898335da74b18d7de",
    "evidence_refs": [
      "src/pi-host-adapter.ts",
      "tests/pure-grep-display.test.ts"
    ]
  },
  {
    "acceptance_id": "acceptance-702c4e9308c72fa6de17816038a170ec3716b62421ff87d9d4e4cf146a5285e0",
    "evidence_refs": [
      "src/pi-host-adapter.ts",
      "tests/pure-grep-display.test.ts"
    ]
  },
  {
    "acceptance_id": "acceptance-7e36f17e0b640998bcbff14c84805cdf7ef73e0ae956fa2859e19302d8ba46bb",
    "evidence_refs": [
      "tests/pure-bash-display.test.ts",
      "tests/pure-grep-display.test.ts",
      "tests/reload-behavior.test.ts"
    ]
  },
  {
    "acceptance_id": "acceptance-a171a8d4031f1a4465f9b6cf501e7311cf879a3b059d4f8f1562a1998b144f5d",
    "evidence_refs": [
      "src/user-message-box-renderer.ts",
      "tests/user-message-box.test.ts"
    ]
  },
  {
    "acceptance_id": "acceptance-a9e6c655cb9e8d84d4cda5c351b6985358c01d5c06ab3445fa958d5ebc6e09dd",
    "evidence_refs": [
      "src/pi-host-adapter.ts",
      "tests/pure-grep-display.test.ts"
    ]
  }
]
<!-- comet-native:acceptance-evidence:end -->

# Commands and results

- `npm run check`：通过；TypeScript typecheck 通过，完整测试共 670 项，667 通过、0 失败、3 项因未提供可选 runtime root 跳过。
- `PI_RUNTIME_DEV_ROOT="$PWD/node_modules/@earendil-works/pi-coding-agent" npm run test:contract:local`：通过；development 真实 Pi runtime contract 通过，0.81.1 与 0.82.0 独立 runtime root 未提供而跳过。
- `npm run typecheck && npx tsx --test tests/pure-grep-display.test.ts tests/user-message-box.test.ts tests/config-store.test.ts tests/config-modal.test.ts && git diff --check`：通过；125 项相关测试全部通过，diff 无 whitespace error。
- `comet native check tool-separator-user-border-colors --json`：通过；17 个 scope 文件完成文本安全扫描，0 issue，receipt `runtime/evidence/check-receipts/bbffe8212e4b24989d31f7df4dc18e91e6197453a89f581b76011117c77dbb6e.json`。

# Skipped checks

- 未提供独立的 `PI_RUNTIME_0_81_1_ROOT` 与 `PI_RUNTIME_0_82_0_ROOT`，因此这两个代表版本的真实 runtime contract 未在本机重复运行。当前安装的 development root 版本为 0.81.1，development contract 已通过。
- 未在当前会话内执行人工 `/reload` 视觉截图验收；reload 所有权、重复包装和 Theme/配置重绘由自动化测试覆盖。

# Spec consistency

- 实现包含四个确认配置字段及六个 Theme token 白名单。
- Host Adapter 在完整工具行 `render` seam 追加分隔线，因此覆盖未配置第三方工具而不复制 Pi result fallback。
- USER 边框继续使用原 renderer seam，颜色 token 已进入 final-output cache key。
- 工具定义、执行、Renderer Catalog 选择、Agent context 与 session 数据未修改。
- 文档、示例配置、Modal、preset、normalization 和测试与完整目标规格一致。

# Known limitations and risks

- 虚线使用 Unicode 单列字符 `╌`；少数旧字体可能显示异常。规格允许在真实兼容问题出现时内部降级为 ASCII `-`，无需扩大配置 Interface。
- 分隔线属于 ToolExecution 最终 render seam，因此未来 Pi 若改变该私有 descriptor 形状，Host Adapter 会按现有策略 fail open 到原生 presentation。
- 未取得独立 Pi 0.82.0 runtime root，本次仅由 synthetic Host Adapter version contract 与现有 runtime matrix 覆盖该声明范围。

# Conclusion

通过。实现满足已确认的全局工具分隔线、样式与 Theme token 配置、USER 边框颜色配置和 pure-display 非干扰要求；已执行检查均通过。
