import { useEffect, useState } from "react";
import * as duckdb from "@duckdb/duckdb-wasm";

import { BuildingsMap } from "./components/BuildingsMap";
import { initDuckDB } from "./lib/duckdb";
import { buildStacIndex, type STACSpatialIndex } from "./lib/stacIndex";
import "./App.css";

// Pinned for the PoC; following the STAC root catalog's `latest` would be
// the proper move but is out of Phase 2 scope.
const OVERTURE_RELEASE = "2026-04-15.0";
const OVERTURE_THEME = "buildings";
const OVERTURE_TYPE = "building";

type Status = "init" | "ready" | "error";

type GateProbe = {
  ok: boolean;
  label: string;
  detail: string;
  durationMs?: number;
};

function App() {
  const [status, setStatus] = useState<Status>("init");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [conn, setConn] = useState<duckdb.AsyncDuckDBConnection | null>(null);
  const [probes, setProbes] = useState<GateProbe[]>([]);
  const [stacStatus, setStacStatus] = useState<string>("(idle)");
  const [stacIndex, setStacIndex] = useState<STACSpatialIndex | null>(null);
  const [intersectSample, setIntersectSample] = useState<{
    bbox: [number, number, number, number];
    label: string;
    files: string[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const handles = await initDuckDB();
        if (cancelled) return;
        setConn(handles.conn);
        // Expose to console for ad-hoc inspection during Phase 1 gating.
        // (eslint-disable-next-line: this is intentional dev affordance)
        (window as unknown as { _duckdbConn: typeof handles.conn })._duckdbConn = handles.conn;
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-run the Phase 1 gate probes once the connection is ready.
  useEffect(() => {
    if (!conn) return;
    let cancelled = false;
    (async () => {
      const results: GateProbe[] = [];
      const probe = async (
        label: string,
        sql: string,
        validate: (rows: Record<string, unknown>[]) => string | null,
        timeoutMs = 60_000,
      ): Promise<GateProbe> => {
        const t0 = performance.now();
        try {
          type Rows = Record<string, unknown>[];
          const queryPromise: Promise<Rows> = conn
            .query(sql)
            .then((arrow) => arrow.toArray().map((r) => r.toJSON() as Record<string, unknown>));
          const timeoutPromise = new Promise<Rows>((_, reject) =>
            setTimeout(
              () => reject(new Error(`timeout after ${timeoutMs} ms`)),
              timeoutMs,
            ),
          );
          const rows = await Promise.race([queryPromise, timeoutPromise]);
          const fail = validate(rows);
          const durationMs = Math.round(performance.now() - t0);
          if (fail) {
            return { ok: false, label, detail: fail, durationMs };
          }
          return {
            ok: true,
            label,
            detail: JSON.stringify(rows[0] ?? rows, jsonReplacer),
            durationMs,
          };
        } catch (e) {
          return {
            ok: false,
            label,
            detail: e instanceof Error ? e.message : String(e),
            durationMs: Math.round(performance.now() - t0),
          };
        }
      };

      // 1) sanity
      results.push(
        await probe("SELECT 1+1", "SELECT 1+1 AS x", (rows) =>
          rows[0]?.x === 2 ? null : "expected x=2"
        ),
      );
      if (cancelled) return;
      setProbes([...results]);

      // 2) spatial loaded
      results.push(
        await probe(
          "spatial: ST_GeomFromText",
          "SELECT ST_AsText(ST_GeomFromText('POINT(0 0)')) AS g",
          (rows) =>
            String(rows[0]?.g ?? "").startsWith("POINT") ? null : "no POINT",
        ),
      );
      if (cancelled) return;
      setProbes([...results]);

      // 3) Overture STAC catalog reachable
      results.push(
        await probe(
          "STAC root catalog (latest release)",
          "SELECT latest FROM 'https://stac.overturemaps.org/catalog.json'",
          (rows) =>
            typeof rows[0]?.latest === "string" && /^\d{4}-\d{2}-\d{2}\.\d+$/.test(
              rows[0].latest as string,
            )
              ? null
              : "no/invalid `latest` field",
        ),
      );
      if (cancelled) return;
      setProbes([...results]);

      // 4) Overture HTTPS Parquet reachable (raw Range request, not via DuckDB).
      // We tested both `count(*) FROM read_parquet` and `parquet_metadata()`
      // and both end up streaming the entire 526 MB file in DuckDB-WASM
      // (Parquet footer-only optimization is not effective in the WASM HTTP
      // path). For a Phase 1 gate we don't actually need DuckDB to parse the
      // Parquet here; we just need to confirm the URL is reachable from the
      // browser with CORS + Range support. A direct fetch with Range is the
      // right shape for that question. DuckDB-WASM-side Parquet reads are
      // exercised properly in Phase 3 where bbox + row-group prune keeps the
      // fetched bytes proportional to the answer (not the file size).
      const PROBE_HREF =
        "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/2026-04-15.0/theme=buildings/type=building/part-00000-ea4676e5-311d-537a-872f-f784b95e670b-c000.zstd.parquet";
      results.push(await rangeProbe(
        "Overture HTTPS Parquet (CORS + Range reachability)",
        PROBE_HREF,
      ));
      if (cancelled) return;
      setProbes([...results]);
    })();
    return () => {
      cancelled = true;
    };
  }, [conn]);

  // Phase 2: build the STAC spatial index in parallel with probes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setStacStatus("building...");
        const idx = await buildStacIndex(
          OVERTURE_RELEASE,
          OVERTURE_THEME,
          OVERTURE_TYPE,
          (msg) => !cancelled && setStacStatus(msg),
        );
        if (cancelled) return;
        setStacIndex(idx);
        (window as unknown as { _stacIndex: STACSpatialIndex })._stacIndex = idx;

        // Sanity sample: Manhattan z=14 tile bbox.
        const sampleBbox: [number, number, number, number] = [
          -74.025, 40.78, -74.003, 40.797,
        ];
        const files = idx.filesIntersecting(sampleBbox);
        setIntersectSample({
          bbox: sampleBbox,
          label: "Manhattan z=14 (-74.025, 40.78, -74.003, 40.797)",
          files,
        });
      } catch (e) {
        if (!cancelled) {
          setStacStatus(
            "build failed: " + (e instanceof Error ? e.message : String(e)),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "1rem" }}>
      <h1>study-cng-duckdb-wasm-spatial-opfs</h1>
      <p style={{ color: "#666" }}>
        Phase 1 gate. Browser → DuckDB-WASM → Overture STAC + HTTPS Parquet 到達確認
      </p>

      <h2>DuckDB-WASM</h2>
      {status === "init" && <p>Initializing DuckDB-WASM…</p>}
      {status === "error" && (
        <p style={{ color: "crimson" }}>Init failed: {errorMsg}</p>
      )}
      {status === "ready" && <p>✅ DuckDB-WASM ready (with spatial extension)</p>}

      <h2>Phase 1 probes</h2>
      <ol>
        {probes.map((p, i) => (
          <li key={i} style={{ marginBottom: "0.5rem" }}>
            <strong>{p.ok ? "✅" : "❌"} {p.label}</strong>
            {p.durationMs !== undefined && (
              <span style={{ color: "#888" }}> ({p.durationMs} ms)</span>
            )}
            <pre style={pre}>{p.detail}</pre>
          </li>
        ))}
        {status === "ready" && probes.length < 4 && <li>(running…)</li>}
      </ol>

      <h2>Phase 2: STAC spatial index</h2>
      <p>
        <strong>{stacIndex ? "✅" : "⏳"} STAC index</strong>
        {stacIndex && (
          <span style={{ color: "#888" }}>
            {" "}({stacIndex.stats().indexed} items)
          </span>
        )}
      </p>
      <pre style={pre}>{stacStatus}</pre>
      {intersectSample && (
        <>
          <p style={{ marginTop: "0.75rem" }}>
            <strong>filesIntersecting</strong> sample for{" "}
            <code>{intersectSample.label}</code>
            <span style={{ color: "#888" }}>
              {" "}→ {intersectSample.files.length} file(s)
            </span>
          </p>
          <pre style={pre}>
            {intersectSample.files.length > 0
              ? intersectSample.files.join("\n")
              : "(no files intersect this bbox)"}
          </pre>
        </>
      )}

      <h2>Phase 3: live map (DuckDB-WASM → MapLibre)</h2>
      {conn && stacIndex ? (
        <BuildingsMap conn={conn} stacIndex={stacIndex} />
      ) : (
        <p style={{ color: "#888" }}>
          (waiting for DuckDB-WASM and STAC index…)
        </p>
      )}
    </div>
  );
}

const pre: React.CSSProperties = {
  background: "#f4f4f4",
  padding: "0.5rem 0.75rem",
  borderRadius: 4,
  fontSize: 12,
  margin: "0.25rem 0",
  overflowX: "auto",
};

// Apache Arrow can return BigInt; JSON.stringify trips on those.
function jsonReplacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? Number(v) : v;
}

// Phase 1 probe variant that hits a URL directly with a small Range request.
// Confirms the browser can reach the origin under CORS and that the origin
// honors HTTP Range Requests (which is what DuckDB-WASM relies on for any
// real partial Parquet reads in later phases).
async function rangeProbe(label: string, url: string, timeoutMs = 10_000): Promise<GateProbe> {
  const t0 = performance.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { Range: "bytes=0-1023" },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const durationMs = Math.round(performance.now() - t0);
    const cr = res.headers.get("content-range") ?? "(missing)";
    const ar = res.headers.get("accept-ranges") ?? "(missing)";
    if (res.status !== 206) {
      return {
        ok: false,
        label,
        detail: `expected 206 Partial Content, got ${res.status} (Accept-Ranges: ${ar})`,
        durationMs,
      };
    }
    return {
      ok: true,
      label,
      detail: `${res.status} Partial Content; Content-Range: ${cr}`,
      durationMs,
    };
  } catch (e) {
    return {
      ok: false,
      label,
      detail: e instanceof Error ? e.message : String(e),
      durationMs: Math.round(performance.now() - t0),
    };
  }
}

export default App;
