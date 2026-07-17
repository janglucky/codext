# Codext Agent

基于 Electron、React 和 TypeScript 的 Windows 桌面 ReAct AI Agent 一期工程。

## 已实现

- Electron 安全窗口与 context-isolated IPC
- 标准 ReAct：Reason → Skill → Act → Validate
- OpenAI 兼容 chat/completions 适配与演示模式
- 本地配置、任务历史持久化，以及模型配置面板
- 内置 Word/Excel 本地解析工具和 PPT MCP 处理服务
- 内部文件解密工具，已验证支持 txt、csv、pdf、docx、xlsx、pptx
- TypeScript、ESLint、Vitest、构建与 Windows 打包脚本

## 运行

```powershell
npm install
npm run dev
```

## Office 文档与 PPT MCP

当前支持直接上传现代 Office OOXML 格式：`.docx`、`.xlsx`、`.pptx`。上传的 Office 附件会安全保存到工作区的 `.codext-attachments` 目录。

- Word 和 Excel 分别由本地 `parse_word`、`parse_excel` 工具解析。
- PowerPoint 由内置 PPT MCP 的 `parse_powerpoint` 工具解析。应用在 `127.0.0.1:3777` 启动 Streamable HTTP MCP 服务，并在每次连接和工具发现前在对应会话消息流中请求用户“允许一次”。
- PPT Processing Service 使用 `officeparser` 提取幻灯片结构、文本和备注。环境中存在 LibreOffice 时会报告渲染能力；不可用时自动跳过。OCR Vision 当前关闭，不影响结构和文本提取。
- 文本、CSV 或 Office 文件出现 NUL、乱码、异常二进制内容或解析失败时，Agent 会先调用 `decrypt_file`，将解密副本保存回工作区，再使用返回的 `output_path` 继续读取或解析。原文件不会被覆盖。

调用链如下：

```text
Electron/React -> ReAct Agent -> GPT API -> 单次用户确认 -> PPT MCP -> PPT Processing Service
```

## 会话工作区

每个会话可以选择独立工作区。未设置覆盖路径时，会话直接继承全局配置中的工作目录；选择会话目录不会修改全局配置，使用“恢复全局目录”即可重新继承默认值。附件、文件工具、Office 解析、解密和 PPT MCP 均使用当前会话的有效工作区。切换工作区时，已落盘的会话附件会复制到新目录。

会话附件会持续保存并自动加入后续请求，但发送后不会继续占用输入框附件区域；模型请求失败或应用重启不会清除附件状态。旧版本会话会从最近一条含附件的用户消息自动恢复该状态。

当任务存在多个互斥执行方案时，Agent 会在当前消息流中显示单选列表和“确认选择”按钮。用户确认后，选择结果会回到同一次 ReAct 任务中继续执行，不需要再发送一条对话消息。

使用 `npm run verify` 执行类型、规范、测试和构建校验；使用 `npm run package:win` 输出 NSIS 与便携版 Windows 安装产物。
