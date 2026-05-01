// STAC-driven in-memory spatial index for Overture GeoParquet.
//
// Walks the static STAC catalog at https://stac.overturemaps.org/, fetches
// every item under one (release, theme, type) collection in parallel, and
// keeps a flat array of (bbox, https url) tuples. `filesIntersecting(bbox)`
// is then a simple O(n) scan, n=512 for `theme=buildings/type=building`.
//
// We use the HTTPS asset URL (assets.aws.href), not the s3:// URL, because
// DuckDB-WASM reads via the browser fetch path which expects HTTPS.

const STAC_ROOT = "https://stac.overturemaps.org";

export type STACItem = {
  bbox: [number, number, number, number]; // [west, south, east, north]
  href: string; // https URL
};

export type Bbox = [number, number, number, number];

export type STACSpatialIndex = {
  release: string;
  theme: string;
  type: string;
  items: STACItem[];
  built: boolean;
  filesIntersecting: (bbox: Bbox) => string[];
  stats: () => { release: string; theme: string; type: string; indexed: number };
};

async function fetchJson<T = unknown>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return (await r.json()) as T;
}

function resolveHref(base: string, href: string): string {
  return new URL(href, base + "/").toString();
}

// Lightweight semaphore to throttle concurrent fetches so we don't blow past
// the browser's per-origin connection limit (Chrome ≈ 6) and queue lots of
// idle promises. Default of 16 is conservative but plenty fast for ~500
// items.
async function pMap<I, O>(
  items: I[],
  worker: (item: I) => Promise<O>,
  concurrency = 16,
): Promise<O[]> {
  const out = new Array<O>(items.length);
  let next = 0;
  const runOne = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runOne()),
  );
  return out;
}

export async function buildStacIndex(
  release: string,
  theme: string,
  type: string,
  onProgress?: (msg: string) => void,
): Promise<STACSpatialIndex> {
  const collectionUrl = `${STAC_ROOT}/${release}/${theme}/${type}/collection.json`;
  onProgress?.(`fetching collection: ${collectionUrl}`);
  const coll = await fetchJson<{
    links: { rel: string; href: string }[];
  }>(collectionUrl);

  const itemLinks = coll.links.filter((l) => l.rel === "item");
  const base = collectionUrl.substring(0, collectionUrl.lastIndexOf("/"));
  onProgress?.(`fetching ${itemLinks.length} item.json in parallel`);

  type ItemJson = {
    bbox: [number, number, number, number];
    assets: {
      aws?: { href?: string };
    };
  };

  const t0 = performance.now();
  const fetched = await pMap(itemLinks, async (link) => {
    const url = resolveHref(base, link.href);
    try {
      const item = await fetchJson<ItemJson>(url);
      const href = item.assets?.aws?.href;
      if (!item.bbox || item.bbox.length !== 4 || !href) return null;
      return { bbox: item.bbox, href } as STACItem;
    } catch {
      return null;
    }
  });
  const items = fetched.filter((x): x is STACItem => x !== null);
  const elapsedMs = Math.round(performance.now() - t0);
  onProgress?.(
    `STAC index ready: ${items.length}/${itemLinks.length} items in ${elapsedMs} ms`,
  );

  return {
    release,
    theme,
    type,
    items,
    built: true,
    filesIntersecting(query: Bbox): string[] {
      const [qw, qs, qe, qn] = query;
      const out: string[] = [];
      for (const it of items) {
        const [xmin, ymin, xmax, ymax] = it.bbox;
        if (xmin <= qe && xmax >= qw && ymin <= qn && ymax >= qs) {
          out.push(it.href);
        }
      }
      return out;
    },
    stats() {
      // Closure-captured variables, not `this.x`. Inferring `this` here
      // makes TypeScript widen the return type to `STACSpatialIndex |
      // PromiseLike<STACSpatialIndex>` because of how the async builder is
      // typed; sticking to closure values keeps the inference simple.
      return {
        release,
        theme,
        type,
        indexed: items.length,
      };
    },
  };
}
