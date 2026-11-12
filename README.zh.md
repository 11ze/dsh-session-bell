# dsh-session-bell

DeepSeek Harness 的桌面通知插件。

回合结束、或有提问等你回答时，弹一条系统通知。发送方是 DeepSeek Harness 本体，
不是外部助手应用。点通知直接跳到发起该通知的会话。

## 行为

| 事件 | 通知内容 |
| --- | --- |
| 回合结束（`agent/turn-stopping`） | 会话标题 + 最后一条回复正文 |
| 有提问等回答（`user-questions/request`） | 会话标题 + 问题正文 |

- 所有会话都通知；子代理会话不通知，其父回合照常通知。
- 按会话键去重：同一会话的新通知替换旧横幅。
- 点击：聚焦窗口，并在会话面板选中该会话。

## 要求

- DeepSeek Harness 且启用 Web GUI（桌面版或 `dsh web`）。
- 窗口必须开着：通知由页面发出，窗口关闭时不发。
- macOS 需允许 DeepSeek Harness 发通知。若一直不弹，去“系统设置 → 通知 →
  DeepSeek Harness”打开。

## 安装

在 DeepSeek Harness 打开 设置 → 插件 → 安装 Bundle，填入：

```
dsh-session-bell
```

首次装好后刷新一次页面（⇧⌘R）。宿主半装完即生效，页面半是浏览器模块，只在新页面加载。

## 原理

一个路由，两半。

1. 宿主半（`index.js`）监听 `agent/turn-stopping` 和 `user-questions/request`，
   把事件写成 `/session-bell/events` 上的 Server-Sent Events。没有 Web 服务时不注册
   路由，CLI 下静默。
2. 页面半（`client.js`）订阅该路由，用页面自带 `Notification` 构造通知，点击时调用
   `ctx.uiWorkspace.openSession(sessionId)`。

路由只带会话 id、标题、截断后的正文、事件类型。没有配置项，没有网络外发。

## 本地开发

把目录当 bundle 装进 profile，然后改宿主半要重启插件、改页面半要刷新页面：

```
plugin_manager install_bundle  <本目录绝对路径>
plugin_manager set_plugin      include:session-bell  enabled:false
plugin_manager set_plugin      include:session-bell  enabled:true
```

## 发布

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) 在每次推 `main` 时运行，
只有当 `package.json` 的版本在 npm 上还不存在时才发布。用 npm trusted publishing（OIDC），
仓库里不存 token，并附带 provenance。

1. 改版本号，补 CHANGELOG 条目。
2. 推 `main`。

```bash
npm version patch          # 或 minor、major
git push --follow-tags
```

npmjs.com 上要做一次设置：包 → Settings → Trusted publishing，填本仓库与工作流文件名
`publish.yml`。没配的话任务会以 `ENEEDAUTH` 失败。

## 目录

| 路径 | 作用 |
| --- | --- |
| `index.js` | 宿主半：事件转 SSE |
| `client.js` | 页面半：发通知、点击开会话 |
| `cordis.patch.yml` | bundle 补丁，插入宿主行 |
| `locale/*.json` | 插件管理器的标题与描述 |
| `icon.svg` | 插件管理器图标 |

## 许可

MIT
