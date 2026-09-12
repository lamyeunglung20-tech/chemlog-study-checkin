# CHEMLOG 化學研習誌

CHEMLOG 是為學生設計的化學科留校溫習打卡 Web App。學生可以記錄每日溫習時間、使用倒數計時、上載學習開始及結束相片，並在排行榜互相鼓勵。

## 功能

- 電郵認證及 Google 登入
- 倒數計時與手動輸入溫習時數
- 每週、本月及累計溫習統計
- 可點選的最近七天圖表
- 學習開始／結束相片
- 自訂學生頭像
- 本週、本月及總時數排行榜
- 查看及刪除個人打卡紀錄

## 公開網站

- https://chemlog-study-check-in.web.app/
- https://chemlog-study-checkin.locthanghai3.chatgpt.site/

## 本機開發

需要 Node.js 22 或以上版本。

```bash
pnpm install
pnpm dev
```

正式建置：

```bash
pnpm build
```

## 資料與私隱

使用者的私人打卡內容及學習相片受 Firebase Authentication 與 Firestore 規則保護。排行榜只向已驗證使用者顯示學生名稱、頭像及溫習時數，不公開電郵或私人打卡內容。

Designed by LYL
