import type { Node, Edge as RFEdge } from '@xyflow/react';

/**
 * Save format. The version field exists so a future schema change can migrate
 * old files instead of silently mis-loading them -- worth having from the
 * first release, since people will save designs before the schema settles.
 */
export const SAVE_VERSION = 1;

export interface SaveFile {
  /** What the person called this design. Becomes the download filename. */
  name: string;
  version: number;
  app: 'anodized';
  savedAt: string;
  duration: number;
  nodes: Node[];
  edges: RFEdge[];
}

export function serialize(
  nodes: Node[], edges: RFEdge[], duration: number, name: string,
): string {
  const file: SaveFile = {
    version: SAVE_VERSION,
    app: 'anodized',
    name: name.trim() || 'Untitled design',
    savedAt: new Date().toISOString(),
    duration,
    // Strip React Flow's transient UI state -- selection, drag flags, and
    // measured sizes are re-derived on load and only bloat the file.
    nodes: nodes.map((n) => ({
      id: n.id, type: n.type, position: n.position, data: n.data,
      // Mechanism boxes are resizable, so their size is real state.
      width: n.width, height: n.height, style: n.style,
    })) as Node[],
    edges: edges.map((e) => ({
      id: e.id, source: e.source, sourceHandle: e.sourceHandle,
      target: e.target, targetHandle: e.targetHandle,
      type: e.type, style: e.style, data: e.data,
    })) as RFEdge[],
  };
  return JSON.stringify(file, null, 2);
}

export class LoadError extends Error {}

export function deserialize(text: string): SaveFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LoadError('That file is not valid JSON.');
  }
  const f = parsed as Partial<SaveFile>;
  if (f.app !== 'anodized') {
    throw new LoadError('That does not look like an Anodized design file.');
  }
  if (typeof f.version !== 'number' || f.version > SAVE_VERSION) {
    throw new LoadError(
      `That file was saved by a newer version of Anodized (format ${f.version}). Update the app to open it.`,
    );
  }
  if (!Array.isArray(f.nodes) || !Array.isArray(f.edges)) {
    throw new LoadError('That design file is missing its nodes or edges.');
  }
  return {
    version: f.version,
    app: 'anodized',
    // Files saved before names existed still load -- they just come back
    // untitled rather than being rejected.
    name: typeof f.name === 'string' && f.name.trim() ? f.name : 'Untitled design',
    savedAt: f.savedAt ?? '',
    duration: typeof f.duration === 'number' ? f.duration : 1.5,
    nodes: f.nodes,
    edges: f.edges,
  };
}

/**
 * Block ids are generated as `${prefix}${n}`. After loading, the counter has to
 * clear every id already in the file, or the next block added would collide
 * with one that exists.
 */
export function highestIdSuffix(nodes: Node[]): number {
  let max = 0;
  for (const n of nodes) {
    const m = /(\d+)$/.exec(n.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

/**
 * Turn a design name into a safe download filename. Browsers and filesystems
 * disagree about which characters are legal, so strip to a conservative set
 * rather than trusting whatever was typed.
 */
export function filenameFor(name: string): string {
  const clean = name.trim()
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${clean || 'anodized-design'}.json`;
}

export function downloadJson(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
