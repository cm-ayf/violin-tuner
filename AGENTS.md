# このリポジトリで作業するエージェント向けのガイド

このファイルはリポジトリ全体に適用する。利用者向けの概要と最小限の起動手順は [README.md](README.md) に置き、実装・保守上の詳細はここに記載する。

バージョンや実装の値については、それぞれの設定ファイル・コードを正とする。設計や実行手順を変更した場合は、このガイドも関連する範囲で更新する。README を作業記録や詳細な内部仕様で膨らませない。

## 1. プロジェクトの目的

- 日本語 UI のバイオリンチューナー PWA。音声解析は端末内の Web Audio / Web Worker / Rust・WASM で完結する。
- A = 442 Hz を基準とする純正五度で調弦する。平均律の周波数表や A = 440 Hz に置き換えない。
- 対象は G / D / A / E の4弦。全弦の検出状態を表示しながら、着目する1弦を大きく表示する。
- マイク入力を録音・保存・外部送信する機能はない。解析のためにサーバーや外部 API を追加しない。
- マイクをスピーカーへ接続しない。ハウリングを防ぐため、解析ノードから音声出力先への接続は意図的に行っていない。
- 公開先は GitHub Pages の `/violin-tuner/` 配下。ルートパス `/` への配備を前提にしない。

## 2. 構成と変更箇所

- [src/App.vue](src/App.vue)：チューナーの表示、弦の選択、開始・停止操作、PWA 更新通知、コンポーネント CSS。
- [src/style.css](src/style.css)：グローバルなフォント・リセット・ページ枠・フォーカス表示。
- [src/tuner.ts](src/tuner.ts)：マイク、AudioContext、Worker、Wake Lock のライフサイクル。
- [src/tuning.ts](src/tuning.ts)：フレームサイズ、基準周波数、メッセージ型、解析結果の復号と表示用ヘルパー。
- [src/audio.worker.ts](src/audio.worker.ts)：WASM の初期化、解析要求の処理、結果・エラーの通知。
- [crates/tuner/src/lib.rs](crates/tuner/src/lib.rs)：DSP、検出閾値、着目弦の自動選択、Rust のテスト。
- [crates/tuner/package.json](crates/tuner/package.json)：Rust / WASM の実コマンドと `@violin-tuner/dsp` の公開エントリー。
- [vite.config.ts](vite.config.ts)：アプリのタスク依存関係、Vize、Worker、PWA、テスト・lint・format 設定。
- [crates/tuner/vite.config.ts](crates/tuner/vite.config.ts)：Rust パッケージ内のタスク依存関係。
- [Cargo.toml](Cargo.toml)：Cargo workspace とリリースプロファイル。
- [rust-toolchain.toml](rust-toolchain.toml)：Rust ツールチェーン、コンポーネント、WASM ターゲット。
- [tsconfig.json](tsconfig.json)：TypeScript の厳格な型検査と Vize Content Mapper。
- [public/icon.svg](public/icon.svg)：PWA アイコンの唯一の画像ソース。

### JavaScript / TypeScript の構成

- パッケージ管理は pnpm、インストールとタスク実行の入口は Vite+ の `vp`。
- Node.js / pnpm の要件はルートの [package.json](package.json) の `devEngines` を参照する。`engines` や別のバージョンファイルへ要件を重複させない。
- [pnpm-workspace.yaml](pnpm-workspace.yaml) でアプリと `crates/*` を monorepo として扱う。
- Vue SFC のビルドには Vize を使い、型検査にも `vize` の Content Mapper を使う。ビルドプラグインだけでなく型検査側の設定も維持する。
- `vite` は Vite+ core への npm alias。Vite 本体のバージョン番号と Vite+ のバージョン番号を同一視しない。
- TypeScript / Vite / Vitest の overrides、Vite の peer dependency 設定、Vize 関連のリリース経過時間の例外は workspace 設定にある。依存更新時に確認する。
- npm や別の lockfile を追加しない。pnpm の lockfile は `vp install` で更新する。

### Rust / WASM の構成

- ルートは仮想 Cargo workspace。メンバーは `crates/tuner`。
- リリースの LTO・最適化・codegen 設定はルートの `Cargo.toml` に置く。メンバー側へ移すと workspace のプロファイルとして扱われない。
- `Cargo.lock` と `target/` はルートに置く。crate ごとの lockfile や target を再導入しない。
- `wasm-pack` の生成先は `crates/tuner/pkg/`。アプリ側の `src/wasm/` には生成しない。
- アプリは `import init, { Analyzer } from "@violin-tuner/dsp"` で利用する。生成物への相対パス import に戻さない。
- パッケージの `exports` は生成された JavaScript と型定義を公開する。生成ファイル名を変更する場合は両方を更新する。
- `target/`、`crates/tuner/pkg/`、`dist/` は生成物。手編集・コミットしない。
- コミット対象の `Cargo.lock` と `pnpm-lock.yaml` は生成物ディレクトリとは区別する。

## 3. コマンドとタスク実行

### セットアップ

Rustup、`wasm-pack`、Vite+ CLI が必要。Rust の宣言はルートの `rust-toolchain.toml` を使う。

```sh
rustup toolchain install --no-self-update
vp install --frozen-lockfile
vp run dev
```

`wasm-pack` が未導入の場合は `cargo install wasm-pack --locked` で導入する。Cargo からインストールした実行ファイルを使う場合は `$HOME/.cargo/bin` が `PATH` に含まれていることを確認する。

CI では各ワークフローの `WASM_PACK_VERSION` で固定した wasm-pack を `cargo install` する。GitHub Releases のバイナリを取得する Action には戻さない。既存の Rust cache で Cargo の bin とインストール情報を保存し、check / deploy で同じバージョンのキャッシュを共有する。復元後も `cargo install` は実行し、同じバージョンが導入済みなら Cargo が再コンパイルを省略する。バージョン変更時は両ワークフローを合わせて変更する。

### 通常の作業

- `vp run dev`：WASM を生成してから開発サーバーを起動。
- `vp run wasm:build`：WASM パッケージのみ生成。
- `vp run typecheck`：WASM 生成後、Vize Content Mapper を含む型検査。
- `vp run fmt`：Rust とフロントエンドのフォーマット。
- `vp run check`：WASM 生成、TypeScript 型検査、Rust fmt / Clippy、フロントエンドの format / lint 検査。
- `vp run test`：Rust と TypeScript のテスト。
- `vp run build`：WASM 生成、型検査、PWA 本番ビルド。
- `vp run preview`：生成済みの本番成果物を確認。

`vp build`、`vp check`、`vp dev` などは Vite+ の組み込みコマンドで、同名のリポジトリタスクとは異なる。特に初回起動では `vp run dev` を使う。`vp dev` だけでは WASM の先行ビルドを行わない。

対象を絞った検査には次のようなコマンドを使える。

```sh
vp test run src/tuning.test.ts src/tuner.test.ts
vp run @violin-tuner/dsp#test
vp run @violin-tuner/dsp#check
```

### タスクを変更する場合

- 手順の依存関係は `run.tasks.*.dependsOn` で表現する。長い `&&` 連結スクリプトを再導入しない。
- Rust の実コマンドは `crates/tuner/package.json` に置き、依存関係は各 `vite.config.ts` で宣言する。
- 同じパッケージで、同名のタスクを `package.json` の scripts と `vite.config.ts` の両方へ定義しない。
- 現在のタスクキャッシュは無効。キャッシュ導入は出力の復元やツールチェーン変更時の無効化を含めて検討する。
- `check` と `typecheck` も WASM を生成する。単なる読み取り専用の lint コマンドとは限らない。
- 一時的な dev / preview サーバーは検証後に停止する。既存のサーバーがあるか確認し、検証ごとに放置されたサーバーを増やさない。

## 4. 音程・自動選択の仕様

基準値は `src/tuning.ts` の `STRINGS` を正とする。

- G：`442 × 4 / 9` Hz。
- D：`442 × 2 / 3` Hz。
- A：`442` Hz。
- E：`663` Hz。

初期状態は A 線への着目・自動検出モード。弦のボタンを押すと手動固定になり、「自動検出」で解析結果の着目弦へ追従する状態に戻る。無音などで着目候補がない場合は、最後に選択した弦を保持する。

単弦と隣接2弦の演奏を想定する。2弦を検出した場合は、A 線から弦の並びで遠い側へ着目する。

- G + D → G。
- D + A → D。
- A + E → E。

### 判定を変更するときの注意

- 自動選択は Rust 側の解析結果として返す。UI 側に独立した判定ロジックを重複させない。
- 検出された基音の強さと隣接関係を使う。非隣接ペア向けの独自ルールを追加しない。
- 弱い G と強い D の組み合わせを扱う必要がある。相対音量差だけで候補を除外する cutoff を再導入しない。
- 直接弾いた音と共鳴音を完全に分離する仕組みではない。検出仕様を変更するときは手動固定の操作も維持する。

## 5. 音声処理と非同期ライフサイクル

音声リソースの管理は `createTuner()` に集約し、表示コンポーネントへ分散させない。

### 開始・停止

- 起動しただけではマイクや画面保持を要求しない。「始める」のクリック・タップから開始する。
- `AudioContext` の作成、Wake Lock の要求、`getUserMedia()`、必要な `AudioContext.resume()` は、開始操作内で最初の `await` より前に開始する。
- マイク許可の完了を待ってから Wake Lock を要求する方式へ戻さない。ブラウザ、特に Safari のユーザー操作判定を失う可能性がある。
- マイクの echo cancellation / noise suppression / auto gain control は無効化し、音程解析に不要な加工を避ける。
- `stop()` は Worker、タイマー、音声ノード、マイクトラック、AudioContext、Wake Lock を解放し、解析値を消去する。
- 画面の非表示・復帰、ページ離脱、コンポーネント破棄時の処理も開始・停止と一体で扱う。

### 非同期処理の競合

- `generation` によるセッション識別を維持する。停止後・再開後に古い許可要求や Worker の結果が返ることがある。
- 許可待ち中のキャンセル後に取得できたマイクや Wake Lock は、その場で解放する。
- 古い Wake Lock の要求が未完了でも、新しいセッションの取得を妨げない。要求中状態はセッションと関連付けて管理する。
- Wake Lock の失敗だけでマイク解析を停止しない。画面保持の失敗は `wakeMessage` と明示的な再取得操作で扱う。
- Worker の失敗は音声リソースを片付けたうえでエラー状態にする。
- `busy` により解析要求を重複送信せず、`freshAfter` により開始・復帰直後の古い音声フレームを避ける。

### Worker 境界

- Worker は Vite の `?worker` import で生成する。ビルド出力の Worker パスを手動で組み立てない。
- WASM 初期化には top-level await を使うため、Worker の出力形式は ES module を維持する。
- 要求は `analyze`、応答は `ready` / `result` / `error`。型は `src/tuning.ts` にまとめる。
- 音声データは `Float32Array` の buffer を transfer する。送信後の buffer の所有権に注意する。
- WASM 初期化完了前の解析要求や、停止済みセッションへの結果反映を許さない。

## 6. DSP と解析結果の契約

`Analyzer` の constructor はフレームサイズと4本の基準周波数を受け取る。アプリの設定元は `src/tuning.ts`。Rust の本番実装に独立した固定 `FRAME_SIZE` / `TARGETS` を追加しない。

- フレームサイズは32〜32,768の2の累乗。現在のアプリは16,384サンプルを使う。
- targets は G / D / A / E 順の、正の有限値4個・厳密な昇順。
- 解析時にはフレーム長、有限サンプル、8〜192 kHz のサンプルレート、探索帯域の FFT 境界も検査する。
- FFT サイズはフレームサイズの4倍。DC 成分除去、4項 Blackman–Harris 窓、窓による振幅の正規化、対数放物線補間を使う。
- 探索範囲は各基準の ±100 cents。表示上の針の範囲とは別である。
- 最低検出振幅は target 周波数に比例し、スペクトル中央値に基づく適応閾値と併用する。
- 低い G の感度、強い D からのスペクトル漏れ、D の倍音による G の誤検出は関連する問題。単純な閾値変更だけで済ませない。
- 音量表示は基音近傍の dBFS であり、環境の音圧や校正済みの騒音計測値ではない。

### WASM 出力

`Analyzer.analyze()` は14要素の `Float32Array` を返す。

- `0`：フレームの RMS。
- `1..3`：G の周波数 / cents / dBFS。
- `4..6`：D の周波数 / cents / dBFS。
- `7..9`：A の周波数 / cents / dBFS。
- `10..12`：E の周波数 / cents / dBFS。
- `13`：着目弦 `0..3`、候補なしは `-1`。

未検出の周波数は `0`。`decodeAnalysis()` は要素数・有限値・着目インデックスを検査する。レイアウト変更時は Rust、Worker、TypeScript の decoder・型・テストを一緒に変更する。

UI では ±3 cents を調弦済みとして扱い、針を ±50 cents に制限する。音量バーは −72〜0 dBFS を0〜100%へ変換する。これらの表示上の制限と、DSP の探索・検出条件を混同しない。

## 7. UI とスタイル

- 現在の UI は意図的に要素を減らした構成。削除された見出し・説明・フッターなどを、リファクタリングのついでに復活させない。
- 表示文言は日本語を基本とし、既存の `AUTO` / `MANUAL` / `FOCUS` / `Hz` / `dBFS` などの短いラベルと整合させる。
- コンポーネント固有の CSS は `.vue` 内に置く。グローバルスタイルは `src/style.css` の責務に限定する。
- 不要な class、未使用の computed / import、役割のないラッパーを残さない。兄弟のいない `div` は、意味・レイアウト・アクセシビリティを維持できる場合に親へ吸収する。
- 音量バーの装飾は CSS カスタムプロパティと疑似要素で表現している。単なる塗りつぶしのための内部 `div` を増やさない。
- 選択状態の `aria-pressed`、メーターの値・ラベル、通知の role、キーボードフォーカス、reduced-motion 対応を維持する。
- 見出し削除時に存在しない ID への `aria-labelledby` を残さない。
- レイアウト変更時は、狭い画面での操作ボタンの折り返し、カードの列数、横方向のはみ出しを確認する。
- [.editorconfig](.editorconfig) に従う。基本はスペース2個、Rust は4個。自動生成ファイルの内容・書式は生成ツールに任せる。

## 8. PWA・アイコン・配備パス

- PWA 設定は `vite.config.ts` の `VitePWA` に集約する。
- 更新は `prompt` 方式。計測中に勝手にリロードせず、ユーザー操作による更新前にチューナーを停止する。
- Service Worker の登録や更新の失敗を、成功したことにして隠さない。
- JS / CSS に加え WASM も precache 対象。生成先・アセット拡張子・サイズ制限を変更したら、オフラインで必要なファイルが残るか確認する。
- `workbox-window` はアプリの直接依存として維持する。PWA の仮想モジュールから import されるため、pnpm の間接依存の配置に頼ると再インストール後に解決できなくなる。
- `workbox-window` の解決失敗を `external` 指定で回避しない。ブラウザで必要なコードをバンドルから外してしまう。
- 画像ソースは `public/icon.svg` の1つだけ。公式の `@vite-pwa/assets-generator` と `pwaAssets` で必要な画像・HTML リンク・manifest icons を生成する。
- 独自の PNG 生成スクリプトや、手動管理のサイズ別画像を追加しない。
- Vite の `base`、manifest の `start_url` / `scope`、公開 URL の整合性を保つ。Worker / WASM / アイコンが `/violin-tuner/` 配下で解決されることを確認する。

## 9. GitHub Actions と依存更新

### ワークフローの分離

- [check.yaml](.github/workflows/check.yaml) と [deploy.yaml](.github/workflows/deploy.yaml) は独立したファイル。
- reusable workflow / `workflow_call` は使わない。必要な手順は各ファイルに直接記述する。
- check は PR と手動実行で、jactionlint、format / lint / 型検査、Rust / TypeScript テスト、本番ビルドを行う。
- deploy は `main` への push と手動実行で、依存導入・WASM を含む本番ビルド・Pages artifact のアップロード・公開を行う。
- deploy は別ワークフローの check の成功待ちではない。現在は deploy 側で lint / テストを再実行していないため、その前提を勝手に変えない。
- 両方に共通するセットアップを変更する場合は、もう一方にも必要な変更か確認する。ただし、重複解消を理由に reusable workflow に戻さない。
- Rust 宣言はルートの `rust-toolchain.toml`、Vite+ / Node.js / pnpm は `package.json` を参照する。CI 専用の異なるバージョン要件を持たせない。
- Pages への書き込み・OIDC 権限はデプロイ job に限定する。検証 job に公開用権限を広げない。
- 公開には GitHub の Settings → Pages → Source が GitHub Actions に設定されている必要がある。

### Actions lockfile と lint

- 使用する linter は **jactionlint**。actionlint へ置き換えない。
- CI は strict-exit を有効にしている。ローカルでも CI の action と同じバージョンを使う。
- [.github/workflows/actions.lock](.github/workflows/actions.lock) は直接・間接 Action 依存を固定する生成ファイル。SHA、リポジトリ ID、依存一覧を手編集しない。
- `uses:` の追加・削除・変更だけでなく、同じ Action を別のワークフローへ移した場合も lockfile を再生成する。エントリーはワークフローごとに対応している。
- 認証済み GitHub CLI と `github/gh-actions-lock` 拡張を使う。

```sh
gh actions-lock
gh actions-lock --verify
jactionlint --strict-exit
```

拡張がない場合の導入コマンドは `gh extension install github/gh-actions-lock`。ネットワークなしの `gh actions-lock --verify-local` は参照の網羅性のみを検査し、上流での commit の正当性を検証する `--verify` の代わりにはならない。

### Dependabot

[.github/dependabot.yaml](.github/dependabot.yaml) は GitHub Actions と npm ecosystem を対象とする。npm ecosystem には pnpm workspace の依存が含まれる。更新確認は毎週、cooldown は7日。

依存更新時はアプリ・WASM パッケージ・型検査・Worker・PWA 生成を合わせて確認する。特に Vize と Content Mapper、Vite+ と Vite alias、Workbox と PWA の依存解決を個別に切り離して考えない。

## 10. 変更ごとの検証

- 表示変換・データ契約：`src/tuning.test.ts`。周波数、payload の妥当性、着目値、cents 表示、音量バーの境界値を確認する。
- 音声ライフサイクル：`src/tuner.test.ts`。開始前の無操作、許可待ちのキャンセル、停止後の遅延完了、新旧セッションの競合、Wake Lock の失敗と解放を確認する。
- DSP：Rust テスト。静かな G 単音、強い D と同時の G、D の倍音、雑音・無音、隣接2弦、サンプルレート差、音程精度、不正な constructor / 入力を確認する。
- パッケージ境界・生成先：`vp run build` で型定義の解決、Worker のバンドル、WASM と PWA の成果物を確認する。
- UI：デスクトップとモバイルで、選択状態、開始・停止、未検出表示、音量バー、レイアウトとアクセシビリティを確認する。
- ワークフロー：jactionlint と Actions lockfile 検証。ローカルの静的検証と、GitHub 上で実際に実行・公開されたことは区別する。
- 文書だけの変更ではアプリ全体のビルドを繰り返さず、記載内容・リンク先・コマンドと現在の実装の整合性を確認する。

合成音やブラウザ API のモックによるテスト成功を、実機マイク・実際のバイオリン・Safari の権限ダイアログでの検証と同一視しない。実施した検証の範囲を明確にする。
