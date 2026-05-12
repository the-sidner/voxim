/// <reference lib="dom" />
/**
 * Asset browser — lazy filesystem tree for packages/content/data/.
 *
 * Reads directory listings from /content-list/{path} (see
 * serve_devtools.ts). Each directory expands on click; files trigger
 * `onPickFile(path)` so the active editor decides what to do with the
 * selection (load it, route to a different editor, ignore).
 *
 * No game-content imports. Pure file tree.
 */
import { useEffect, useState } from "preact/hooks";
import { listDir, type DirEntry } from "./file_io.ts";

interface Node {
  path: string;
  name: string;
  kind: "file" | "directory";
  expanded: boolean;
  children: Node[] | null;
}

function makeNode(entry: DirEntry, path: string): Node {
  return {
    path,
    name: entry.name,
    kind: entry.kind,
    expanded: false,
    children: entry.kind === "directory" ? null : [],
  };
}

export function AssetBrowser({
  filter,
  onPickFile,
}: {
  /** Restrict to subtrees starting with one of these dir names. Empty = all. */
  filter?: string[];
  onPickFile: (path: string) => void;
}) {
  const [roots, setRoots] = useState<Node[]>([]);
  const [, force] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    listDir("").then((entries) => {
      const allowed = entries.filter((e) =>
        e.kind === "directory" && (!filter || filter.includes(e.name))
      );
      setRoots(allowed.map((e) => makeNode(e, e.name)));
    });
  }, [filter?.join(",")]);

  const toggle = async (node: Node) => {
    if (node.kind === "file") {
      setPicked(node.path);
      onPickFile(node.path);
      return;
    }
    if (node.expanded) {
      node.expanded = false;
      force((n) => n + 1);
      return;
    }
    if (node.children === null) {
      const entries = await listDir(node.path);
      node.children = entries.map((e) => makeNode(e, `${node.path}/${e.name}`));
    }
    node.expanded = true;
    force((n) => n + 1);
  };

  return (
    <div style={{
      height: "100%",
      overflowY: "auto",
      fontSize: "12px",
      lineHeight: "1.4",
      padding: "8px 4px",
    }}>
      {roots.map((n) => (
        <NodeRow key={n.path} node={n} depth={0} picked={picked} onToggle={toggle} />
      ))}
    </div>
  );
}

function NodeRow({
  node, depth, picked, onToggle,
}: {
  node: Node;
  depth: number;
  picked: string | null;
  onToggle: (n: Node) => void;
}) {
  const pickedHere = picked === node.path;
  const icon = node.kind === "directory" ? (node.expanded ? "▾" : "▸") : "  ";
  return (
    <>
      <div
        onClick={() => onToggle(node)}
        style={{
          cursor: "pointer",
          paddingLeft: `${depth * 14 + 6}px`,
          background: pickedHere ? "#2a3a55" : undefined,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        onMouseOver={(e) => { if (!pickedHere) (e.currentTarget as HTMLElement).style.background = "#26262c"; }}
        onMouseOut={(e)  => { if (!pickedHere) (e.currentTarget as HTMLElement).style.background = ""; }}
      >
        <span style={{ color: node.kind === "directory" ? "#a6a6c0" : "#88aaff", marginRight: 4 }}>
          {icon}
        </span>
        <span style={{
          color: node.kind === "directory" ? "#cfd0e0" : "#9fcfff",
        }}>
          {node.kind === "file" ? stripExt(node.name) : node.name}
        </span>
      </div>
      {node.expanded && node.children?.map((c) => (
        <NodeRow key={c.path} node={c} depth={depth + 1} picked={picked} onToggle={onToggle} />
      ))}
    </>
  );
}

function stripExt(name: string): string {
  return name.endsWith(".json") ? name.slice(0, -5) : name;
}
