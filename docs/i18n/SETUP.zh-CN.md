# 配置指南

> 🌐 [English](../SETUP.md) · **简体中文** · [繁體中文](SETUP.zh-TW.md) · [日本語](SETUP.ja.md)

把 Sync Trakt 接入你账号的完整流程：创建 Trakt OAuth 应用、申请可选的 TMDB / OMDb API key、配置插件、跑第一次同步。

## 1. Trakt — 创建 OAuth 应用

让插件能授权访问你的 Trakt 账号必备。

1. 在 [Trakt](https://app.trakt.tv) 登录（免费账号即可）
2. 打开 [Create API application](https://app.trakt.tv/settings/apps/api/new)
3. 填表：
   - **Name** —— 随便填，比如 `Sync Trakt`
   - **Redirect URIs** —— 必须**严格**填 `urn:ietf:wg:oauth:2.0:oob` ⚠️ —— 这是设备授权流程的固定字符串，差一个字符 Connect 会直接 401
   - **Description / JavaScript (CORS) origins** —— 可选，留空即可
4. 点 **Create**。页面会显示 **Client ID** 和 **Client Secret**（点 Secret 旁边的眼睛图标显示）

之后随时可以回 [API Applications 页面](https://app.trakt.tv/settings/apps/api)，点你的应用查看这两个值。

## 2. TMDB — 申请 v3 API key

推荐用于 **TMDB 海报图片**和完整的**元数据本地化**。没填 TMDB key 时插件还能通过 Trakt 翻译端点本地化；配置 OMDb key 后也可以获取海报。

1. 在 <https://www.themoviedb.org/signup> 注册（免费）
2. **激活邮箱** —— 没激活的话申请 API key 那步过不去，检查收件箱 / 垃圾邮件
3. 打开 <https://www.themoviedb.org/settings/api> → **Create** → 选 **Developer**
4. 同意条款后填表：
   - **Application Name** —— 比如 `Obsidian personal`
   - **Application URL** —— 任何有效 URL，比如 `https://github.com/你的用户名` 或 `https://obsidian.md`。**不能留空**
   - **Application Summary** —— 一句话，比如 *"Personal use: enrich Obsidian notes with TMDB metadata and posters"*
   - 联系信息 —— 用真实邮箱
5. 提交。页面立刻显示两个值：
   - **API Key (v3 auth)** —— 32 位十六进制串。**这是插件需要的**
   - **API Read Access Token (v4 auth)** —— JWT。本插件不用，忽略

之后可以在 <https://www.themoviedb.org/settings/api> 随时查看 v3 key。

## 2b. OMDb —— 可选的海报回退

如果你想在没有 TMDB key 时获取海报，或补充 TMDB 没有图片的条目，可以添加 OMDb。

1. 打开 <https://www.omdbapi.com/apikey.aspx>
2. 选择 **FREE!**，填写邮箱、姓名和简短的个人用途说明
3. 在 OMDb 发来的邮件中激活 key

免费 key 每天最多 1,000 次请求。专用高分辨率 Poster API 仅供 Patreon 用户使用，因此 Sync Trakt 使用普通标题数据 API 返回的图片；分辨率和图片可用性因条目而异。查询必须有 Trakt 提供的 IMDb ID。成功查询（包括已知没有海报的结果）会缓存 90 天。OMDb 内容按 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 发布。

## 3. 配置插件

装好插件后（见 [README → Install](README.zh-CN.md#-安装)），打开 **设置 → Sync Trakt**。

### Authentication

1. 把第 1 步拿到的 **Trakt client ID** 和 **Trakt client secret** 粘贴进去
2. 点 **Connect** —— 弹窗显示一个 `trakt.tv/activate` 的链接和一个 8 位用户码
3. 在浏览器里打开链接、登录 Trakt、粘贴用户码、点 **Continue**
4. 弹窗自动关闭；**Connection status** 变成 **Traktr connected**

### 元数据与海报

5. 把第 2 步拿到的 **API key (v3 auth)** 粘贴进去
6. 可选：粘贴第 2b 步拿到的 **OMDb API key**
7. 选 **Poster source** —— 一般保持 `Auto (TMDB → OMDb)`；**Poster size** 用 `w500` 即可

### Localization（可选）

8. **Metadata language** —— 选预设（比如 `Chinese (Simplified, China)` 对应 `zh-CN`）或选 **Custom** 输任意 BCP 47 代码。保持 `Default` 就一切英文
9. **Plugin UI language** —— `English` 或 `简体中文`。影响设置面板、命令面板、提示弹窗
10. **Note template language** —— 选默认笔记模板的语言。如果你当前模板没改过，切换此选项会自动改写模板

### Sync sources —— 选要同步的来源

11. **Sync watchlist** —— 你想看的内容（默认 ON）
12. **Sync favorites** —— 你标记为收藏的内容（默认 ON）
13. **Sync watch history** —— 你看过的内容，带播放次数和最近观看时间（默认 OFF；数据量可能大）
14. **Sync watch history (detailed)** —— 通过 `{{watch_history}}` 在笔记正文里加每集（或每部电影）观看时间戳。**只在 Sync watch history 开启时显示**。（默认 OFF；对大库用户显著变慢 —— Trakt 的 `/sync/history` 端点每页 100 条观看事件）
15. **Sync ratings** —— 你打过 1-10 分的内容（默认 OFF）

### 跑第一次同步

16. 命令面板（Ctrl/Cmd+P）→ **Traktr: Sync**

第一次测试建议**只勾 Sync watchlist** —— 多数人 watchlist < 100 条，跑得快。

## 故障排查

### Connect 报 401

99% 的情况：Trakt OAuth 应用的 Redirect URI 错了。必须严格是 `urn:ietf:wg:oauth:2.0:oob`。回 [API Applications 页面](https://app.trakt.tv/settings/apps/api)，点你的应用，改这个字段，保存，再点 Connect。

### TMDB 拒绝 API key 申请

常见原因：

- 邮箱没激活 —— 检查收件箱 / 垃圾邮件
- Application URL 留空了 —— TMDB 即使个人用也要求填 URL
- 拒绝邮件里通常会说具体原因 —— 看一下

### 同步耗时很长

如果你的账号有几千个条目，第一次同步可能要好几分钟。后续同步也是全量重拉所有数据（API 层目前没增量），耗时主要在 API 请求上，不是文件 IO。

如果开了 **Sync watch history (detailed)**，会更慢 —— Trakt 的 history 端点每个观看事件一条记录，每页 100 条。

### 和上游 `sarimabbas/traktr` 共存

插件 ID 不同（`obsidian-sync-trakt` vs `traktr`）→ 装在不同文件夹，OS 层不冲突。**但**两个默认的 `Notes folder`（`trakt`）和 `Property prefix`（`trakt_`）都一样，同时跑会互相覆盖笔记。要并行用就把其中一个的 `Notes folder` 改成不一样的。

### 之后从哪里再找到这些 token

| Token | URL |
|---|---|
| Trakt client ID + secret | [Trakt API Applications](https://app.trakt.tv/settings/apps/api) → 点你的应用 |
| TMDB API key (v3 auth) | <https://www.themoviedb.org/settings/api> |
| OMDb API key | OMDb 激活邮件；需要重新申请时打开 <https://www.omdbapi.com/apikey.aspx> |

Trakt access token 自动刷新，你不用管。TMDB API key 不会过期。
