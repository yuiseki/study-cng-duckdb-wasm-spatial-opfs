# study-cng-duckdb-wasm-spatial-opfs

> **A Cloud Native Geospatial study: dynamic spatial queries served entirely from the browser via DuckDB-WASM over Overture GeoParquet.** Pure browser implementation, no backend. The study walked from "boot" through "live filter slider" and stopped before OPFS, because OPFS would not have moved the bottleneck. See [docs/PHASES.md](./docs/PHASES.md) for the phase-by-phase log.

| | |
| --- | --- |
| **viewer (browser-only)** | https://yuiseki.github.io/study-cng-duckdb-wasm-spatial-opfs/ |
| **base study** | [study-duckdb-wasm-spatial](https://github.com/yuiseki/study-duckdb-wasm-spatial)（DuckDB-WASM ＋ Natural Earth による出発点） |
| **sibling study** | [study-cng-overture-buildings-tile](https://github.com/yuiseki/study-cng-overture-buildings-tile)（こちらの対極、 server 必須の動的タイルサーバ）|

## なぜ作ったか

姉妹 study の [study-cng-overture-buildings-tile](https://github.com/yuiseki/study-cng-overture-buildings-tile) は **「サーバ側で動的タイルを生成する」** 方向で Overture + DuckDB Spatial + Knative の組合せを試した。

その対極として、 **「ブラウザだけで完結させる」** 方向を試すのがこの study。 サーバを一切持たず、 GitHub Pages から配信した HTML + JS が:

- DuckDB-WASM をブラウザ内で起動し、 spatial extension をロード
- httpfs 経由で Overture S3 GeoParquet を **Range request で partial read**
- STAC catalog からの spatial index も **ブラウザで構築**
- 結果を MapLibre GL JS に流し込んで動的に表示
- OPFS (Origin Private File System) を使って **2 回目以降オフラインでも動く**

UN Open GIS DWG7 / UN Smart Maps Group の文脈でいう「ポータブルでセルフホスト可能で、 オフライン・低接続性環境にも応用できる CNG」 を、 browser だけで成立させる実装試行。

## できること

- Overture Buildings の bbox 範囲を MapLibre 上で動的にクエリ（DuckDB-WASM 経由）
- 高さ slider で動的に min height をフィルタ（debounced）
- STAC catalog から各 Parquet の bbox を起動時に取得し、 in-memory spatial index としてクエリ時に該当 file だけを `read_parquet()` に渡す
- 全工程がブラウザ内、 GitHub Pages 1 つで完結

## アーキテクチャ（予定）

```
Browser (yuiseki.github.io/study-cng-duckdb-wasm-spatial-opfs/)
  ├─ DuckDB-WASM + spatial extension
  ├─ STAC catalog fetch (https://stac.overturemaps.org/)
  ├─ in-memory spatial index 構築（ブラウザで）
  ├─ DuckDB-WASM の httpfs で S3 GeoParquet を Range request
  ├─ bbox + filter で row-group prune クエリ
  ├─ 結果を MapLibre GL JS に流し込み
  └─ OPFS にキャッシュ → 次回オフライン動作
```

## 技術スタック

- React + TypeScript + Vite（既存 study テンプレート踏襲）
- `@duckdb/duckdb-wasm` ＋ `spatial` ＋ `httpfs` extension
- MapLibre GL JS / `react-map-gl`
- OPFS (Origin Private File System) / `navigator.storage.getDirectory()`
- データ源: [Overture Maps STAC catalog](https://stac.overturemaps.org/) ＋ S3 GeoParquet（CORS 対応済を確認）

## 動かす

```bash
npm install
npm run dev
# → http://localhost:5173/study-cng-duckdb-wasm-spatial-opfs/
```

## デプロイ

`main` への push で GitHub Actions の `publish_gh_pages.yml` が走り、 `dist/` を `gh-pages` branch に push する。 Settings → Pages の Source が `gh-pages` branch / root であれば自動公開。

## 結論

**browser-only で動的に Overture を query してタイル相当を出すことは可能だが、 体感速度は serverless サービスとしては成立しない**。

- DuckDB-WASM の per-row コストが ~50-100 ms 規模で、 これは ST_AsGeoJSON でも ST_AsWKB でも変わらない
- `LIMIT N` がついているクエリでは「どれだけ早く N 件貯まるか」 が時間を支配し、 WHERE を厳しくすると逆に遅くなる場面がある（Manhattan z=14 で height>=50 → 88 秒、 height>=100 → 253 秒）
- STAC catalog から spatial index を作って該当 file を絞り込むのは効くが、 絞り込んだ後の 1 file の中の scan コストが残る
- OPFS で cache する layer を入れても、 cache miss 時の DuckDB-WASM scan コストは変わらない（Phase 5 を保留した理由、 [docs/PHASES.md](./docs/PHASES.md) 参照）

つまり「browser-only で planetary-scale GeoParquet を on-the-fly に触れる」 という体験は **interactive analyst の REPL 用途には強い**（Jupyter の代替に近い）が、 **production の動的タイルサーバを browser で代替する**用途には DuckDB-WASM 自体のチューニングがもう一段要る、 が本 study の結論。

姉妹 study の [study-cng-overture-buildings-tile](https://github.com/yuiseki/study-cng-overture-buildings-tile)（server 必須の動的タイルサーバ）が同じデータ源で 1 タイル ~12 秒だったのと対比すると、 server-side との差は per-tile で 1 桁。

## License

[MIT License](./LICENSE.md)。 Overture Maps データの利用は [Overture data license](https://docs.overturemaps.org/attribution/) に従うこと（基本は CDLA Permissive 2.0 / ODbL、 theme による）。
