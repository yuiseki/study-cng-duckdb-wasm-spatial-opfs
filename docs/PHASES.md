# Implementation Phases

この study の実装を 5 つの phase に分けた工程表。 セッションを跨いで作業を再開するときの地図として使う（特に Claude Code の auto-compact 後で詳細が要約に潰れた場合の参照点）。

各 phase は **「次の phase に進める前提条件」 が明確** になるよう、 動作確認手順とゴールを書いている。 順番にやる必要があり、 phase をスキップすると後段の前提が成立しない。

## 全体ゴール

ブラウザだけで Overture Maps の GeoParquet を動的に query して MapLibre に表示する。 サーバを一切持たず、 GitHub Pages 1 つで closed loop。 2 回目以降のアクセスでは OPFS キャッシュ経由でオフラインでも動く。

## 共通参照

- **データ源**: Overture Maps の S3 公開 bucket。 ブラウザからは **STAC item の `assets.aws.href`（HTTPS URL）** で読む。 例: `https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/<date>/theme=buildings/type=building/part-NNNNN-...zstd.parquet`。 CORS は `Access-Control-Allow-Origin: *` で確認済み、 Range Request 対応
- **STAC catalog**: `https://stac.overturemaps.org/catalog.json`（CORS OK、 各 item に bbox + 複数 asset URL）
- **DuckDB-WASM の HTTP 読み込み**: native DuckDB の `httpfs` extension を別途 `LOAD` する必要はなく、 ビルトインの HTTP 読み込みで `read_parquet('https://...')` がそのまま動く。 `s3://` URI 解釈にこだわらず、 STAC で拾った HTTPS URL を直接渡す
- **公式想定ルート**: Overture 公式ドキュメント自体が STAC catalog から `read_parquet('https://...')` で最新 release を取る DuckDB クエリ例を提示している。 この study は奇をてらった独自構成ではなく公式想定の流れに沿う
- **base study**: [study-duckdb-wasm-spatial](https://github.com/yuiseki/study-duckdb-wasm-spatial)（DuckDB-WASM + Natural Earth 静的 GeoJSON、 出発点。 DuckDB-WASM の Worker 初期化 / spatial extension 起動 / React 連携 / GitHub Pages 配信 はここで一通り確立済み）
- **sibling study**: [study-cng-overture-buildings-tile](https://github.com/yuiseki/study-cng-overture-buildings-tile)（server 必須の動的タイルサーバ、 同じデータ源を逆方向の構成で扱う）
- **technique 既知**: STAC index で 512 file の bbox を起動時に集約 → bbox に該当する数 file だけ DuckDB に渡すと、 wildcard `*` の cold start 1〜2 分が 数秒〜10 秒に縮む（sibling study で実証済み）

## Phase 1: DuckDB-WASM 起動 + Overture HTTPS Parquet への到達確認（safety gate）

**ゴール**: ブラウザで DuckDB-WASM を起動し、 spatial extension をロードし、 **Overture の STAC catalog および HTTPS Parquet に DuckDB-WASM から到達できる** ことを確認する。 ここが Phase 2 以降のゲート。

**実装するもの**:

- `src/lib/duckdb.ts`: DuckDB-WASM の初期化（base study の `App.tsx` の `initDuckDB` を切り出した形）
- `src/App.tsx`: DuckDB-WASM 起動状態を画面表示、 `window` に connection を expose してコンソールから叩けるように
- ロードする extension: `spatial`（HTTP 読み込みは built-in なので `httpfs` の load は不要）

**成功条件**:

1. `npm run dev` で起動して `http://localhost:5173/study-cng-duckdb-wasm-spatial-opfs/` に DuckDB の起動完了表示が出る
2. ブラウザコンソールで `await window._duckdbConn.query("SELECT 1+1 AS x")` が `[{x: 2}]` を返す
3. `await window._duckdbConn.query("LOAD spatial; SELECT ST_GeomFromText('POINT(0 0)') AS g")` が成功する
4. **Overture STAC catalog から最新 release が取れる**: `await window._duckdbConn.query("SELECT latest FROM 'https://stac.overturemaps.org/catalog.json'")` が `2026-04-15.0` 形式の文字列を返す
5. **Overture HTTPS Parquet 1 ファイルが直接読める**: STAC で取得した item の `assets.aws.href`（HTTPS URL）を 1 つ拾って `await window._duckdbConn.query("SELECT count(*) FROM read_parquet('https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/.../part-00000-...zstd.parquet')")` が大きな数を返す

**ハマりどころ**:

- DuckDB-WASM の Worker 初期化は `MANUAL_BUNDLES` 経由で `?url` import が必要（Vite 環境）。 base study の書き方をそのまま踏襲する
- `BigInt` が混じる結果は React で render 時 throw する。 数値カラムは `Number()` で wrap が必要（base study で既に踏み抜き済）
- DuckDB-WASM では `s3://` URL を直接読まない。 必ず STAC 由来の **HTTPS URL** を渡す
- もし CORS / Range Request で詰まった場合、 それは Phase 3 を諦める理由ではなく、 `httpHostHeader` の取り回し / 必要なら最小限の proxy を挟む 等の実装調整で対処する

## Phase 2: STAC index をブラウザで構築

**ゴール**: 起動時に Overture Buildings の STAC collection.json + 全 item.json をブラウザの fetch で並列取得し、 in-memory の `(bbox, s3 href)` リストを作る。

**実装するもの**:

- `src/lib/stacIndex.ts`: STAC walker（sibling study の `src/buildings_cng/stac_index.py` の TS 移植、 ただし href は HTTPS を使う）
- 入口: `https://stac.overturemaps.org/2026-04-15.0/buildings/building/collection.json`
- 各 item.json から `bbox: [west, south, east, north]` と `assets.aws.href`（HTTPS URL）を抽出
- bbox intersect 関数 `filesIntersecting(queryBbox)` を export（HTTPS URL の配列を返す）

**成功条件**:

1. App 起動時 5〜10 秒で `STAC index ready: 512 files indexed` 的なログが出る
2. ブラウザコンソールで `window._stacIndex.filesIntersecting([-74.025, 40.78, -74.003, 40.797])` が **数件の `https://...` 文字列の配列** を返す（Manhattan の z=14 タイル相当の bbox で 1〜2 件）
3. 各 href が `https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/.../part-XXXXX-...zstd.parquet` 形式

**ハマりどころ**:

- 512 個の HTTP fetch を素朴に `Promise.all` で投げると、 ブラウザ上限（Chrome の場合 6 conn/origin）でキューが積まれて遅い。 並列度を 32 程度に絞った semaphore 風の throttle が要る
- STAC item.json の href は collection.json からの相対パス、 `URL` constructor で resolve すると安全

## Phase 3: MapLibre + Overture query 連携

**ゴール**: MapLibre 上で 表示中の bbox を取得し、 STAC index で file を絞り、 DuckDB-WASM の httpfs で S3 GeoParquet を直接読み、 結果を GeoJSON として MapLibre に流して表示する。

**実装するもの**:

- `src/components/BuildingsMap.tsx`: MapLibre + react-map-gl のラッパー
- `src/lib/duckdbQuery.ts`: bbox を受け取り、 STAC index で HTTPS URL を選び、 DuckDB-WASM で `read_parquet([...])` する関数。 結果を GeoJSON FeatureCollection で返す
- bbox 取得: `map.on('moveend', ...)` で `map.getBounds()` から WSEN
- MapLibre source は `geojson` type、 `setData()` で動的更新

**成功条件**:

1. Manhattan の z=14 ぐらいで開いて、 数秒以内に建物 polygon が表示される
2. パン / ズームで bbox が変わり、 新しいエリアの建物が再描画される
3. ブラウザの Network タブで `overturemaps-us-west-2.s3.us-west-2.amazonaws.com` 宛の **Range request**（206 Partial Content 応答）が観測できる

**ハマりどころ**:

- `read_parquet([f1, f2, ...])` で配列リテラルを SQL に渡すには文字列を quote して `[ '...', '...' ]` の形式に
- WKB を取り出して shapely 相当の処理は WASM 側にないので、 DuckDB の `ST_AsGeoJSON(geometry)` を使ってテキストで取り出すか `ST_AsWKB` を JS 側でパースするのが選択肢
- 大量 polygon を 1 frame で MapLibre に流すとガクつく場合がある。 `setData` の頻度制御（debounce）を入れる

## Phase 4: 動的 attribute filter

**ゴール**: UI スライダーで `min_height` 等のフィルタ値を変えると、 SQL の WHERE 句が再生成されて MapLibre 表示が即座に切り替わる。

**実装するもの**:

- `src/components/FilterControls.tsx`: height slider、 class セレクタ等
- `src/lib/duckdbQuery.ts` を引数で `minHeight` を受けるように拡張
- React state でフィルタ変更を bbox query 関数に flow

**成功条件**:

1. height スライダーを動かすと建物が height >= N にフィルタされて即更新される
2. URL クエリパラメータ `?height=20` で初期値が反映される

**ハマりどころ**:

- フィルタ変更時に毎回フルクエリが走ると遅い。 debounce が要る（slider drag 中は最後の値だけ反映）
- DuckDB-WASM の prepared statement と SQL 直書きは性能差ある場合あり。 PoC では SQL 直書きで OK

## Phase 5: OPFS cache 層

**ゴール**: 一度 fetch した GeoParquet（または query 結果）をブラウザの OPFS に書き、 2 回目以降のアクセスは OPFS から読む。 オフライン環境でも前回見たエリアは動く。

**実装するもの**:

- `src/lib/opfsCache.ts`: `navigator.storage.getDirectory()` で root を取得、 file 単位の get/put、 quota 管理
- DuckDB-WASM 側に OPFS の VFS を register する方法、 もしくは OPFS から ArrayBuffer を取り出して DuckDB の `registerFileBuffer` 経由で feed する方法を検討
- どの粒度でキャッシュするかの設計判断:
  - **粒度 A**: Parquet ファイル全体（数百 MB、 OPFS quota に注意）
  - **粒度 B**: bbox + filter ごとの query 結果 GeoJSON（軽量、 命中率は低め）
  - **粒度 C**: STAC index のスナップショット（軽量、 起動時短縮効果あり）
- 最初は **粒度 C → 粒度 B** の順で作るのが現実的

**成功条件**:

1. 1 回目アクセスで bbox X の query を発行、 OPFS に何かしら書かれる
2. ブラウザを開き直して再度 bbox X を見ると、 OPFS から読まれて network 不在でも表示される
3. DevTools の Application → Storage → File System で `study-cng-duckdb-wasm-spatial-opfs` 配下にファイルが見える

**ハマりどころ**:

- OPFS は worker context だと `FileSystemSyncAccessHandle` が使えるが、 main thread だと async API のみ
- DuckDB-WASM の VFS register は version 依存の API があるため、 まず `registerFileBuffer` で済ませるのが安全
- quota（origin あたり 数百 MB が標準、 ブラウザ依存）超えたときの fallback 動作が要る

## 進め方

各 phase の **成功条件をすべて満たしてから次に進む**。 phase 完了時には:

1. 動作確認のスクリーンショット or ログ片を `docs/PHASES.md` に追記（or 別の `docs/notes-<phase>.md`）
2. README の「できること（予定）」 を 「できること」 に格上げして実態を書く
3. git commit、 GitHub に push（auto deploy で GitHub Pages も更新）

セッション再開時は **このファイルの「現在の状況」 セクション** をまず確認し、 進捗の正確な位置を把握する。

## 現在の状況

- ✅ Scaffold（package.json / vite.config / index.html / README / LICENSE / GitHub Actions）
- ✅ Phase 1（gate 4 probe 全通過、 playwright-cli で確認済）
- ✅ Phase 2（STAC index 512/512 items を 11.8 秒で構築、 bbox intersect 動作確認）
- ✅ Phase 3（経路成立、 Manhattan z=14 で 975 buildings (height>=50) を 88 秒で MapLibre に描画、 Range request 機能確認、 react-map-gl は外して vanilla maplibre 直接利用に切替）
- ✅ Phase 4（slider 動的 filter 機能成立、 debounce + stale-query drop 実装、 ただし速度には構造的な罠あり: 後述）
- ⏸️ Phase 5（保留: 後述 「Phase 5 を保留する判断」 を参照）

## Phase 3 で得た学び（後段に伝える）

- DuckDB-WASM の per-row コストが ~50-100 ms と重く、 これは ST_AsGeoJSON でも ST_AsWKB+JS-side parse でも変わらない（WKB を試したが、 per-row 90-110 ms で同等または遅かった）。 つまり geometry serializer は支配要因ではなく、 **WHERE で残る row 数を減らすこと自体** が唯一効くチューニング軸
- 「単純な count(*) FROM read_parquet」 系は DuckDB-WASM では footer-only optimization が効かずフル fetch に流れる（Phase 1 で実測。 Range Request は出るがファイル全域に及ぶ）
- 起動時の vite が `--force` で deps を再 optimize するときに transient な 503 / Outdated Optimize Dep / Invalid hook call が混じる。 機能は正常、 fresh session で消える
- react-map-gl@8.1.1 + React 19 + vite optimized deps の組み合わせで `_Map` 内 `useContext` が null を返して落ちるケースを観測。 vanilla maplibre 直接利用に切り替えれば回避できる（charites-like-opfs と異なるシナリオで再現する）

## Phase 4 で得た学び（後段に伝える）

- **「フィルタを厳しくすると速くなる」 は嘘**。 `LIMIT N` がついたクエリは DuckDB の早期終了起点として機能していて、 WHERE が緩いと早く N 件貯まって short-circuit する一方、 厳しい WHERE は LIMIT に達せずに **file 全 scan** にフォールバックする。 Manhattan z=14 で実測:
  - height >= 50 → 975 件 / 88 秒
  - height >= 100 → 319 件 / **253 秒**（フィルタ厳しくしたのに 3 倍遅い）
- 直感的には Phase 3 の per-row コスト × 行数 で見積もるが、 実際は **「LIMIT 達成までの scan 量」 が支配的**。 PoC 段階では「filter は zoom out 用、 zoom in したら自動で行数が減る」 という UX で逃げるしかない
- Overture の `height` 列の row-group statistics が（少なくとも DuckDB-WASM 経路では）prune に効いていない。 もし効いていれば WHERE で row-group 単位の skip が起きて、 行数比例の時間で済んだはず
- スライダーの実装は state を `pendingMinHeight`（即時）と `minHeight`（debounced commit）に二段化、 `queryGenRef` で stale query 結果の drop で安定動作。 これは debounced filter UI の定型

## Phase 5 を保留する判断

OPFS は cache 層であって compute 層ではない。 我々が Phase 3 / 4 で当たった壁は HTTP 往復のコストではなく、 **DuckDB-WASM が S3 Parquet を scan して filter する時の per-row 50-100 ms** という compute コスト。 このコストは 「初回 fetch を OPFS に置く」 「STAC index を OPFS に persist する」 のどちらをやっても変わらない。 cache hit でも DuckDB-WASM の scan は再度走るし、 元 Parquet の bytes が S3 から来るか OPFS から来るかは body cost に対して誤差。

具体的に:

- 粒度 C（STAC index 永続化）: 起動時 12 秒 → 数百 ms に縮む。 ただし 1 タイル目の query 80 秒は変わらない
- 粒度 B（query 結果 GeoJSON cache）: 同じ bbox + filter の繰り返しなら HIT で即時。 ただし新しい bbox / filter に動かすと毎回 80 秒が来る
- 粒度 A（Parquet ファイル全体を OPFS に download）: 一度 download すれば S3 往復なし、 ただし 526 MB / file の OPFS quota（数百 MB 〜）と、 DuckDB-WASM の scan コスト自体は不変

「browser 完結で動的タイル生成」 という study の問い に対して、 OPFS を入れると「**動かない代わりに保存される**」 というだけで、 PoC として伝えたいことは Phase 4 までで十分顕在化した。 なのでここで打ち切る。

OPFS が真価を発揮するのは:

- 計算結果（事前生成 PMTiles 等）を browser 配信する用途
- 編集中の YAML や local-first edit データを置く用途（charites-like-opfs 系）
- DuckDB-WASM が **compute せずに** OPFS の Parquet を pass-through で扱う用途

このうち最後は本 study と同じ前提で、 やはり scan コストが残るので意味薄。 上の 2 つは別 study の方向。

## Phase 1 で得た学び（Phase 2 以降に伝える）

- **DuckDB-WASM の HTTP IO は Parquet footer-only optimization が効かない**。 `count(*) FROM read_parquet(URL)` も `parquet_metadata(URL)` も、 526 MB の Overture Parquet に対してフル fetch に流れた（122 秒で完走 or 30 秒で timeout）
- 「URL が reachable で Range が効く」 だけ確認したいなら **`fetch(url, {headers: {Range: 'bytes=0-1023'}})`** で 206 Partial Content を見るのが速くて素直（Phase 1 gate の Probe 4 はこの形に修正した）
- DuckDB-WASM 経由の Parquet read は Phase 3 で bbox + row-group prune が効く実 query で初めて評価する。 そこでは fetch 量が結果サイズに比例する想定
- 起動時に DuckDB-WASM が `parquet.duckdb_extension.wasm` を lazy load することを観測（`spatial`/`json` と並んで extensions.duckdb.org から）
