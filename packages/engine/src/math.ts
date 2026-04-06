/** 2D vector — world-space horizontal plane. */
export interface Vec2 {
  x: number;
  y: number;
}

/** 3D vector — world-space. z is vertical. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Entity ID — UUID v7 string.
 * Wire encoding uses raw 16 bytes; this string form is for runtime state and logging only.
 */
export type EntityId = string;

// ---- constructors ----

export function vec2(x: number, y: number): Vec2 {
  return { x, y };
}

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

// ---- vec2 ops ----

export function vec2Add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function vec2Scale(v: Vec2, s: number): Vec2 {
  return { x: v.x * s, y: v.y * s };
}

export function vec2LengthSq(v: Vec2): number {
  return v.x * v.x + v.y * v.y;
}

export function vec2Length(v: Vec2): number {
  return Math.sqrt(vec2LengthSq(v));
}

export function vec2Normalize(v: Vec2): Vec2 {
  const len = vec2Length(v);
  if (len === 0) return { x: 0, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

// ---- vec3 ops ----

export function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vec3Scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function vec3LengthSq(v: Vec3): number {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

export function vec3Length(v: Vec3): number {
  return Math.sqrt(vec3LengthSq(v));
}

// ---- entity id ----

/**
 * Generate a UUID v7 (time-ordered).
 * Layout: 48-bit ms timestamp | 4-bit version (0111) | 12-bit rand_a | 2-bit variant (10) | 62-bit rand_b
 */
export function newEntityId(): EntityId {
  const now = Date.now();

  // Split 48-bit timestamp: high 32 bits and low 16 bits
  const tsHigh32 = Math.floor(now / 0x10000) >>> 0; // bits 47..16
  const tsLow16 = now & 0xffff; // bits 15..0

  // Random segments
  const randA = (Math.random() * 0x1000) | 0; // 12 bits
  const randB0 = (Math.random() * 0x4000) | 0; // 14 bits (after 2-bit variant prefix)
  const randB1 = (Math.random() * 0x100000000) >>> 0; // 32 bits
  const randB2 = (Math.random() * 0x10000) | 0; // 16 bits

  const h = (n: number, len: number) => (n >>> 0).toString(16).padStart(len, "0");

  const p1 = h(tsHigh32, 8); // xxxxxxxx
  const p2 = h(tsLow16, 4); // xxxx
  const p3 = h(0x7000 | randA, 4); // 7xxx
  const p4 = h(0x8000 | randB0, 4); // 8xxx-bxxx (variant 10)
  const p5 = h(randB1, 8) + h(randB2, 4); // xxxxxxxxxxxx

  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}
