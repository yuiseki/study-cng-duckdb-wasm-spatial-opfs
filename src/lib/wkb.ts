// Minimal WKB → GeoJSON parser. Supports only Polygon (3) and MultiPolygon
// (6), which is what Overture Buildings ever emits. We keep this in-tree
// instead of pulling a wkb library because (a) the surface we need is tiny
// and (b) every byte of bundle size matters for a study about browser-only.
//
// WKB format (OGC SFA, ISO 19125):
//   byte order (1 byte): 0=big endian, 1=little endian
//   type (4 bytes): geometry type id, possibly with Z/M/SRID flag bits
//   payload depends on type
//
// For Polygon: numRings (uint32) [ numPoints (uint32) [x y]* ]*
// For MultiPolygon: numPolygons (uint32) [ Polygon ]*  (each polygon has its
//   own leading byte order + type bytes)

import type { Geometry, MultiPolygon, Polygon, Position } from "geojson";

type Cursor = { offset: number };

const TYPE_POLYGON = 3;
const TYPE_MULTIPOLYGON = 6;

export function parseWKB(buf: Uint8Array): Geometry {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return readGeometry(view, { offset: 0 });
}

function readGeometry(view: DataView, c: Cursor): Geometry {
  const byteOrder = view.getUint8(c.offset);
  c.offset += 1;
  const le = byteOrder === 1;
  const type = view.getUint32(c.offset, le);
  c.offset += 4;
  // Strip Z/M/SRID flags. Overture buildings are 2D so these are noops, but
  // keep the mask to be safe against EWKB extensions.
  const base = type & 0xff;
  if (base === TYPE_POLYGON) return readPolygon(view, c, le);
  if (base === TYPE_MULTIPOLYGON) return readMultiPolygon(view, c, le);
  throw new Error(`unsupported WKB type ${type}`);
}

function readPolygon(view: DataView, c: Cursor, le: boolean): Polygon {
  return {
    type: "Polygon",
    coordinates: readRings(view, c, le),
  };
}

function readMultiPolygon(view: DataView, c: Cursor, le: boolean): MultiPolygon {
  const n = view.getUint32(c.offset, le);
  c.offset += 4;
  const polygons: Position[][][] = new Array(n);
  for (let i = 0; i < n; i++) {
    // each nested polygon repeats byte-order + type prefix
    const byteOrder = view.getUint8(c.offset);
    c.offset += 1;
    const innerLe = byteOrder === 1;
    c.offset += 4; // skip nested type
    polygons[i] = readRings(view, c, innerLe);
  }
  return { type: "MultiPolygon", coordinates: polygons };
}

function readRings(view: DataView, c: Cursor, le: boolean): Position[][] {
  const numRings = view.getUint32(c.offset, le);
  c.offset += 4;
  const rings: Position[][] = new Array(numRings);
  for (let i = 0; i < numRings; i++) {
    const numPoints = view.getUint32(c.offset, le);
    c.offset += 4;
    const ring: Position[] = new Array(numPoints);
    for (let j = 0; j < numPoints; j++) {
      const x = view.getFloat64(c.offset, le);
      c.offset += 8;
      const y = view.getFloat64(c.offset, le);
      c.offset += 8;
      ring[j] = [x, y];
    }
    rings[i] = ring;
  }
  return rings;
}
