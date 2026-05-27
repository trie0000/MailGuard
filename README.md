# MailGuard

メール送信前の AI 誤送信チェッカー。

`.eml` / `.msg` (= Outlook で保存した下書きメール) をブラウザにドラッグ&ドロップすると、
**宛先・本文の整合性を AI と決定論ルールでチェック** し、誤送信の可能性をスコアリングして表示します。

```
[Outlook で返信下書き作成]
   ↓
[ファイル → 名前を付けて保存 で .eml / .msg として保存]
   ↓  ドラッグ&ドロップ
[MailGuard ブラウザ画面]
   ↓
[2 段防衛チェック]
   A 段: 決定論ルール (= 内部混入 / タイポ / 機密外部 / 宛名不一致 / etc)
   B 段: AI 意味解析 (= 宛名 vs To / 話題 vs 過去履歴 / 固有名詞 vs ドメイン)
   ↓
[リスク レポート + 改善提案]
   ↓
[利用者が判断 → Outlook に戻って送信 or 修正]
```

## 特徴

- **単一 HTML ファイル**で配布 (= ローカル保存して開くだけ)
- **パース完全ローカル**: ブラウザ内で eml/msg を構造化、本文を外部に漏らさない
- **AI 呼出しのみ relay 経由**: 社内 AI ゲートウェイ (Azure OpenAI 互換) に転送
- **モデル選択可**: 設定モーダルで Relay URL / モデル / 自社ドメイン 等を保存
- **2 段防衛**: AI に頼り切らず、決定論ルールでも独立に検出

## 検出パターン (例)

### 決定論ルール (A 段、ゼロコスト)
- 外部宛なのに Cc に内部メンバー混入
- 既知タイポ ドメイン (`gmial.com` 等)
- 機密キーワード × 外部宛
- 本文冒頭の宛名 (= 「○○様」) と To の名前ミスマッチ
- 件名のチケット タグと本文中の言及タグの不一致
- 引用履歴の参加者ドメインと新 To のドメイン乖離

### AI 解析 (B 段、文脈ベース)
- 本文の話題が引用履歴と連続しているか
- 本文の固有名詞 (会社名 / 製品名) が To と整合するか
- 文体・敬語レベルが過去スレッドと一貫しているか
- 「うっかり別案件への返信」の検出

## ビルド

```bash
npm install
npm run build           # → dist/mailguard.html (単一ファイル) を生成
```

## 開発

```bash
npm run dev             # esbuild --watch + http://localhost:5180
```

## relay (loopback プロキシ) を起動する

ブラウザは CORS の制約で外部 AI API を直接呼べないので、loopback プロキシ
(= relay) を経由します。

| OS | 実装 | 起動方法 |
|---|---|---|
| **Windows** | `relay/mailguard-relay.ps1` (PowerShell 5.1+) | `start-relay.bat` ダブルクリック |
| **Mac / Linux** | `relay/mac-relay.mjs` (Node.js) | `./start-relay.sh` |

**依存パッケージなし** — Windows なら PowerShell だけ、Mac/Linux なら Node.js
だけで動きます。`npm install` は不要 (= 依存ライブラリゼロ)。

### Windows での起動

1. PowerShell 5.1 以上が入っていることを確認 (= Windows 10/11 はデフォルトで OK)
2. リポジトリをクローン or ZIP ダウンロード → 解凍
3. `start-relay.bat` をダブルクリック
4. 黒いウィンドウに以下が出れば成功:

```
  📨 MailGuard relay (PowerShell)
  -----------------------------------------
  Listen  : http://127.0.0.1:18100/
  設定方針 : API キー / 上流 URL / プロバイダ は ブラウザ UI から送信
  ...
  Ctrl+C で停止
```

### Mac / Linux での起動 (= relay 同梱)

### ① relay を起動

通常は **ブラウザ UI で API キー / 上流 URL / プロバイダ を指定する** ため、relay は引数なしで起動するだけで OK:

```bash
npm run relay
```

**社内プロキシ経由が必要な場合** (= 多くの企業環境):

```bash
export MAILGUARD_AI_PROXY=http://proxy.example.com:8080
npm run relay
```

**ポート変更** (デフォルト 18100):

```bash
export MAILGUARD_AI_PORT=18200
npm run relay
```

**ブラウザ UI 設定を省略して env で固定したい場合** (= 共有運用用):

```bash
export MAILGUARD_AI_PROVIDER=claude
export MAILGUARD_AI_TARGET=https://api.anthropic.com
export MAILGUARD_AI_KEY=sk-ant-...
npm run relay
```

これらの env var を `.env` ファイルに書いておけば `npm run relay` だけで毎回読み込まれます (= `.env.example` 参照)。

起動すると以下が表示されます (Anthropic の例):

```
📨 MailGuard Mac/Linux relay
─────────────────────────────────────────
Listen   : http://127.0.0.1:18100
Provider : Anthropic (Claude)
Upstream : https://api.anthropic.com
API key  : ✓ configured (sk-ant-…)
推奨モデル: claude-sonnet-4-5 / claude-haiku-4-5 / claude-opus-4-5
─────────────────────────────────────────
```

### ② MailGuard を開く

```bash
# 別ターミナルで dev サーバ起動 (file:// で開いてもよい)
npm run dev
# → http://localhost:5180/ にアクセス

# あるいは
open dist/mailguard.html
```

ブラウザで MailGuard が開いたら **右上「⚙ 設定」**:
- **Relay URL**: `http://127.0.0.1:18100`
- **Model**: `gpt-4o-mini` (= デフォルト) / `gpt-4o` 等
- **API Key**: (空のままで OK = relay が上流に転送)
- **自社ドメイン**: 例 `example.co.jp, example.com`

### ③ メールを取り込んでテスト

メール下書きの渡し方は **3 通り** ('A' 〜 'C' のいずれか):

**A. .eml / .msg ファイルをドラッグ&ドロップ** (= 通常パターン)
- Outlook → ファイル → 名前を付けて保存 → eml/msg 形式 → 出来たファイルをブラウザにドロップ

**B. Mac Outlook で「メッセージのソースを貼り付け」** ★ Mac Outlook 推奨
- Mac Outlook はドラッグでブラウザに `.eml` を渡せないため、こちらが確実:
  1. メール選択 → メニュー「**表示** → **メッセージのソース**」(キーボード: ⌥⌘U)
  2. 表示されたソース ウィンドウで **⌘A → ⌘C** で全選択コピー
  3. MailGuard 画面の **下部の枠** (= 「もしくは、メール本文をここに貼り付け…」) に **⌘V** で貼り付け
  - もしくは画面のどこでも **⌘V** で OK (= グローバル paste 受付済み)

**C. Apple Mail.app からドラッグ** (= 動く環境もあり)
- Mail.app のメッセージ一覧から直接ドラッグして MailGuard ドロップ枠へ

完了後、プレビュー表示 → **「🤖 AI で誤送信チェック」** ボタン。

## 配布

`dist/mailguard.html` を配ればそれで完結。利用者は:
- ローカルに保存 → ダブルクリックでブラウザで開く
- もしくは社内 SharePoint / 共有フォルダに配置 → URL でアクセス

社内利用時は Spira の `spira-ai-relay.ps1` (Windows) を流用するか、
本ツールの `relay/mac-relay.mjs` (Node) をサーバに常駐させる構成も可能。

## 設定

初回起動時に右上「⚙ 設定」から:
- **Relay URL**: `http://127.0.0.1:18100` (デフォルト)
- **Model**: 使用する AI モデル ID (= `gpt-4o-mini` 等)
- **API Key**: relay 構成によっては不要
- **自社ドメイン**: 内部メンバー判定に使用 (= 設定しないと内部混入チェックが無効)
- **機密キーワード**: 本文に出現 + 外部宛で high リスク扱い

設定は `localStorage` に永続化。

## ライセンス

Apache License 2.0
