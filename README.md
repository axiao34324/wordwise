# WordWise — 划词即时 AI 释义

Windows 桌面常驻程序：在**任意应用**（微信、Word、浏览器、PDF……）中用鼠标选中一段文字，**无需任何额外操作**，选区旁立即弹出 AI 释义。

灵感来自夸克浏览器划词工具栏，但省掉了"再点一次功能按钮"这一步。

## 特性

- **全局划词**：基于 `selection-hook` 原生插件（全局鼠标钩子），取词三层降级：UI Automation TextPattern → IAccessible → 模拟 Ctrl+C（自动保存并还原剪贴板）
- **零动作弹窗**：无焦点置顶弹窗（`focusable: false` + `screen-saver` 层级），不打断当前操作
- **选区定位**：弹窗出现在选区末尾下方，物理像素 → DIP 自动换算，支持多显示器与高 DPI
- **流式输出**：SSE 流式渲染，光标跟随闪烁，高度自适应
- **LRU 缓存**：最近 500 条释义本地持久化，划同一个词秒出
- **可视化配置**：API 地址 / 模型 / 提示词 / 温度 / max_tokens / 冷却时间等全部可在设置界面调整

## 技术栈

Electron 31 + selection-hook（N-API 原生模块）+ Node 原生 https（OpenAI 兼容 Chat Completions API）

```
├── main.js              # 主进程：托盘常驻、全局钩子、弹窗定位
├── lib/llm.js           # LLM 调用（Node https 直连 + SSE 流式解析）
├── lib/store.js         # 设置持久化
├── lib/cache.js         # LRU 释义缓存
├── popup.html           # 释义弹窗 UI
├── settings.html        # 设置界面
└── preload*.js          # contextBridge 安全桥接
```

## 使用

```bash
npm install
npm start
```

托盘图标右键 → 设置，填入你的 OpenAI 兼容 API（Base URL / Key / 模型名）。默认适配小米 MiMo。

## 注意

- 首次运行 Windows 可能弹出 SmartScreen 提示，属正常现象（未签名）
- 沙箱/受限环境下若出现白屏，主进程已内置 `in-process-gpu` 兜底
