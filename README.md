# WordWise — 划词即时 AI 释义

Windows 桌面常驻程序：在**任意应用**（微信、Word、浏览器、PDF……）中用鼠标选中一段文字，**无需任何额外操作**，选区旁立即弹出 AI 释义。

灵感来自夸克浏览器划词工具栏，但省掉了"再点一次功能按钮"这一步。

## 特性

- **全局划词**：基于 `selection-hook` 原生插件（全局鼠标钩子），取词三层降级：UI Automation TextPattern → IAccessible → 模拟 Ctrl+C（自动保存并还原剪贴板）
- **零动作弹窗**：无焦点置顶弹窗（`focusable: false` + `screen-saver` 层级），不打断当前操作
- **按长度分流**：≤15 字直接出释义；超过阈值先给动作选择（解释 / 总结 / 翻译 / 润色），确认后才发请求
- **自定义追问**：长文本可打开独立对话窗口，划词内容作为上下文多轮提问；会话落盘，随时从「历史对话」回顾继续
- **Markdown 渲染**：对话结果支持代码块、列表、标题、引用等，流式输出
- **模型分级**：短词释义用 `mimo-v2.6-pro-ultraspeed`，长文本动作用 `mimo-v2.6-flash`，可分别配置
- **选区定位**：弹窗出现在选区末尾下方，物理像素 → DIP 自动换算，支持多显示器与高 DPI
- **LRU 缓存**：最近 500 条结果本地持久化（按「动作 + 原文」为键），重复查询秒出
- **可视化配置**：API 地址 / 模型 / 提示词 / 温度 / max_tokens / 冷却 / 阈值等全部可在设置界面调整

## 技术栈

Electron 31 + selection-hook（N-API 原生模块）+ Node 原生 https（OpenAI 兼容 Chat Completions API）

```
├── main.js               # 主进程：托盘常驻、全局钩子、弹窗定位、对话窗口
├── lib/llm.js            # LLM 调用（Node https 直连 + SSE 流式解析 + 动作提示词）
├── lib/store.js          # 设置持久化
├── lib/cache.js          # LRU 结果缓存
├── lib/conversations.js  # 对话会话持久化（最多 60 条）
├── popup.html            # 弹窗 UI（选择 / 结果两阶段）
├── chat.html             # 对话窗口（Markdown 渲染 + 历史面板）
├── settings.html         # 设置界面
└── preload*.js           # contextBridge 安全桥接
```

## 使用

```bash
npm install
npm start
```

托盘图标右键 → 设置，填入你的 OpenAI 兼容 API（Base URL / Key / 模型名）。默认适配小米 MiMo。

长文本划词会在弹窗里给出四个动作与一个「输入你的需求」入口，后者打开独立对话窗口（划词内容作为上下文，支持多轮与历史回顾）。

## 注意

- 首次运行 Windows 可能弹出 SmartScreen 提示，属正常现象（未签名）
- 沙箱/受限环境下若出现白屏，主进程已内置 `in-process-gpu` 兜底
