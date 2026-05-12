/// <reference lib="dom" />
/**
 * Three-column layout used by every studio editor: left rail
 * (typically the asset browser / scene tree), centre (the 3D
 * viewport), right rail (inspector / properties for the selection).
 * Top bar reserved for route switching + tool actions.
 *
 * Pure layout primitive — knows nothing about content.
 */
import type { ComponentChildren } from "preact";

export function Layout({
  topBar,
  left,
  centre,
  right,
}: {
  topBar?: ComponentChildren;
  left?:   ComponentChildren;
  centre?: ComponentChildren;
  right?:  ComponentChildren;
}) {
  return (
    <div style={{
      flex: 1,
      display: "flex",
      flexDirection: "column",
      minHeight: 0,
    }}>
      {topBar && (
        <div style={{
          flex: "0 0 36px",
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          borderBottom: "1px solid #2a2a30",
          background: "#16161a",
        }}>
          {topBar}
        </div>
      )}
      <div style={{
        flex: 1,
        display: "flex",
        minHeight: 0,
      }}>
        {left !== undefined && (
          <div style={{
            flex: "0 0 240px",
            borderRight: "1px solid #2a2a30",
            background: "#1d1d22",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}>
            {left}
          </div>
        )}
        <div style={{
          flex: 1,
          position: "relative",
          minWidth: 0,
        }}>
          {centre}
        </div>
        {right !== undefined && (
          <div style={{
            flex: "0 0 280px",
            borderLeft: "1px solid #2a2a30",
            background: "#1d1d22",
            overflow: "auto",
          }}>
            {right}
          </div>
        )}
      </div>
    </div>
  );
}
