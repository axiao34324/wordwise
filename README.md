# WordWise — 划词即时 AI 释义

Windows 桌面常驻程序：在**任意应用**（微信、Word、浏览器、PDF……）中用鼠标选中一段文字，**无需任何额外操作**，选区旁立即弹出 AI 释义。

灵感来自夸克浏览器划词工具栏，但省掉了"再点一次功能按钮"这一步。

## 特性

- **全局划词**：基于 `selection-hook` 原生插件（全局鼠标钩子），取词三层降级：UI Automation TextPattern → IAccessible → 模拟 Ctrl+C（自动保存并还原剪贴板）
- **零动作弹窗**：无焦点置顶弹窗（`focusable: false` + `screen-saver` 层级），不打断当前操作
- **按长度分流**：≤15 字直接出释义；超过阈值先给动作选择（解释 / 总结 / 翻译 / 润色），确认后才发请求
- **自定义追问**：长文本可打开独立对话窗口，划词内容作为上下文多轮提问；会话落盘，随时从「历史对话」回顾继续
- **Markdown 渲染**：对话结果支持代码块、列表、标题、引用等，流式输出
- **账号与订阅**：注册/登录、每日额度、订阅码兑换；免费版与订阅版可用模型不同
- **两种使用方式**：官方通道（开箱即用，Key 在服务端）或自带 Key（你自己的 OpenAI 兼容服务）
- **四套主题**：深岩 / 宣纸 / 石墨 / 青瓷，原生标题栏与滚动条跟着一起变
- **英语词库**：划选英文单词可一键收录，支持筛选与导出 CSV
- **待办**：划词点「＋待办」零输入收下原文与来源，事后按主题整理、搜索、追问、回顾，导出 Markdown
- **选区定位**：弹窗出现在选区末尾下方，物理像素 → DIP 自动换算，支持多显示器与高 DPI
- **LRU 缓存**：最近 500 条结果本地持久化（按「动作 + 原文」为键），重复查询秒出

## 技术栈

Electron 31 + selection-hook（N-API 原生模块）+ Node 原生 https（OpenAI 兼容 Chat Completions API）

```
├── main.js               # 主进程：托盘常驻、全局钩子、弹窗定位、各窗口
├── lib/llm.js            # LLM 调用（Node https 直连 + SSE 流式解析 + 动作提示词）
├── lib/official.js       # 官方通道配置（服务地址、应用令牌、模型白名单）
├── lib/account.js        # 账号：注册/登录、令牌持久化、额度与兑换
├── lib/store.js          # 设置持久化
├── lib/cache.js          # LRU 结果缓存
├── lib/conversations.js  # 对话会话持久化（最多 60 条）
├── lib/vocab.js          # 英语词库持久化
├── lib/todos.js          # 待办持久化（主题、去重指纹、状态、Markdown 导出）
├── lib/foreground.js     # 取前台窗口标题，给待办补"这段从哪来"
├── popup.html            # 弹窗 UI（选择 / 结果 / 额度引导）
├── chat.html             # 对话窗口（Markdown 渲染 + 历史面板）
├── account.html          # 账号与订阅界面
├── vocab.html            # 英语词库界面
├── todo.html             # 待办界面（分组、搜索、追问、回顾）
├── settings.html         # 设置界面
├── theme.css             # 四套主题变量
├── gateway/              # 转发服务（后端，见 gateway/README.md）
├── tools/                # 界面预览截图、端到端测试脚本
└── preload*.js           # contextBridge 安全桥接
```

## 使用

```bash
npm install
npm start
```

默认走**官方通道**，装完即可划词，无需配置。额度用完或想要更强的模型时，托盘右键 →
「账号与订阅」登录或兑换订阅码。想接自己的服务，在设置里选「自带 Key」。

命令行参数（也方便做桌面快捷方式）：`--account` 启动即打开账号页，`--todo` 打开待办。

## 后端

客户端不持有任何上游 API Key —— 所有模型请求都发到 `gateway/`（自建转发服务），
由它带上游密钥转发，并负责账号、额度与套餐权限。详见 [gateway/README.md](gateway/README.md)。

## 待办

解决的是「现在不能处理，但又不该忘」这一类事情：网页调研到一半发现一个想深挖的
线索、读书时碰到一个想查清的概念、看到一句想回头再想的话。这类东西的共同点是
**处理它就要打断当前的事**，而不记下来就会忘。

所以它的设计原则和普通待办清单相反：

- **捕获零输入**：划词 → 点「＋待办」→ 完。不填标题、不选分类、不定日期。
  原文和来源（程序名 + 窗口标题）自动带，标题从原文首句取
- **不消耗额度**：存待办只是抄一段文字，不调模型，随便存
- **不制造负债**：没有截止日期、没有优先级、没有连续打卡。默认只看未完成，
  「归档」用来放下不感兴趣的，归档不等于删除
- **回来能接上**：展开一条，能直接「追问」（带着原文开对话）或「回顾」
  （让模型说清这段在讲什么、值得往哪儿深挖 —— 这一步才花额度，由你决定值不值）
- **调研天然成簇**：默认落「收件箱」，可以事后把几条归到同一个主题

数据存在本机 `%APPDATA%/wordwise/todos.json`，不上传；导出为 Markdown 便于贴进
Obsidian / Notion。

## 测试

```bash
# 官方通道端到端（真实请求 + 令牌 + 额度核对）
npx electron tools/test-llm.js

# 账号模块端到端（注册/登录/兑换/权限）
npx electron tools/test-account.js

# 待办数据层（去重、分组、搜索、导出、清理归档）
npx electron tools/test-todos.js

# 界面截图（不开托盘，假数据渲染，capturePage 存图）
npx electron tools/preview.js account.html out.png rock user 460 660
# 第 7 个参数是截图前跑的一段 JS，可以先把界面点到想拍的状态
npx electron tools/preview.js todo.html out.png rock open 540 720 "document.querySelectorAll('.item')[0].click()"

# 页面 DOM 断言（比截图可靠，用来验证置灰、文案之类）
npx electron tools/check-dom.js settings.html "JSON.stringify([...document.querySelectorAll('#officialModel option')].map(o=>o.disabled))"
```

## 注意

- 首次运行 Windows 可能弹出 SmartScreen 提示，属正常现象（未签名）
- 沙箱/受限环境下若出现白屏，主进程已内置 `in-process-gpu` 兜底
- 账号数据目前存在后端的 JSON 文件里，多实例部署前需换成数据库
