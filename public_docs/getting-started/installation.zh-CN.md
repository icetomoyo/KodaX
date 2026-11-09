# 安装

## 快速安装（npm）

```bash
npm i -g @kodax-ai/kodax

# 选择任意一个有 API Key 的提供商（`kodax setup --help` 列出所有提供商）：
export ZHIPU_API_KEY=...        # ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY /
                                # KIMI_API_KEY / KIMI_CODE_API_KEY / QWEN_API_KEY /
                                # QWEN_TOKEN_API_KEY / ZHIPU_CODING_API_KEY /
                                # ZAI_CODING_API_KEY / MINIMAX_CODING_API_KEY /
                                # MIMO_API_KEY / MIMO_CODING_API_KEY / ARK_CODING_API_KEY

kodax
```

进入 REPL 后用自然语言提问即可。如果没有支持的 API Key 环境变量，KodaX 仅打印各平台配置说明后退出，不创建配置文件，也不收集 Key。设置变量后，关闭当前终端，重新打开一个，再运行 `kodax`。

如需重新运行配置向导，使用 `kodax setup`；添加自定义提供商使用 `kodax setup --custom`；查看完整帮助使用 `kodax setup --help`。

## 单文件二进制（无需 Node.js）

从 [GitHub Releases](https://github.com/icetomoyo/KodaX/releases) 页面下载 Bun 编译的单文件二进制，支持 Windows / macOS / Linux × x64 + arm64。下载一个文件，到处运行——受限环境、CI Runner、隔离主机均可。

## 从源码构建

```bash
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX
npm install
npm run build
npm link
```

## 环境要求

- **Node.js** >= 20.0.0（npm 安装 / 源码构建所需；单文件二进制不需要）
- **TypeScript** >= 5.7.0（仅源码构建所需；根目录使用 5.9.x）
- 任意一个受支持 LLM 提供商的 API Key

## 下一步

- [快速开始](./quickstart.zh-CN.md) — 你的第一次 KodaX 会话
- [提供商与 API Key](../configuration/providers.zh-CN.md) — 全部内置提供商
- [自定义提供商](../configuration/custom-providers.zh-CN.md) — 接入任意 OpenAI/Anthropic 兼容端点
