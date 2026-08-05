# Video Metadata Cleaner

<img width="1288" height="807" alt="2026-08-05 19 28 35" src="https://github.com/user-attachments/assets/5f0c0917-7a4b-4bc8-a697-c630849581e2" />

macOS 向けのデスクトップアプリです。動画を**再エンコードせず**にコンテナを再ラップし、一般メタデータ・ストリームメタデータ・チャプター・C2PA / JUMBF などを引き継がずに書き出します。

映像・音声ストリーム自体は `-c copy` のままコピーするため、画質・音質は変わりません。

## できること

- MP4 / MOV / M4V のメタデータ削除（ロスレス remux）
- 複数ファイルの一括処理
- ドラッグ＆ドロップ、またはファイル選択ダイアログで追加
- 処理前後のメタデータを ExifTool で表形式比較（**必須**）
- 出力は元ファイルと同じ場所の `cleaned/` フォルダ（元ファイルは変更しない）

## 必要なもの

| ツール | 用途 |
|--------|------|
| [Node.js](https://nodejs.org/)（LTS 推奨） | フロントエンド / Tauri CLI |
| [Rust](https://www.rust-lang.org/)（`rustup` 推奨） | Tauri バックエンド |
| [FFmpeg](https://ffmpeg.org/) | 実処理（Homebrew 推奨） |
| [ExifTool](https://exiftool.org/) | メタデータ確認・処理前後比較（**必須**） |
| Xcode Command Line Tools | macOS のリンク・署名まわり |

```bash
# Xcode Command Line Tools（未導入なら）
xcode-select --install

# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Node は公式インストーラ / nvm / mise 等で用意

# FFmpeg / ExifTool（Homebrew の例）— どちらも必須
brew install ffmpeg
brew install exiftool
```

`rustup` を入れた直後のシェルでは、一度だけ次を実行するか、ターミナルを開き直してください（以降は通常不要です）。

```bash
source "$HOME/.cargo/env"
```

`rustc --version` が通るなら PATH は既に通っています。毎回実行する必要はありません。

バージョン確認:

```bash
node -v
npm -v
rustc --version
cargo --version
ffmpeg -version | head -1
exiftool -ver
```

## セットアップ

```bash
git clone https://github.com/<your-account>/video-metadata-cleaner.git
cd video-metadata-cleaner

npm install
```

### FFmpeg sidecar の配置（必須）

Tauri は外部バイナリを **sidecar** として呼びます。システムに入っている `ffmpeg` を、ターゲットトリプル付きの名前で `src-tauri/binaries/` にコピーします。

```bash
./scripts/copy-local-ffmpeg.sh
```

スクリプトは次を行います。

1. PATH 上の `ffmpeg` と `rustc` を確認
2. `rustc` からホストのターゲットトリプルを取得
3. 次のパスへコピーして実行権限を付与

| アーキテクチャ | 配置先 |
|----------------|--------|
| Apple Silicon | `src-tauri/binaries/ffmpeg-aarch64-apple-darwin` |
| Intel Mac | `src-tauri/binaries/ffmpeg-x86_64-apple-darwin` |

`tauri.conf.json` 側の指定は拡張子・トリプルなしです。

```json
{
  "bundle": {
    "externalBin": ["binaries/ffmpeg"]
  }
}
```

`src-tauri/binaries/ffmpeg-*` は `.gitignore` 対象です。クローン後は毎回（または FFmpeg 更新後に）スクリプトを再実行してください。

> Homebrew 版 FFmpeg は Homebrew 配下の dylib に動的リンクされていることが多いです。  
> **ローカル開発・実行用**であり、他環境へ `.app` ごと渡す用途には向きません。

## 開発ビルド（GUI 起動）

```bash
npm run tauri dev
```

初回は Rust 依存の取得とコンパイルで数分かかることがあります。

内部では概ね次が行われます。

1. `beforeDevCommand` で Vite 開発サーバ起動（既定: `http://localhost:1420`）
2. Rust 側を debug プロファイルでビルド
3. デスクトップウィンドウを表示（フロントのホットリロードあり）

フロントだけ確認する場合（Tauri / FFmpeg なし）:

```bash
npm run dev
```

※ この場合、ファイルダイアログや `clean_video` などネイティブ API は動きません。

## リリースビルド

最適化バイナリ / `.app` を作る場合:

```bash
# sidecar が無い・古い場合は先に
./scripts/copy-local-ffmpeg.sh

npm run tauri build
```

成果物の典型的な場所:

```text
src-tauri/target/release/bundle/macos/Video Metadata Cleaner.app
src-tauri/target/release/bundle/dmg/   # 設定により生成される場合あり
```

起動例:

```bash
open "src-tauri/target/release/bundle/macos/Video Metadata Cleaner.app"
```

補足:

- `npm run build` だけではフロント（`tsc` + Vite → `dist/`）のみです。デスクトップアプリにはなりません。
- リリース `.app` にも sidecar の FFmpeg が入りますが、**Homebrew 由来の動的リンクのままでは他環境では動かない可能性が高い**です。
- そのため **第三者への配布・App Store 向けリリースは想定していません。** ローカル実行用の成果物として使ってください。
- コード署名や notarization が必要な場合は Developer ID で各自対応してください（本 README では手順化しません）。

### よくあるビルド失敗

| 症状 | 対処 |
|------|------|
| `ffmpeg が見つかりません` | `brew install ffmpeg` のあと `./scripts/copy-local-ffmpeg.sh` |
| `rustc が見つかりません` | rustup 導入後、ターミナルを開き直すか `source "$HOME/.cargo/env"` |
| `icon.png: No such file` | `src-tauri/icons/` が無い。`npm run tauri icon path/to/1024.png` で生成 |
| sidecar 関連エラー | `ls src-tauri/binaries/` でトリプル付きバイナリがあるか確認 |
| リンク / SDK エラー | `xcode-select --install` または CLT の再インストール |
| `exiftool が見つかりません` / 起動時に必須バナー | `brew install exiftool` のあとアプリを再起動、またはバナーの「再確認」 |

## 使い方

1. `npm run tauri dev`（または build した `.app`）を起動
2. 動画をドラッグ＆ドロップ、または「動画を選択」
3. 「クリーンアップ」を実行
4. 出力は `元ファイルと同じディレクトリ/cleaned/`
5. クリーンアップ後、ExifTool による処理前後比較が自動表示される（「メタデータ確認」でも再表示可）

| 操作 | 意味 |
|------|------|
| 上書きモード | オフ（既定）: `cleaned/` に新規保存。オン: 元ファイルを一時ファイル経由で置き換え（実行前に確認ダイアログ） |
| 完了をリストから外す | 一覧から完了ジョブだけを外す。**ファイルは削除しない** |
| メタデータ確認 | 必須の `exiftool` でタグを表表示 |
| Finder で表示 | 出力ファイルの場所を開く |

## 実際に走らせている FFmpeg コマンド

引数はフロントから組み立てず、Rust 側に固定しています。

```bash
ffmpeg -hide_banner -nostdin -y -i INPUT \
  -map 0:v -map '0:a?' -map '0:s?' \
  -c copy \
  -map_metadata -1 \
  -map_metadata:s -1 \
  -map_chapters -1 \
  -fflags +bitexact \
  -metadata encoder= \
  OUTPUT
```

- `-c copy` … 再エンコードなし
- `-map_metadata -1` / `-map_metadata:s -1` … ファイル・ストリームメタデータを捨てる
- `-map_chapters -1` … チャプターを捨てる
- `+bitexact` / `encoder=` … 余計な encoder 情報の書き込みを抑える

## 処理結果の確認

```bash
exiftool -G1 -a -s "path/to/original.mp4"
exiftool -G1 -a -s "path/to/cleaned/video.mp4"
```

消えていてほしい例: `JUMBF`、`CBOR`、`C2PA`、生成 AI 由来の署名・コメントなど。  
残るもの: 解像度、コーデック、フレームレート、再生時間など再生に必要な情報。

## セキュリティ設計

- React から呼べるコマンドは `clean_video` と `inspect_metadata` に限定
- FFmpeg の引数は Rust 側固定。フロントから任意コマンドを渡せない
- パスは引数配列として渡し、シェル経由にしない
- `inspect_metadata` はローカル `exiftool` を固定引数で実行するだけ

## 技術スタック

- [Tauri 2](https://tauri.app/)
- React + TypeScript + Vite
- FFmpeg（システムにインストールしたものを sidecar として利用）
- ExifTool（必須・メタデータ確認）

## ライセンス

### 本プロジェクト（Video Metadata Cleaner）

ソースコード・ドキュメントは **[MIT License](./LICENSE)** です。

- 商用・非商用を問わず、利用・改変・再配布・有償販売ができます
- 再配布時は、著作権表示と MIT の全文を残してください
- 作者は本ソフトウェアについて保証しません（無保証）

### FFmpeg について（第三者ソフトウェア）

本アプリは実行時に **FFmpeg** を呼び出して動画を処理します。  
FFmpeg は本プロジェクトの著作物ではなく、FFmpeg プロジェクトおよびその貢献者の著作物です。

| 項目 | 方針 |
|------|------|
| Git リポジトリへの同梱 | **しない**（`src-tauri/binaries/ffmpeg-*` は gitignore） |
| 開発時 | 利用者が自分の Mac に入れた FFmpeg を、`./scripts/copy-local-ffmpeg.sh` でローカルにコピーして使う |
| 配布用ビルド | **FFmpeg を同梱した配布は想定しない**（README の「リリースビルド」もローカル用） |

FFmpeg 自体のライセンスは、ビルドの内容によって **LGPL** または **GPL** などになります（Homebrew 版などもビルド設定次第です）。  
本アプリはストリームを `-c copy` するだけで、GPL 寄りのエンコーダを組み込む必要はありませんが、**手元の FFmpeg バイナリをアプリと一緒に他人へ配る場合**は、次を利用者自身で確認・遵守してください。

1. その FFmpeg が LGPL / GPL のどちらでビルドされているか
2. ソース提供・ライセンス表記・動的リンクなど、再配布時に必要な義務
3. 依存する共有ライブラリ（dylib）の再配布条件

公式情報: [https://ffmpeg.org/legal.html](https://ffmpeg.org/legal.html)

### ExifTool

本アプリの実行に **ExifTool は必須** です（処理前後のメタデータ比較に使用）。  
バイナリはリポジトリに含めず、利用者が別途インストールします（例: `brew install exiftool`）。  
ライセンスは ExifTool 側の条件に従ってください。

## 注意

- 重要なファイルは事前にバックアップしてください
- コンテナやツールによって、残るメタデータの見え方が異なる場合があります
- C2PA 等の削除が利用規約やポリシーに反しないかは、利用者の責任で判断してください
