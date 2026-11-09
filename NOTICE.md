# NOTICE

## 这个仓库是什么

`dsh-douyin-agent` 的二次开发分支，版本 1.5.0。
上游：<https://github.com/LockyBee/dsh-douyin-agent>，MIT 授权，版权声明
`Copyright (c) 2026 LockyBee and contributors`，见 [LICENSE](LICENSE)。

本分支保留上游的全部版权与授权声明，没有删除任何一条。
上游的独立桌面软件（`desktop/`）、安装脚本（`install-native.ps1`）和测试目录不在本仓库内，本仓库只提供 DSH 插件这一种用法。

## 本分支改了什么

**新增的模块（12 个）**

| 文件 | 作用 |
| --- | --- |
| `comment-reader.mjs` | 读当前作品评论区，取回评论文本、作者与稳定标识 |
| `comment-reply.mjs` | 「回复某一条评论」的真发通道，带发前护栏、发后复核、额度台账 |
| `comment-guard.mjs` | 评论动作闸门：同作品不重复、超限就停、状态可疑就退 |
| `comment-voice.mjs` | 生成评论时提供给模型的语气与口癖 |
| `ocr-service.mjs` | 本地 OCR 读画面文字 |
| `dm-policy.mjs` | 私信策略：白名单、去重、频率上限 |
| `outbound-service.mjs` | 对外发送的统一出口，串起护栏、收据与人工核对 |
| `fullscreen-guard.mjs` | 全屏状态保护，避免误点 |
| `mention-watch.mjs` | 翻自己作品评论区找「有人 @ 我」的消息并回复 |
| `notify-human.mjs` | 需要人接手时通知本机 |
| `usage-bill.mjs` | 按官方价目表统计实际请求与 token 花费 |
| `browser-auto-launch.mjs` | 浏览器窗口缺席时自动拉起专用 Edge |

**改过的模块（16 个）**

`api-agent.mjs`、`autonomous-watch.mjs`、`browser-host.mjs`、`chat-agent.mjs`、`chat-browser.mjs`、`chat-service.mjs`、`comment-browser.mjs`、`core.mjs`、`daily-report.mjs`、`dsh-plugin.mjs`、`native-settings.mjs`、`public-comment-agent.mjs`、`scheduled-watch.mjs`、`tool-definitions.mjs`、`video-forward.mjs`、`watch-mode.mjs`

改动集中在：把评论回复链路的护栏补齐、接入 OCR 与本地语音转写、给私信加策略层、把发送结果统一走收据与人工核对、新增用量与花费统计。

**脱敏与可移植性**

- 去掉了所有写死的本机绝对路径，改成环境变量或 `$DSH_HOME` / `~/.dsh` 推导：
  - `api-agent.mjs` 的 `DEFAULT_QQ_ROOT` 现在默认空（不再读任何外部 `.env`）
  - `runtime-paths.mjs` / `persona-memory.mjs` 的遗留路径改成 `DOUYIN_LEGACY_MEMORY_DB` / `DOUYIN_LEGACY_ROLE_CARD` 环境变量
  - `qq-sync.mjs` 的默认库路径改成基于 `homedir()`
  - `chat-agent.mjs` 的共享记忆文件改成 `DOUYIN_SHARED_MEMORY_FILE` 或 `$DSH_HOME/shared-memory/`
- 抹去了原来的人格名与昵称，替换为中性的「助手」；默认群聊响应昵称与 `@` 关键词改成可配置（`DOUYIN_MENTION_NAMES`）
- 运行数据（`state/`）、密钥（`media/.env`）、模型文件都不在仓库里，见 [.gitignore](.gitignore)

## 原创的部分

- 上面 12 个新增模块与 16 个模块里的改动
- `scripts/verify.mjs`：一次纯本地的语法体检

## 第三方

见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)（Playwright、MiMo、MiniMax、voice vendor 等各自的授权与来源）。

## 隐私边界

仓库里没有：真实 API Key、Cookie、登录资料、私信与联系人记录、观看历史、人格卡原文。
插件运行时把数据写在 `$DSH_HOME/douyin-browser/` 下面，不进版本库。
