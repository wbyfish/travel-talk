# 旅遊會話

離線可用的旅遊會話練習 PWA。純 HTML/CSS/JS，不需要 build。

## 本機預覽

```bash
python3 -m http.server 8765
```

## 新增語言包（例如日文、韓文）

1. 在 `data/` 新增一個 JSON 檔，格式跟 `data/en-dublin.json` 一樣：
   - `lang`：語音用的語言代碼（`ja-JP`、`ko-KR`…）
   - `me`：代表「你」的角色名稱（對話裡這個角色會出現在右邊，角色扮演時會被遮住）
   - `scenes[]`：`parts[].lines` 是 `[角色, 句子]`，`vocab` 是 `[原文, 中文]`，`notes` 是 `[標題, 說明]`
2. 在 `data/packs.json` 加一行。
3. 在 `sw.js` 的 `FILES` 加上新檔案，並把 `VERSION` 改成新的值（手機才會更新快取）。
