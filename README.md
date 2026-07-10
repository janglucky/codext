# Codext Agent

基于 Electron、React 和 TypeScript 的 Windows 桌面 ReAct AI Agent 一期工程。

## 已实现

- Electron 安全窗口与 context-isolated IPC
- 标准 ReAct：Reason → Skill → Act → Validate
- OpenAI 兼容 chat/completions 适配与演示模式
- 本地配置、任务历史持久化，以及模型配置面板
- TypeScript、ESLint、Vitest、构建与 Windows 打包脚本

## 运行

```powershell
npm install
npm run dev
```

使用 npm run verify 执行类型、规范、测试和构建校验；使用 npm run package:win 输出 NSIS 与便携版 Windows 安装产物。
