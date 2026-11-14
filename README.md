# MiniMax CN Tokens for CodexBar

[![Test](https://github.com/tangwz/codexbar-plugin-minimax/actions/workflows/test.yml/badge.svg)](https://github.com/tangwz/codexbar-plugin-minimax/actions/workflows/test.yml)

用于 [CodexBar](https://github.com/steipete/CodexBar) 的独立 JavaScript 提供商插件，显示 MiniMax 中国区 Coding Plan 订阅的配额和服务端报告的真实 Token 统计。无需修改或编译 CodexBar。

## 支持范围

- 仅支持 MiniMax 中国区 Coding Plan 订阅。
- 通过 CodexBar 的浏览器会话接口自动读取 Cookie；同一个会话必须同时包含 `_token` 和 `minimax_group_id_v2`。
- 显示当前时段和每周配额，以及重置时间；配额单位与真实 Token 数量分别展示。
- 显示今日总量、输入、输出、缓存读取、缓存写入 Token，以及最近 30 个中国自然日中已报告数据的合计和每日柱状图。
- 不要求输入订阅 Key，不支持用 API Key 查询 Token 历史，也不读取其他区域的会话。

这是社区插件，使用 MiniMax 控制台的内部只读接口，接口或 Cookie 结构变化可能导致插件暂时不可用。

## 安装

需要支持本地 JavaScript 提供商插件的 CodexBar；当前本机验证版本为 **0.84.0**。插件运行不依赖 Node.js，只有开发测试需要 Node.js。

1. 下载 [minimax-cn-tokens.js](https://raw.githubusercontent.com/tangwz/codexbar-plugin-minimax/main/minimax-cn-tokens.js)。
2. 在 CodexBar 的 **Settings → Plugins → Install…** 中选择该文件。
3. 核对权限后批准并启用 **MiniMax CN Tokens**：网络来源仅为 `https://www.minimax.cn`，Cookie 域仅为 `www.minimax.cn`，能力为 `browser-cookies` 和 `http-status`。
4. 确保 CodexBar 的浏览器 Cookie 自动导入已开启，并在支持的浏览器中登录 [MiniMax 中国区控制台](https://platform.minimax.cn)。
5. 刷新插件，在菜单栏的提供商选择中打开 **MiniMax CN Tokens**。

也可以手动复制插件，再到 Plugins 中刷新目录、批准并启用：

```sh
git clone https://github.com/tangwz/codexbar-plugin-minimax.git
cd codexbar-plugin-minimax
mkdir -p "$HOME/.config/codexbar/providers"
cp minimax-cn-tokens.js "$HOME/.config/codexbar/providers/minimax-cn-tokens.js"
```

更新同名插件文件后，先点击 Plugins 页面顶部的目录 **Refresh** 重新载入代码，再点击插件自己的 **Refresh** 查询用量。只点击插件内的刷新可能继续使用旧实例。

## 会话与数据行为

插件每次刷新都向 CodexBar 请求浏览器会话，配额和 Token 请求使用同一份 Cookie 与同一 group。它不会跨浏览器或账号拼接凭据，也不保存 Cookie、令牌或 group，不输出这些值。

浏览器中存在更新后的完整会话时，后续刷新可直接读取，无需手动复制 Cookie。插件不会自行续期 MiniMax 的登录会话；登录失效后仍需在浏览器重新登录。当前不从 localStorage 恢复 group，也不支持缺少 group Cookie 的会话。

查询仅访问以下两个固定接口：

| 接口 | 用途 |
| --- | --- |
| `GET https://www.minimax.cn/backend/account/token_plan/remains_percent` | 订阅配额，必须成功 |
| `GET https://www.minimax.cn/backend/account/token_plan/usage_summary` | 真实 Token 历史，可选 |

Token 统计按中国时区 UTC+8 的自然日展示，可能存在服务端更新延迟。缓存读取量包含在输入量中，不会再次累加。缺失字段显示 `—`，不会补成零或用配额反推 Token。

最近 30 天的合计仅累加接口实际报告的日期，并标明报告天数；缺失日期不会补零。若某天总量未知、同日数据冲突或合计超出支持的整数范围，合计显示 `—`。数值文本保持整数精度，图表使用近似数值绘制。

如果 Token 接口失败，插件会保留已成功读取的配额，并在 Tokens 中显示 `Unavailable`。没有最近 30 天的日期记录时显示 `Not reported`。

## 常见状态

| 状态 | 处理方式 |
| --- | --- |
| `No complete MiniMax China session found` | 确认浏览器自动导入已开启，并登录中国区控制台；会话需要同时具备两个 Cookie。不要把 Cookie 粘贴到 Issue 中。 |
| `MiniMax China rejected the browser session` | 在浏览器重新登录后刷新。 |
| 配额正常、Tokens 为 `Unavailable` | Token 历史请求或响应格式不可用；稍后刷新，配额仍可使用。 |
| 今日 Token 为 `—` | 当天记录或对应字段尚未报告，不代表零用量。 |
| 替换文件后仍出现旧错误 | 先刷新插件目录，再刷新插件用量。 |

浏览器 Cookie 能力由 CodexBar App 提供，CLI 不提供等价的用户插件浏览器会话抓取能力；请在 App 中验证本插件。

## 开发与验证

Node.js 22 或更新版本即可，无需安装依赖：

```sh
npm run check
npm test
```

25 项离线检查使用合成会话和模拟 HTTP 响应，不读取浏览器，不访问网络。覆盖会话与 group 绑定、认证失败后的候选遍历、可选历史失败、取消和网络错误、配额语义、整数精度、日期边界、缺失字段以及重复数据。

截至 2026-11-14：本机 CodexBar 0.84.0 已识别、批准并启用插件，配额刷新不再报错；真实 Token 明细和日图在菜单中的显示仍待人工确认。离线测试通过不等于已经完成所有真实账号显示验证。
