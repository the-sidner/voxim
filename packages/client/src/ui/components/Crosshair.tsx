/**
 * Crosshair — Dreamborn does not bloom or pulse the centre dot.  A single
 * ember pixel inside a bone-faint hairline ring.  The world below must
 * read through it.
 */
export function Crosshair() {
  return (
    <div style={{
      position: "fixed", left: "50%", top: "50%",
      width: "8px", height: "8px",
      marginLeft: "-4px", marginTop: "-4px",
      border: "1px solid var(--bone-faint)",
      pointerEvents: "none",
    }}>
      <div style={{
        position: "absolute", left: "50%", top: "50%",
        width: "2px", height: "2px",
        marginLeft: "-1px", marginTop: "-1px",
        background: "var(--ember)",
      }} />
    </div>
  );
}
