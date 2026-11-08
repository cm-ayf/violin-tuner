# Violin Tuner

A=442 Hz を基準に純正五度で合わせる、端末内処理のバイオリンチューナーです。

公開先: <https://cm-ayf.github.io/violin-tuner/>

## 開発

`wasm32-unknown-unknown` ターゲット、`wasm-pack` が必要です。Node.js / pnpm の要件は `devEngines` に定義しています。

`wasm-pack` を Cargo でインストールした場合は、`$HOME/.cargo/bin` を PATH に含めてください。

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked
vp install --frozen-lockfile
vp dev
```

ローカル URL は `http://localhost:5173/violin-tuner/`。マイクを使うため、本番は HTTPS、ローカルは localhost で開いてください。

`workbox-window` は PWA の更新通知用の仮想モジュールから読み込まれるため、アプリの直接依存として宣言しています。pnpm の間接依存の配置に頼らず、再インストール後も解決できるようにするためです。

```sh
vp run fmt      # フォーマット
vp run check    # Vite+ format/lint、Vize Content Mapper 型検査、Rust fmt/clippy
vp run test     # TypeScript の契約・ライフサイクル検査、Rust DSP 検査
vp run build    # WASM 生成、型検査、PWA 本番ビルド
vp run preview  # 本番成果物を確認
```
