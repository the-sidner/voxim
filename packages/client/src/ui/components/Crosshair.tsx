export function Crosshair() {
  return (
    <div style={{
      position: "absolute", left: "50%", top: "50%",
      width: "6px", height: "6px",
      marginLeft: "-3px", marginTop: "-3px",
      borderRadius: "50%",
      background: "rgba(255,255,255,0.85)",
      boxShadow: "0 0 0 1.5px rgba(0,0,0,0.5)",
    }} />
  );
}
