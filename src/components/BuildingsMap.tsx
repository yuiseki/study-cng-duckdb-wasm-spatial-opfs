// MapLibre directly (no react-map-gl), to keep the React tree free of
// third-party hooks that have been brittle under react-map-gl@8 + React 19
// when vite's optimized deps cache invalidates. This component owns one
// MapLibre instance per mount, listens for moveend, and pushes new query
// results into a single GeoJSON source.

import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl, { type Map as MaplibreMap, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type * as duckdb from "@duckdb/duckdb-wasm";

import { queryBuildingsInBbox } from "../lib/duckdbQuery";
import type { Bbox, STACSpatialIndex } from "../lib/stacIndex";

type Props = {
  conn: duckdb.AsyncDuckDBConnection;
  stacIndex: STACSpatialIndex;
};

// Read initial min-height from the URL so demos can be bookmarked at a
// specific filter (?height=80). Phase 4 surfaces this as a slider; the URL
// param sets the slider's starting value.
function readInitialMinHeight(): number {
  if (typeof window === "undefined") return 50;
  const v = new URLSearchParams(window.location.search).get("height");
  if (v == null) return 50;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 50;
}

const SLIDER_MIN = 0;
const SLIDER_MAX = 200;
const SLIDER_STEP = 5;
const QUERY_DEBOUNCE_MS = 250;

const EMPTY_FC: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

const BASEMAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    esri: {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "Source: Esri, Maxar, Earthstar Geographics",
    },
  },
  layers: [
    {
      id: "satellite",
      type: "raster",
      source: "esri",
    },
  ],
};

export function BuildingsMap({ conn, stacIndex }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MaplibreMap | null>(null);

  // pendingMinHeight follows the slider in real time; minHeight is the
  // debounced "committed" value that actually re-runs the query. This
  // prevents a flood of in-flight DuckDB-WASM queries while the user is
  // dragging the slider (each query is ~tens of seconds).
  const [pendingMinHeight, setPendingMinHeight] = useState(readInitialMinHeight);
  const [minHeight, setMinHeight] = useState(pendingMinHeight);

  const [status, setStatus] = useState<string>("(idle)");
  const [busy, setBusy] = useState(false);

  // Track the latest query so a stale one (e.g. from a previous slider
  // position) cannot overwrite the current GeoJSON source.
  const queryGenRef = useRef(0);

  const runQuery = useCallback(
    async (map: MaplibreMap, currentMinHeight: number) => {
      const myGen = ++queryGenRef.current;
      const b = map.getBounds();
      const bbox: Bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      setBusy(true);
      setStatus(`querying (height >= ${currentMinHeight} m)...`);
      try {
        const r = await queryBuildingsInBbox(conn, stacIndex, bbox, {
          minHeight: currentMinHeight,
        });
        if (myGen !== queryGenRef.current) {
          // a newer query has been issued; drop this result.
          return;
        }
        const src = map.getSource("buildings") as maplibregl.GeoJSONSource | undefined;
        if (src) {
          src.setData(r.fc);
        }
        setStatus(
          `${r.rowsReturned} buildings (height >= ${currentMinHeight} m) ` +
            `from ${r.filesQueried} file(s) in ${r.durationMs} ms ` +
            `[bbox ${bbox.map((v) => v.toFixed(4)).join(", ")}]`,
        );
      } catch (err) {
        if (myGen === queryGenRef.current) {
          setStatus("error: " + (err instanceof Error ? err.message : String(err)));
        }
      } finally {
        if (myGen === queryGenRef.current) setBusy(false);
      }
    },
    [conn, stacIndex],
  );

  // Debounce slider movement: pendingMinHeight changes immediately on every
  // input event, but we only commit to minHeight (and re-query) after the
  // user stops moving for QUERY_DEBOUNCE_MS.
  useEffect(() => {
    if (pendingMinHeight === minHeight) return;
    const t = setTimeout(() => setMinHeight(pendingMinHeight), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [pendingMinHeight, minHeight]);

  // Re-run the query whenever the committed minHeight changes (and the map
  // is already mounted).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!map.isStyleLoaded()) return;
    void runQuery(map, minHeight);
  }, [minHeight, runQuery]);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_STYLE,
      center: [-73.985, 40.758],
      zoom: 14.5,
      pitch: 50,
    });
    mapRef.current = map;

    map.on("load", () => {
      map.addSource("buildings", { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: "buildings-fill",
        type: "fill-extrusion",
        source: "buildings",
        paint: {
          "fill-extrusion-color": [
            "step",
            ["coalesce", ["get", "height"], 3],
            "#74c476",
            5,
            "#fdd835",
            15,
            "#fb8c00",
            40,
            "#e53935",
            100,
            "#6a1b9a",
          ],
          "fill-extrusion-height": ["coalesce", ["get", "height"], 3],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.85,
        },
      });
      // First query uses the current debounced minHeight at mount time.
      void runQuery(map, minHeight);
    });
    map.on("moveend", () => void runQuery(map, minHeight));

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // We intentionally only set up the map once; subsequent minHeight changes
    // are handled by the dedicated useEffect above so we don't tear down the
    // MapLibre instance every time the slider stops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runQuery]);

  return (
    <div>
      <div style={controls}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ minWidth: 110 }}>min height (m):</span>
          <input
            type="range"
            min={SLIDER_MIN}
            max={SLIDER_MAX}
            step={SLIDER_STEP}
            value={pendingMinHeight}
            onChange={(e) => setPendingMinHeight(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{ minWidth: 36, textAlign: "right" }}>
            {pendingMinHeight}
          </span>
        </label>
        {busy && (
          <span style={{ color: "#888", fontSize: 12 }}>(querying…)</span>
        )}
      </div>
      <div
        ref={containerRef}
        style={{ width: "100%", height: "60vh", position: "relative" }}
      />
      <pre style={pre}>{status}</pre>
    </div>
  );
}

const controls: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "1rem",
  padding: "0.5rem 0",
};

const pre: React.CSSProperties = {
  background: "#f4f4f4",
  padding: "0.5rem 0.75rem",
  fontSize: 12,
  margin: "0.5rem 0 0",
};
