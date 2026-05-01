// Browser-side query over Overture GeoParquet on S3 via DuckDB-WASM.
//
// Uses the STAC spatial index to pick the small set of files whose bbox
// intersects the tile bbox, hands that explicit list to read_parquet(), then
// row-group prunes inside those files via the WHERE on `bbox.{xmin,xmax,...}`.
// This is the WASM mirror of the server-side Python pipeline in the sibling
// study (study-cng-overture-buildings-tile).

import type * as duckdb from "@duckdb/duckdb-wasm";

import type { Bbox, STACSpatialIndex } from "./stacIndex";

export type QueryOptions = {
  minHeight?: number;
  limit?: number;
};

export type QueryResult = {
  fc: GeoJSON.FeatureCollection;
  filesQueried: number;
  rowsReturned: number;
  durationMs: number;
};

export async function queryBuildingsInBbox(
  conn: duckdb.AsyncDuckDBConnection,
  stacIndex: STACSpatialIndex,
  bbox: Bbox,
  opts: QueryOptions = {},
): Promise<QueryResult> {
  const files = stacIndex.filesIntersecting(bbox);
  const t0 = performance.now();
  if (files.length === 0) {
    return {
      fc: { type: "FeatureCollection", features: [] },
      filesQueried: 0,
      rowsReturned: 0,
      durationMs: Math.round(performance.now() - t0),
    };
  }

  const [west, south, east, north] = bbox;
  const minHeight = opts.minHeight ?? 0;
  // Per-row cost in DuckDB-WASM is ~50-100 ms regardless of whether geometry
  // serialization goes through ST_AsGeoJSON or ST_AsWKB (we measured both).
  // The right knob is the WHERE clause, not the limit. Default 1000 is a
  // safety cap; in practice an urban tile combined with a height filter
  // brings the result into the hundreds.
  const limit = opts.limit ?? 1000;
  const fileList = "[" + files.map((f) => `'${f}'`).join(", ") + "]";

  const sql = `
    SELECT
      id,
      ST_AsGeoJSON(geometry) AS geom_json,
      height,
      num_floors,
      class
    FROM read_parquet(${fileList})
    WHERE bbox.xmin <= ${east}
      AND bbox.xmax >= ${west}
      AND bbox.ymin <= ${north}
      AND bbox.ymax >= ${south}
      AND (${minHeight} <= 0 OR (height IS NOT NULL AND height >= ${minHeight}))
    LIMIT ${limit}
  `;

  const arrow = await conn.query(sql);
  const features: GeoJSON.Feature[] = [];
  let rowCount = 0;
  for (const row of arrow) {
    rowCount += 1;
    const geomJson = row.geom_json as string | null;
    if (!geomJson) continue;
    try {
      features.push({
        type: "Feature",
        geometry: JSON.parse(geomJson) as GeoJSON.Geometry,
        properties: {
          id: row.id ?? null,
          height: toNum(row.height),
          num_floors: toNum(row.num_floors),
          class: row.class ?? null,
        },
      });
    } catch {
      // skip rows whose geom_json is not parseable
    }
  }

  return {
    fc: { type: "FeatureCollection", features },
    filesQueried: files.length,
    rowsReturned: rowCount,
    durationMs: Math.round(performance.now() - t0),
  };
}

// Apache Arrow returns BigInt for some numeric columns; React + JSON cannot
// handle BigInt directly. Coerce to plain Number, preserving null.
function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
