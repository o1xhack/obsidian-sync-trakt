# 設定指南

> 🌐 [English](../SETUP.md) · [简体中文](SETUP.zh-CN.md) · **繁體中文** · [日本語](SETUP.ja.md)

把 Sync Trakt 接入你帳號的完整流程：建立 Trakt OAuth 應用、申請選填的 TMDB / OMDb API key、設定外掛、跑第一次同步。

## 1. Trakt — 建立 OAuth 應用

讓外掛能授權存取你的 Trakt 帳號必備。

1. 在 [Trakt](https://app.trakt.tv) 登入（免費帳號即可）
2. 開啟 [Create API application](https://app.trakt.tv/settings/apps/api/new)
3. 填表：
   - **Name** —— 隨便填，比如 `Sync Trakt`
   - **Redirect URIs** —— 必須**嚴格**填 `urn:ietf:wg:oauth:2.0:oob` ⚠️ —— 這是裝置授權流程的固定字串，差一個字元 Connect 會直接 401
   - **Description / JavaScript (CORS) origins** —— 選填，留空即可
4. 點 **Create**。頁面會顯示 **Client ID** 和 **Client Secret**（點 Secret 旁邊的眼睛圖示顯示）

之後隨時可以回 [API Applications 頁面](https://app.trakt.tv/settings/apps/api)，點你的應用查看這兩個值。

## 2. TMDB — 申請 v3 API key

建議用於 **TMDB 海報圖片**和完整的**元數據本地化**。沒填 TMDB key 時外掛還能透過 Trakt 翻譯端點本地化；設定 OMDb key 後也可以取得海報。

1. 在 <https://www.themoviedb.org/signup> 註冊（免費）
2. **驗證信箱** —— 沒驗證的話申請 API key 那步過不去，檢查收件匣 / 垃圾郵件
3. 開啟 <https://www.themoviedb.org/settings/api> → **Create** → 選 **Developer**
4. 同意條款後填表：
   - **Application Name** —— 比如 `Obsidian personal`
   - **Application URL** —— 任何有效 URL，比如 `https://github.com/你的使用者名` 或 `https://obsidian.md`。**不能留空**
   - **Application Summary** —— 一句話，比如 *"Personal use: enrich Obsidian notes with TMDB metadata and posters"*
   - 聯絡資訊 —— 用真實信箱
5. 提交。頁面立刻顯示兩個值：
   - **API Key (v3 auth)** —— 32 位十六進位字串。**這是外掛需要的**
   - **API Read Access Token (v4 auth)** —— JWT。本外掛不用，忽略

之後可以在 <https://www.themoviedb.org/settings/api> 隨時查看 v3 key。

## 2b. OMDb —— 選填的海報回退

如果你想在沒有 TMDB key 時取得海報，或補充 TMDB 沒有圖片的項目，可以加入 OMDb。

1. 開啟 <https://www.omdbapi.com/apikey.aspx>
2. 選擇 **FREE!**，填寫信箱、姓名和簡短的個人用途說明
3. 在 OMDb 寄來的信件中啟用 key

免費 key 每天最多 1,000 次請求。專用高解析度 Poster API 僅供 Patreon 使用者使用，因此 Sync Trakt 使用一般標題資料 API 傳回的圖片；解析度和圖片可用性因項目而異。查詢必須有 Trakt 提供的 IMDb ID。成功查詢（包括已知沒有海報的結果）會快取 90 天。OMDb 內容按 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 發布。

## 3. 設定外掛

裝好外掛後（見 [README → Install](README.zh-TW.md#-安裝)），開啟 **設定 → Sync Trakt**。

### Authentication

1. 把第 1 步拿到的 **Trakt client ID** 和 **Trakt client secret** 貼上
2. 點 **Connect** —— 彈窗顯示一個 `trakt.tv/activate` 的連結和一個 8 位使用者碼
3. 在瀏覽器裡開啟連結、登入 Trakt、貼上使用者碼、點 **Continue**
4. 彈窗自動關閉；**Connection status** 變成 **Traktr connected**

### 元數據與海報

5. 把第 2 步拿到的 **API key (v3 auth)** 貼上
6. 選填：貼上第 2b 步拿到的 **OMDb API key**
7. 選 **Poster source** —— 一般保持 `Auto (TMDB → OMDb)`；**Poster size** 用 `w500` 即可

### Localization（選填）

8. **Metadata language** —— 選預設（比如 `Chinese (Traditional, Taiwan)` 對應 `zh-TW`）或選 **Custom** 輸入任意 BCP 47 代碼。保持 `Default` 就一切英文
9. **Plugin UI language** —— `English` 或 `简体中文`。影響設定面板、命令面板、提示彈窗
10. **Note template language** —— 選預設筆記範本的語言。如果你目前範本沒改過，切換此選項會自動改寫範本

### Sync sources —— 選要同步的來源

11. **Sync watchlist** —— 你想看的內容（預設 ON）
12. **Sync favorites** —— 你標記為收藏的內容（預設 ON）
13. **Sync watch history** —— 你看過的內容，帶播放次數和最近觀看時間（預設 OFF；資料量可能大）
14. **Sync watch history (detailed)** —— 透過 `{{watch_history}}` 在筆記正文裡加每集（或每部電影）觀看時間戳。**只在 Sync watch history 開啟時顯示**。（預設 OFF；對大庫使用者顯著變慢 —— Trakt 的 `/sync/history` 端點每頁 100 條觀看事件）
15. **Sync ratings** —— 你打過 1-10 分的內容（預設 OFF）

### 跑第一次同步

16. 命令面板（Ctrl/Cmd+P）→ **Traktr: Sync**

第一次測試建議**只勾 Sync watchlist** —— 多數人 watchlist < 100 條，跑得快。

## 故障排除

### Connect 報 401

99% 的情況：Trakt OAuth 應用的 Redirect URI 錯了。必須嚴格是 `urn:ietf:wg:oauth:2.0:oob`。回 [API Applications 頁面](https://app.trakt.tv/settings/apps/api)，點你的應用，改這個欄位，儲存，再點 Connect。

### TMDB 拒絕 API key 申請

常見原因：

- 信箱沒驗證 —— 檢查收件匣 / 垃圾郵件
- Application URL 留空了 —— TMDB 即使個人用也要求填 URL
- 拒絕信件裡通常會說具體原因 —— 看一下

### 同步耗時很長

如果你的帳號有幾千個項目，第一次同步可能要好幾分鐘。後續同步也是全量重抓所有資料（API 層目前沒增量），耗時主要在 API 請求上，不是檔案 IO。

如果開了 **Sync watch history (detailed)**，會更慢 —— Trakt 的 history 端點每個觀看事件一條記錄，每頁 100 條。

### 和上游 `sarimabbas/traktr` 共存

外掛 ID 不同（`obsidian-sync-trakt` vs `traktr`）→ 裝在不同資料夾，OS 層不衝突。**但**兩個預設的 `Notes folder`（`trakt`）和 `Property prefix`（`trakt_`）都一樣，同時跑會互相覆蓋筆記。要並行用就把其中一個的 `Notes folder` 改成不一樣的。

### 之後從哪裡再找到這些 token

| Token | URL |
|---|---|
| Trakt client ID + secret | [Trakt API Applications](https://app.trakt.tv/settings/apps/api) → 點你的應用 |
| TMDB API key (v3 auth) | <https://www.themoviedb.org/settings/api> |
| OMDb API key | OMDb 啟用郵件；需要重新申請時開啟 <https://www.omdbapi.com/apikey.aspx> |

Trakt access token 自動更新，你不用管。TMDB API key 不會過期。
