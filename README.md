# Arknights code

<p align="center">
  <strong>一个自带明日方舟界面的桌面 AI Agent</strong><br>
  以《明日方舟》阿米娅等干员为主题形象，封装 Claude Code CLI 
  本程序是基于https://github.com/liebaojun/MakoCode这个大佬的成果，已经和作者取得联系获得授权，感谢！
</p>
<img width="2558" height="1365" alt="屏幕截图 2026-07-11 163621" src="https://github.com/user-attachments/assets/116fcb11-9132-45f2-9fd4-3d2bb89b3d06" />



<p align="center">
  <a href="#-features">✨ 功能</a> •
  <a href="#-quick-start">🚀 快速开始</a> •
  <a href="#-installation">📦 安装</a> •
  <a href="#-tech-stack">🔧 技术栈</a> •
  <a href="#-license">📄 协议</a>
</p>

---
<img width="2559" height="1368" alt="屏幕截图 2026-07-11 163637" src="https://github.com/user-attachments/assets/47fb4ce5-806d-45c5-8a4f-3e23dcc29597" />


## ✨ Features

### 🎮 Galgame 沉浸界面
- **角色立绘系统**：阿米娅 / 羽毛笔干员
- **动态位置状态机**：说话者居中放大，听者侧移缩小，平滑过渡
- **场景背景**：明日方舟主题场景（罗德岛 / 维多利亚 / 乌萨斯 / 拉特兰 等），淡入淡出
- **BGM 系统**：自带120+音乐且可以接入网易云
- **思考气泡**：AI 思考时弹出角色风格俏皮话气泡
- **打字机效果**：逐字显示 + Markdown 渲染 + KaTeX 公式支持
- <img width="390" height="785" alt="屏幕截图 2026-07-11 163650" src="https://github.com/user-attachments/assets/9b806b52-f0f6-4cb8-99a1-986a6f5442e4" />

  

### 🔀 多 LLM 后端
一键切换 9 家 AI 供应商（DeepSeek / Anthropic / OpenRouter / 硅基流动 / 阿里百炼 / 火山方舟 / 腾讯混元 / Kimi / 百度千帆），可在设置面板中一键填充预设。

### 🧙 首次配置向导
- 自动检测 Node.js / Git / Claude Code 安装状态
- 一键后台静默安装（可内嵌 Node.js + Git 安装包）
- API 配置 + 连接测试
- 供应商预设弹窗一键填充

### ✏️ 角色定制
- 内置人设 Markdown 编辑器（主设定 + 扩展设定双标签）
- 支持修改角色性格、说话风格、世界观背景
- 保存后新会话生效（切换干员会自动开启全新会话并重新注入人设）

### 📂 新手友好
- 设置面板一键打开 Skills / 插件文件夹
- 文件上传（图片/文档/代码等，50MB 限制）
- 快捷指令（输入 `/` 触发）
- 输入框自动扩展（多行支持）
- 存档系统（自动 + 手动 + 多槽位）




## 🚀 Quick Start

### 方式一：下载安装器（推荐）
从 [Releases](../../releases) 下载最新 `Arknights code-Setup x.x.x.exe`，双击安装。

安装器会引导你完成：
1. 自动检测并安装 Node.js / Git / Claude Code
2. 配置 API（需自备 DeepSeek 或其他 LLM API Key）
3. 测试连接 → 进入阿米娅的世界

### 方式二：从源码运行

```bash
# 1. 克隆仓库
git clone https://github.com/liebaojun/makocode.git
cd makocode

# 2. 安装依赖
npm install

# 3. 配置 API Key
cp mako-settings.example.json mako-settings.json
# 编辑 mako-settings.json，填入你的 API Key

# 4. 启动
npm start
```

**前置要求**：Node.js ≥ 18、Git、Claude Code CLI（`npm install -g @anthropic-ai/claude-code`）

---

## 📦 Installation

### 构建安装器

```bash
npm run build        # 完整 NSIS 安装器 → release/
npm run build:dir    # 仅解压版（调试用）
```

构建产物位于 `release/` 目录，文件名为 `Arknights code-Setup-<version>.exe`。

> ⚠️ **关于 Electron 运行时**：仓库默认使用 `npm install` 安装的 Electron 进行构建。
> 如果你希望固定使用本地已下载的 Electron（例如离线构建），可在 `package.json` 的
> `build` 段加回 `"electronDist": "local-electron"`，并把对应版本的 Electron 解压到
> `local-electron/` 目录（该目录已被 `.gitignore` 忽略，不会进入仓库）。

### 安装器包含

| 组件 | 说明 |
|------|------|
| Arknights code 源码 + 资源 | 含立绘 / BGM / 语音 / 界面 |
| Node.js 安装包（可选内嵌） | 自动安装 |
| Git 安装包（可选内嵌） | 自动安装 |
| Claude Code CLI | 在线下载（npm 全局安装） |

---

## 🔧 Tech Stack

| 层面 | 技术 |
|------|------|
| 桌面框架 | Electron |
| 前端 | 原生 HTML + CSS + JavaScript（零框架） |
| 后端 | Node.js HTTP Server（零外部依赖） |
| AI 引擎 | Claude Code CLI |
| 构建/分发 | electron-builder + NSIS |
| 自动更新 | electron-updater (GitHub Releases) |
| Markdown | marked.js |
| 公式 | KaTeX |
| 语音 | 预生成 WAV |

### 项目结构

```
makocode/
├── electron-main.js      # Electron 主进程（启动后端 / 窗口 / 自动更新）
├── server.js             # HTTP 后端（聊天 / 设置 / 存档 / 音乐）
├── preload.js            # Electron 桥接
├── galchat.html          # 主界面（对话 / 角色 / BGM）
├── wizard.html           # 首次配置向导
├── package.json          # 项目 + 构建配置
├── lib/                  # 共享模块
│   ├── constants.js      #   全局常量
│   ├── utils.js          #   工具函数
│   ├── settings.js       #   设置管理
│   ├── installer.js      #   后台安装
│   └── llm-presets.js    #   LLM 供应商预设
├── assets/               # 游戏资源
│   ├── sprites/          #   角色立绘
│   ├── backgrounds/      #   场景背景
│   ├── bgm/              #   背景音乐
│   └── voice/            #   语音
├── operators/            #   干员人设 Markdown（阿米娅.md / 羽毛笔.md ...）
├── scripts/              #   辅助脚本（api-test / cleanup / verify ...）
└── release/              # 构建输出（不在仓库中）
```

---

## ⚠️ 重要提示

### 版权声明
本软件中的角色立绘、背景音乐、背景图片等素材来自 **《明日方舟》（Arknights）**，版权归 **鹰角网络（Hypergryph）** 所有。这些素材仅用于粉丝非商业用途。若权利人提出要求，将立即移除。

### AI 生成内容
本软件使用 AI 大语言模型生成对话内容，其输出可能包含不准确或不适当的信息。用户应自行判断。

### API 费用
使用本软件需要自备 LLM API Key（如 DeepSeek），可能产生 API 调用费用。

---

## 📄 License

- **代码**：MIT License
- **素材**：版权归鹰角网络（Hypergryph）所有，仅限非商业用途

详见 [LICENSE](LICENSE) 文件。
