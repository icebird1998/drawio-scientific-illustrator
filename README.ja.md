# Draw.io Scientific Illustrator

[English](README.md#english-guide) · [中文](README.md#中文说明) · 日本語 · [MIT License](LICENSE)

Draw.io Scientific Illustrator は、AI エージェントが**画面に表示されている draw.io デスクトップのキャンバス上で、科学図をリアルタイムに描画できる** Codex プラグインです。図形、ラベル、矢印、スタイル、レイアウトが一つずつ現れる様子を確認できます。このライブワークフローは、ローカルホスト専用の MCP サーバーを通じて draw.io 自身のグラフ API を呼び出します。OS のマウスやキーボードは自動操作せず、先に XML を作成して後から開くだけの方式でもありません。

> 状況：Windows ではテスト済みです。macOS と Linux の実行ファイル検出にも対応していますが、draw.io/Electron のパッケージ構成によってライブ動作が異なる場合があります。動作報告や Pull Request を歓迎します。

## 日本語ガイド

### このリポジトリに含まれるもの

- `drawio-live` MCP サーバー：画面に表示される draw.io デスクトップエディターを起動または接続し、アクティブなグラフモデルをリアルタイムに編集します。
- `drawio-file-utils` MCP サーバー：保存済みの `.drawio` ドキュメントを検証し、PNG、SVG、PDF、JPG の成果物としてエクスポートします。
- Codex Skill：参照画像の確認、編集可能な基本要素への分解、進行速度を調整した描画、セクションごとの視覚的なレビュー、ライブグラフの調整をエージェントに指示し、表示中の図が完成した後にのみ保存します。
- 完全なプラグインを一つの単位としてインストールできる、リポジトリ内の Codex Marketplace。

したがって、このリポジトリは **MCP の実装**であると同時に **Codex プラグイン**でもあります。MCP は呼び出し可能なツールを提供し、プラグインは MCP サーバー、Skill、表示用メタデータをまとめたインストール可能なパッケージです。

### 必要要件

1. プラグインに対応した Codex デスクトップアプリまたは Codex CLI。
2. ローカルにインストールされた [draw.io デスクトップ版](https://www.drawio.com/)。
3. Git。
4. バンドルされた Codex ランタイム外で MCP サーバーを実行する場合、`node` として利用可能な Node.js。Node.js 22 以降を推奨します。

このプラグインは、Windows、macOS、Linux における一般的な draw.io のインストール場所を自動検出します。独自の場所にインストールしている場合は、Codex を起動する前に実行ファイルを指す `DRAWIO_PATH` を設定してください。

### インストール — 最も簡単な方法

#### Codex にインストールを依頼する

ターミナルにアクセスできる Codex タスクへ、次の内容を貼り付けます。

```text
Install the public Codex plugin from https://github.com/icebird1998/drawio-scientific-illustrator.
Clone it locally, register its repository root as a Codex marketplace, install
drawio-scientific-illustrator@drawio-scientific-tools, then tell me when to restart Codex.
```

#### Windows 用ワンコマンドインストーラー

最初に [`install.ps1`](install.ps1) を確認してから、次を実行します。

```powershell
$p="$env:TEMP\drawio-scientific-install.ps1"; Invoke-WebRequest https://raw.githubusercontent.com/icebird1998/drawio-scientific-illustrator/main/install.ps1 -OutFile $p; powershell -ExecutionPolicy Bypass -File $p
```

#### macOS/Linux 用ワンコマンドインストーラー

最初に [`install.sh`](install.sh) を確認してから、次を実行します。

```bash
curl -fsSL https://raw.githubusercontent.com/icebird1998/drawio-scientific-illustrator/main/install.sh | bash
```

インストール後は Codex を再起動し、新しいタスクを開始して、新しい Skill と MCP ツールを読み込んでください。

### インストール — 手動で確認可能な方法

```bash
git clone https://github.com/icebird1998/drawio-scientific-illustrator.git
cd drawio-scientific-illustrator
codex plugin marketplace add "$(pwd)"
codex plugin add drawio-scientific-illustrator@drawio-scientific-tools
```

PowerShell では `"$(pwd)"` を `(Get-Location).Path` に置き換えます。

```powershell
git clone https://github.com/icebird1998/drawio-scientific-illustrator.git
Set-Location drawio-scientific-illustrator
codex plugin marketplace add (Get-Location).Path
codex plugin add drawio-scientific-illustrator@drawio-scientific-tools
```

### 使い方

1. インストール後に Codex を再起動し、新しいタスクを作成します。
2. 参照画像として PNG、JPEG、SVG、またはレンダリング済みの PDF ページを添付します。
3. **Draw.io Scientific Illustrator** と指定するか、入力欄でプラグインを選択します。
4. 希望する描画間隔と出力形式を指定します。

> **複雑な科学図を再描画する場合に推奨する Codex 設定：** **GPT-5.6 Sol** を選択し、推論レベルを **Max** に設定してください。Codex の設定で、まず 6 段階の推論レベル選択を有効にする必要があります。既定の 5 段階の選択肢には Max が表示されません。この設定により、応答時間とトークン使用量が増える場合があります。

推奨プロンプト：

```text
Use Draw.io Scientific Illustrator. Launch the live draw.io canvas and recreate this
reference scientific figure step by step with a 100 ms delay. Control only draw.io's
own graph API; do not use OS mouse/keyboard automation and do not generate XML first.
Keep all labels, arrows, panels, and legends editable. Visually inspect and refine each
section, then save the final .drawio file and export a 2000 px PNG preview.
```

中国語のプロンプトも同様に利用できます。

```text
使用 Draw.io Scientific Illustrator。启动实时 draw.io，以 100 ms 的步骤间隔重绘
这张参考图。必须直接控制 draw.io 画布，不要使用系统鼠标键盘控制，也不要先生成
XML。文字、箭头、分区和图例都要可编辑；完成后保存 .drawio 并导出 2000 px PNG。
```

### ライブツールのワークフロー

通常、エージェントは次の順序でツールを使用します。

1. `drawio_live_launch` — 画面に表示される draw.io エディターを起動するか、既存のエディターへ接続します。
2. `drawio_live_status` — グラフの準備ができていることを確認します。
3. `drawio_live_add_shape`、`drawio_live_add_edge`、または進行速度を調整できる `drawio_live_draw_sequence` — 編集可能な内容を画面上で構築します。
4. `drawio_live_screenshot` — 論理的なセクションごとに draw.io のレンダリング結果を確認します。
5. `drawio_live_inspect` と `drawio_live_update_cell` — ラベル、スタイル、位置、サイズを修正します。
6. `drawio_live_fit` — 作成中の図が画面内に収まるようにします。
7. `drawio_live_save_snapshot` — すでに画面に表示されているグラフを `.drawio` としてシリアライズします。
8. `drawio_validate` と `drawio_export` — 成果物を検証してエクスポートします。

### 設定

任意で使用できる環境変数：

| 変数 | 用途 | 既定値 |
|---|---|---|
| `DRAWIO_PATH` | draw.io 実行ファイルの明示的なパス | 自動検出 |
| `DRAWIO_LIVE_PORT` | ローカルホストの優先デバッグポート | `9333`。使用中の場合は付近の空きポートを選択 |
| `DRAWIO_LIVE_PROFILE` | draw.io/Electron 専用プロファイルディレクトリ | `~/.drawio-live-mcp/<port>` |

Windows での例：

```powershell
$env:DRAWIO_PATH = "D:\Apps\draw.io\draw.io.exe"
```

### 更新

同じインストーラーをもう一度実行してください。インストーラーは fast-forward の `git pull` を実行してプラグインを再インストールします。その後、Codex を再起動して新しいタスクを開始してください。

### トラブルシューティング

- **`node` が見つからない**：Node.js 22 以降をインストールするか、Codex ランタイムから Node をプラグインの MCP サーバーへ公開できることを確認します。
- **draw.io が見つからない**：デスクトップアプリをインストールするか、`DRAWIO_PATH` を設定します。
- **ポートがすでに使用されている**：ポートを明示的に指定しなければ、サーバーが付近の空きポートを選択します。または `DRAWIO_LIVE_PORT` を空いているポートに設定します。
- **グラフの準備ができない**：プラグインが起動した古い draw.io ウィンドウを閉じてから再試行し、デスクトップアプリが Electron のリモートデバッグフラグを受け付けることを確認します。
- **プラグインが表示されない**：インストール後に Codex を再起動し、新しいタスクを作成します。
- **エクスポートに失敗する**：draw.io デスクトップ版で同じファイルを手動エクスポートできることと、出力ディレクトリへ書き込めることを確認します。

### セキュリティとプライバシー

- ライブデバッグエンドポイントは公開ネットワークインターフェイスではなく、`127.0.0.1` にバインドします。
- 対象の検出では draw.io/diagrams.net と識別されたページだけを受け付け、任意のブラウザページには接続しません。
- このプラグインは OS レベルのマウスやキーボードの自動操作を行いません。
- テレメトリやホスト型バックエンドは含まれていません。詳しくは [PRIVACY.md](PRIVACY.md) を参照してください。
- 信頼できるリポジトリとリビジョンからのみソフトウェアをインストールしてください。インストーラースクリプトは実行前に確認してください。

### 既知の制限

- ライブ API は現在、編集可能な draw.io の基本要素を主な対象としています。高密度な顕微鏡画像、写真、ヒートマップ、複雑なプロットには、将来、専用のライブ画像挿入操作が必要になる場合があります。
- 再現精度は、参照画像の解像度と、内容を draw.io の基本要素でどの程度表現できるかに左右されます。
- v1.0.0 では Windows がテスト済みです。コミュニティでのテストが進むまで、macOS/Linux のサポートはベストエフォートです。

## コントリビューション

Issue と Pull Request を歓迎します。オペレーティングシステム、draw.io のバージョン、Codex のバージョン、再現手順、関連する MCP のエラー内容を記載してください。機密情報を含む参照画像はアップロードしないでください。

## ライセンス

MIT © 2026 [icebird1998](https://github.com/icebird1998)
