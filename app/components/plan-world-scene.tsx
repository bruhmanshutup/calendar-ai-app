"use client";

import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";

/**
 * PlanWorld — the full-screen, scroll-driven 3D story behind the landing page.
 *
 * A real, solid disc (lacquered platter, felt top, metal spindle, studded
 * rim) sits under one warm key light that casts soft shadows. Everyday
 * things (stacks of books, assignment sheets, folded laundry, spray bottles
 * for chores, mugs, pencils) drift in as "the mess", then settle onto the
 * disc. One assignment floats up and glows warm until it's confirmed.
 * Finally six more discs rise into a stacked week.
 * Everything is procedural Three.js — no external scene files.
 */

const TAU = Math.PI * 2;
const R = 2.6; // main disc radius
const ITEM_Y = 0.13; // top of the felt

// Calm, dusty palette — nothing neon.
const PAL = {
  fog: "#0f0e15",
  discBody: "#33303f",
  discBodyAlt: "#313743",
  felt: "#4a4462",
  feltAlt: "#3f4c57",
  metal: "#b8b3c6",
  brass: "#d6c39a",
  lavender: "#8f86b8",
  rose: "#b58f96",
  slate: "#7f9db0",
  sand: "#c2ad8a",
  paper: "#ece6da",
  line: "#a9a2c2",
  fabricA: "#9ea6c2",
  fabricB: "#c7b3ad",
  fabricC: "#d8d2c5",
  coffee: "#5a4638",
  graphite: "#3a3945",
  amber: "#e0b56f",
  star: "#b9b3cf",
} as const;

const COVERS = [PAL.lavender, PAL.rose, PAL.slate, PAL.sand];

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (value: number) => {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
};
const range = (p: number, from: number, to: number) => smooth((p - from) / (to - from));

/* ------------------------------------------------------------------ */
/* Camera                                                              */

type CameraKey = { p: number; pos: [number, number, number]; look: [number, number, number] };
const CAMERA_PATH: CameraKey[] = [
  { p: 0.0, pos: [-3.0, 4.4, 7.2], look: [-2.7, 0.1, 0] },
  { p: 0.2, pos: [4.5, 2.4, 6.5], look: [0, 0.3, 0] },
  { p: 0.45, pos: [1.9, 6.4, 4.0], look: [1.6, 0, 0.2] },
  { p: 0.65, pos: [-3.4, 2.0, 4.6], look: [-1.3, 0.9, 0.3] },
  { p: 0.85, pos: [3.4, 5.5, 13.5], look: [3.4, 2.6, 0] },
  { p: 1.0, pos: [3.4, 3.6, 10.5], look: [3.4, 1.8, 0] },
];

function sampleCamera(p: number, outPos: THREE.Vector3, outLook: THREE.Vector3) {
  let a = CAMERA_PATH[0];
  let b = CAMERA_PATH[CAMERA_PATH.length - 1];
  for (let i = 0; i < CAMERA_PATH.length - 1; i += 1) {
    if (p >= CAMERA_PATH[i].p && p <= CAMERA_PATH[i + 1].p) {
      a = CAMERA_PATH[i];
      b = CAMERA_PATH[i + 1];
      break;
    }
  }
  const t = a === b ? 0 : smooth((p - a.p) / (b.p - a.p));
  outPos.set(
    THREE.MathUtils.lerp(a.pos[0], b.pos[0], t),
    THREE.MathUtils.lerp(a.pos[1], b.pos[1], t),
    THREE.MathUtils.lerp(a.pos[2], b.pos[2], t),
  );
  outLook.set(
    THREE.MathUtils.lerp(a.look[0], b.look[0], t),
    THREE.MathUtils.lerp(a.look[1], b.look[1], t),
    THREE.MathUtils.lerp(a.look[2], b.look[2], t),
  );
}

export type PlanWorldProps = {
  progressRef: MutableRefObject<number>;
  reducedMotion: boolean;
  interactive: boolean;
  onReady?: () => void;
};

function CameraRig({ progressRef, interactive, reducedMotion }: PlanWorldProps) {
  const scratch = useRef({ pos: new THREE.Vector3(), look: new THREE.Vector3(), currentLook: new THREE.Vector3(0, 0, 0) });
  useFrame((state, delta) => {
    const { pos, look, currentLook } = scratch.current;
    sampleCamera(progressRef.current, pos, look);
    if (interactive) {
      pos.x += state.pointer.x * 0.6;
      pos.y += state.pointer.y * 0.35;
    }
    const k = reducedMotion ? 1 : 1 - Math.exp(-delta * 5);
    const cam = state.camera;
    cam.position.lerp(pos, k);
    currentLook.lerp(look, k);
    cam.lookAt(currentLook);
  });
  return null;
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */

/** Solid disc with rounded (beveled) edges, centered on y = 0. */
function discGeometry(radius: number) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, radius, 0, TAU, false);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.14,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.04,
    bevelSegments: 5,
    curveSegments: 96,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -0.07, 0);
  return geometry;
}

/** Soft-edged slab (folded fabric, etc.) with its bottom at y = 0. */
function roundedSlab(width: number, depth: number, height: number, radius: number) {
  const w = width / 2 - radius;
  const d = depth / 2 - radius;
  const s = new THREE.Shape();
  s.moveTo(-w, -d - radius);
  s.lineTo(w, -d - radius);
  s.quadraticCurveTo(w + radius, -d - radius, w + radius, -d);
  s.lineTo(w + radius, d);
  s.quadraticCurveTo(w + radius, d + radius, w, d + radius);
  s.lineTo(-w, d + radius);
  s.quadraticCurveTo(-w - radius, d + radius, -w - radius, d);
  s.lineTo(-w - radius, -d);
  s.quadraticCurveTo(-w - radius, -d - radius, -w, -d - radius);
  const bevel = Math.min(height * 0.35, 0.025);
  const geometry = new THREE.ExtrudeGeometry(s, {
    depth: height - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 8,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, bevel, 0);
  return geometry;
}

const SHADOW = { castShadow: true, receiveShadow: true } as const;

/* ------------------------------------------------------------------ */
/* The disc                                                            */

function Platter({
  radius = R,
  body = PAL.discBody,
  felt = PAL.felt,
  studs = true,
}: {
  radius?: number;
  body?: string;
  felt?: string;
  studs?: boolean;
}) {
  const geometry = useMemo(() => discGeometry(radius), [radius]);
  const studAngles = useMemo(() => Array.from({ length: 24 }, (_, index) => (index / 24) * TAU), []);
  return (
    <group>
      <mesh geometry={geometry} {...SHADOW}>
        <meshPhysicalMaterial color={body} roughness={0.42} metalness={0.15} clearcoat={0.7} clearcoatRoughness={0.25} />
      </mesh>
      <mesh position={[0, 0.12, 0]} receiveShadow>
        <cylinderGeometry args={[radius - 0.18, radius - 0.18, 0.02, 96]} />
        <meshStandardMaterial color={felt} roughness={0.95} />
      </mesh>
      {studs &&
        studAngles.map((angle, index) => (
          <mesh
            key={index}
            position={[Math.cos(angle) * (radius - 0.09), 0.118, -Math.sin(angle) * (radius - 0.09)]}
            castShadow
          >
            <cylinderGeometry args={[index % 6 === 0 ? 0.035 : 0.022, index % 6 === 0 ? 0.035 : 0.022, 0.018, 16]} />
            <meshStandardMaterial color={PAL.metal} metalness={0.85} roughness={0.3} />
          </mesh>
        ))}
      <mesh position={[0, 0.2, 0]} castShadow>
        <cylinderGeometry args={[0.055, 0.065, 0.14, 24]} />
        <meshStandardMaterial color={PAL.metal} metalness={0.9} roughness={0.22} />
      </mesh>
      <mesh position={[0, 0.275, 0]} castShadow>
        <sphereGeometry args={[0.055, 24, 16]} />
        <meshStandardMaterial color={PAL.metal} metalness={0.9} roughness={0.22} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Clock: face, hour markers, and hands for the main disc              */

const FACE_R = R - 0.18; // matches the felt

function clockFaceTexture() {
  const size = 1024;
  const c = size / 2;
  const px = c / FACE_R; // pixels per world unit
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    context.lineCap = "round";
    context.strokeStyle = "#e7dfcf";
    for (let i = 0; i < 60; i += 1) {
      const angle = (i / 60) * TAU;
      const major = i % 5 === 0;
      const inner = (major ? 2.2 : 2.28) * px;
      const outer = 2.37 * px;
      context.globalAlpha = major ? 0.85 : 0.4;
      context.lineWidth = major ? 7 : 3;
      context.beginPath();
      context.moveTo(c + Math.sin(angle) * inner, c - Math.cos(angle) * inner);
      context.lineTo(c + Math.sin(angle) * outer, c - Math.cos(angle) * outer);
      context.stroke();
    }
    context.globalAlpha = 0.88;
    context.fillStyle = "#e7dfcf";
    context.font = "600 64px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (let hour = 1; hour <= 12; hour += 1) {
      const angle = (hour / 12) * TAU;
      const r = 1.98 * px;
      context.fillText(String(hour), c + Math.sin(angle) * r, c - Math.cos(angle) * r + 3);
    }
    context.globalAlpha = 0.4;
    context.font = "600 26px system-ui, sans-serif";
    context.fillText("P L A N P I L O T", c, c + 0.42 * px);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** A tapered clock hand lying flat, pointing toward -z (12 o'clock), bottom at y = 0. */
function handGeometry(length: number, width: number, tail: number) {
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, -tail);
  shape.lineTo(width / 2, -tail);
  shape.lineTo(width * 0.32, length * 0.86);
  shape.lineTo(0, length);
  shape.lineTo(-width * 0.32, length * 0.86);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.016,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.006,
    bevelSegments: 2,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, 0.006, 0);
  return geometry;
}

function ClockFace() {
  const face = useMemo(() => clockFaceTexture(), []);
  const markers = useMemo(() => Array.from({ length: 12 }, (_, hour) => hour), []);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.1315, 0]} receiveShadow>
        <circleGeometry args={[FACE_R, 96]} />
        <meshStandardMaterial map={face} transparent depthWrite={false} roughness={0.95} />
      </mesh>
      {markers.map((hour) => {
        const angle = (hour / 12) * TAU;
        const major = hour % 3 === 0;
        return (
          <mesh
            key={hour}
            position={[Math.sin(angle) * (R - 0.09), 0.122, -Math.cos(angle) * (R - 0.09)]}
            rotation={[0, -angle, 0]}
            castShadow
          >
            <boxGeometry args={[major ? 0.07 : 0.035, 0.024, major ? 0.15 : 0.1]} />
            <meshStandardMaterial color={major ? PAL.brass : PAL.metal} metalness={0.85} roughness={0.28} />
          </mesh>
        );
      })}
    </group>
  );
}

function ClockHands({ progressRef, reducedMotion }: { progressRef: MutableRefObject<number>; reducedMotion: boolean }) {
  const geometries = useMemo(
    () => ({
      hour: handGeometry(1.15, 0.15, 0.2),
      minute: handGeometry(1.8, 0.1, 0.24),
      second: handGeometry(1.95, 0.03, 0.4),
    }),
    [],
  );
  const hour = useRef<THREE.Group>(null);
  const minute = useRef<THREE.Group>(null);
  const second = useRef<THREE.Group>(null);
  useFrame(() => {
    const now = new Date();
    const seconds = now.getSeconds() + (reducedMotion ? 0 : now.getMilliseconds() / 1000);
    const minutes = now.getMinutes() + seconds / 60;
    const hours = (now.getHours() % 12) + minutes / 60;
    // While things get sorted, the minute hand fast-forwards two full turns.
    const gather = range(progressRef.current, 0.28, 0.5);
    if (hour.current) hour.current.rotation.y = -(hours / 12) * TAU;
    if (minute.current) minute.current.rotation.y = -((minutes / 60) * TAU + gather * TAU * 2);
    if (second.current) second.current.rotation.y = -(seconds / 60) * TAU;
  });
  return (
    <group>
      <mesh position={[0, 0.465, 0]} castShadow>
        <cylinderGeometry args={[0.055, 0.075, 0.67, 24]} />
        <meshStandardMaterial color={PAL.metal} metalness={0.9} roughness={0.22} />
      </mesh>
      <group ref={hour} position={[0, 0.7, 0]}>
        <mesh geometry={geometries.hour} castShadow>
          <meshStandardMaterial color={PAL.brass} metalness={0.75} roughness={0.3} />
        </mesh>
      </group>
      <group ref={minute} position={[0, 0.74, 0]}>
        <mesh geometry={geometries.minute} castShadow>
          <meshStandardMaterial color={PAL.brass} metalness={0.75} roughness={0.3} />
        </mesh>
      </group>
      <group ref={second} position={[0, 0.78, 0]}>
        <mesh geometry={geometries.second} castShadow>
          <meshStandardMaterial color={PAL.rose} metalness={0.3} roughness={0.45} />
        </mesh>
        <mesh position={[0, 0.012, 0.3]} castShadow>
          <cylinderGeometry args={[0.05, 0.05, 0.02, 24]} />
          <meshStandardMaterial color={PAL.rose} metalness={0.3} roughness={0.45} />
        </mesh>
      </group>
      <mesh position={[0, 0.81, 0]} castShadow>
        <sphereGeometry args={[0.07, 24, 16]} />
        <meshStandardMaterial color={PAL.brass} metalness={0.8} roughness={0.25} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Everyday objects (built resting on y = 0)                           */

function Book({ cover }: { cover: string }) {
  return (
    <group>
      <mesh position={[0, 0.0125, 0]} {...SHADOW}>
        <boxGeometry args={[0.56, 0.025, 0.42]} />
        <meshStandardMaterial color={cover} roughness={0.6} />
      </mesh>
      <mesh position={[0.012, 0.06, 0]} {...SHADOW}>
        <boxGeometry args={[0.53, 0.07, 0.4]} />
        <meshStandardMaterial color={PAL.paper} roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.1075, 0]} {...SHADOW}>
        <boxGeometry args={[0.56, 0.025, 0.42]} />
        <meshStandardMaterial color={cover} roughness={0.6} />
      </mesh>
      <mesh position={[-0.27, 0.06, 0]} {...SHADOW}>
        <boxGeometry args={[0.035, 0.12, 0.42]} />
        <meshStandardMaterial color={cover} roughness={0.6} />
      </mesh>
      <mesh position={[0.04, 0.1215, -0.09]}>
        <boxGeometry args={[0.26, 0.003, 0.05]} />
        <meshStandardMaterial color={PAL.paper} roughness={0.7} />
      </mesh>
    </group>
  );
}

function Books({ a, b }: { a: string; b: string }) {
  return (
    <group>
      <Book cover={a} />
      <group position={[0.03, 0.12, 0.02]} rotation={[0, 0.28, 0]} scale={0.9}>
        <Book cover={b} />
      </group>
    </group>
  );
}

function Papers() {
  return (
    <group>
      {[0, 1, 2].map((index) => (
        <group key={index} position={[index * 0.015, index * 0.007, -index * 0.01]} rotation={[0, (index - 1) * 0.08, 0]}>
          <mesh position={[0, 0.003, 0]} {...SHADOW}>
            <boxGeometry args={[0.42, 0.006, 0.55]} />
            <meshStandardMaterial color={PAL.paper} roughness={0.95} />
          </mesh>
          {index === 2 && (
            <>
              <mesh position={[-0.08, 0.0065, -0.2]}>
                <boxGeometry args={[0.16, 0.002, 0.03]} />
                <meshStandardMaterial color={PAL.lavender} roughness={0.8} />
              </mesh>
              {[0, 1, 2, 3, 4, 5].map((line) => (
                <mesh key={line} position={[line === 5 ? -0.05 : 0, 0.0065, -0.12 + line * 0.06]}>
                  <boxGeometry args={[line === 5 ? 0.2 : 0.3, 0.002, 0.012]} />
                  <meshStandardMaterial color={PAL.line} roughness={0.8} />
                </mesh>
              ))}
            </>
          )}
        </group>
      ))}
    </group>
  );
}

function Laundry() {
  const slab = useMemo(() => roundedSlab(0.5, 0.38, 0.08, 0.06), []);
  return (
    <group>
      {[PAL.fabricA, PAL.fabricB, PAL.fabricC].map((color, index) => (
        <mesh
          key={color}
          geometry={slab}
          position={[(index - 1) * 0.012, index * 0.082, (index % 2) * 0.01]}
          rotation={[0, (index - 1) * 0.06, 0]}
          {...SHADOW}
        >
          <meshStandardMaterial color={color} roughness={0.95} />
        </mesh>
      ))}
    </group>
  );
}

function SprayBottle() {
  const body = useMemo(
    () =>
      new THREE.LatheGeometry(
        [
          [0.0, 0.0],
          [0.11, 0.0],
          [0.12, 0.015],
          [0.12, 0.3],
          [0.105, 0.36],
          [0.06, 0.4],
          [0.042, 0.42],
          [0.0, 0.42],
        ].map(([x, y]) => new THREE.Vector2(x, y)),
        32,
      ),
    [],
  );
  return (
    <group>
      <mesh geometry={body} {...SHADOW}>
        <meshStandardMaterial color={PAL.slate} roughness={0.28} metalness={0.05} />
      </mesh>
      <mesh position={[0, 0.16, 0]} {...SHADOW}>
        <cylinderGeometry args={[0.123, 0.123, 0.12, 32]} />
        <meshStandardMaterial color={PAL.paper} roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.445, 0]} {...SHADOW}>
        <cylinderGeometry args={[0.035, 0.04, 0.05, 16]} />
        <meshStandardMaterial color={PAL.paper} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.5, 0.03]} {...SHADOW}>
        <boxGeometry args={[0.08, 0.075, 0.17]} />
        <meshStandardMaterial color={PAL.paper} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.5, 0.135]} castShadow>
        <boxGeometry args={[0.035, 0.035, 0.05]} />
        <meshStandardMaterial color={PAL.graphite} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.42, 0.09]} rotation={[0.35, 0, 0]} castShadow>
        <boxGeometry args={[0.025, 0.11, 0.035]} />
        <meshStandardMaterial color={PAL.paper} roughness={0.5} />
      </mesh>
    </group>
  );
}

function Mug() {
  return (
    <group>
      <mesh position={[0, 0.15, 0]} {...SHADOW}>
        <cylinderGeometry args={[0.14, 0.13, 0.3, 32]} />
        <meshStandardMaterial color={PAL.paper} roughness={0.3} />
      </mesh>
      <mesh position={[0, 0.19, 0]}>
        <cylinderGeometry args={[0.1415, 0.1395, 0.06, 32]} />
        <meshStandardMaterial color={PAL.lavender} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.297, 0]}>
        <cylinderGeometry args={[0.12, 0.12, 0.01, 32]} />
        <meshStandardMaterial color={PAL.coffee} roughness={0.2} />
      </mesh>
      <mesh position={[0.16, 0.16, 0]} {...SHADOW}>
        <torusGeometry args={[0.075, 0.024, 12, 28]} />
        <meshStandardMaterial color={PAL.paper} roughness={0.3} />
      </mesh>
    </group>
  );
}

function Pencil() {
  return (
    <group position={[0, 0.03, 0]}>
      <mesh rotation={[0, 0, Math.PI / 2]} {...SHADOW}>
        <cylinderGeometry args={[0.03, 0.03, 0.42, 6]} />
        <meshStandardMaterial color={PAL.sand} roughness={0.55} />
      </mesh>
      <mesh position={[0.245, 0, 0]} rotation={[0, 0, -Math.PI / 2]} castShadow>
        <coneGeometry args={[0.03, 0.07, 6]} />
        <meshStandardMaterial color={PAL.paper} roughness={0.8} />
      </mesh>
      <mesh position={[0.275, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.01, 0.022, 6]} />
        <meshStandardMaterial color={PAL.graphite} />
      </mesh>
      <mesh position={[-0.235, 0, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.031, 0.031, 0.05, 12]} />
        <meshStandardMaterial color={PAL.rose} roughness={0.8} />
      </mesh>
    </group>
  );
}

type Kind = "books" | "papers" | "laundry" | "spray" | "mug" | "pencil";
const KIND_CYCLE: Kind[] = ["books", "papers", "laundry", "mug", "papers", "spray", "books", "pencil", "laundry", "papers", "books", "mug", "spray"];

function ItemView({ kind, seed }: { kind: Kind; seed: number }) {
  if (kind === "books") return <Books a={COVERS[seed % COVERS.length]} b={COVERS[(seed + 2) % COVERS.length]} />;
  if (kind === "papers") return <Papers />;
  if (kind === "laundry") return <Laundry />;
  if (kind === "spray") return <SprayBottle />;
  if (kind === "mug") return <Mug />;
  return <Pencil />;
}

/* ------------------------------------------------------------------ */
/* Items that converge onto the disc                                   */

type ItemData = {
  kind: Kind;
  uncertain: boolean;
  far: THREE.Vector3;
  mess: THREE.Vector3;
  target: THREE.Vector3;
  startRot: THREE.Vector3;
  spin: THREE.Vector3;
  targetYaw: number;
};

const INNER_SLOTS = 8;
const OUTER_SLOTS = 13;

function buildItems(): ItemData[] {
  const random = seededRandom(2026);
  const list: ItemData[] = [];
  let uncertainAssigned = false;
  const total = INNER_SLOTS + OUTER_SLOTS;
  for (let n = 0; n < total; n += 1) {
    const inner = n < INNER_SLOTS;
    const index = inner ? n : n - INNER_SLOTS;
    const angle = inner ? (index / INNER_SLOTS) * TAU + 0.2 : (index / OUTER_SLOTS) * TAU;
    const radius = inner ? 0.98 : 1.66;
    const kind = KIND_CYCLE[n % KIND_CYCLE.length];
    const uncertain = !inner && kind === "papers" && !uncertainAssigned && index >= 2;
    if (uncertain) uncertainAssigned = true;
    const farAngle = random() * TAU;
    const farRadius = 5 + random() * 4;
    const messAngle = random() * TAU;
    const messRadius = 3 + random() * 2.5;
    list.push({
      kind,
      uncertain,
      far: new THREE.Vector3(Math.cos(farAngle) * farRadius, (random() - 0.4) * 5, Math.sin(farAngle) * farRadius),
      mess: new THREE.Vector3(Math.cos(messAngle) * messRadius, -0.3 + random() * 2.8, Math.sin(messAngle) * messRadius),
      target: new THREE.Vector3(Math.cos(angle) * radius, ITEM_Y, -Math.sin(angle) * radius),
      startRot: new THREE.Vector3(random() * TAU, random() * TAU, random() * TAU),
      spin: new THREE.Vector3((random() - 0.5) * 1.2, (random() - 0.5) * 1.2, (random() - 0.5) * 0.9),
      targetYaw: angle + Math.PI / 2 + (random() - 0.5) * 0.3,
    });
  }
  return list;
}

function Items({ progressRef, reducedMotion, interactive }: PlanWorldProps) {
  const items = useMemo(() => buildItems(), []);
  const groups = useRef<Array<THREE.Group | null>>([]);
  const hovered = useRef(-1);
  const hoverAmount = useRef<number[]>(Array.from({ length: 32 }, () => 0));
  const scratch = useRef({ v: new THREE.Vector3(), hover: new THREE.Vector3(0, 1.15, 0), amber: new THREE.Color(PAL.amber) });
  const glowLight = useRef<THREE.PointLight>(null);

  useFrame(({ clock }, delta) => {
    const p = progressRef.current;
    const appear = range(p, 0.06, 0.24);
    const approach = range(p, 0.08, 0.26);
    const gather = range(p, 0.28, 0.5);
    const lift = range(p, 0.55, 0.64) * (1 - range(p, 0.8, 0.88));
    const t = clock.getElapsedTime();
    const { v, hover, amber } = scratch.current;
    items.forEach((item, i) => {
      const group = groups.current[i];
      if (!group) return;
      v.copy(item.far).lerp(item.mess, approach).lerp(item.target, gather);
      if (!reducedMotion) v.y += Math.sin(t * 0.8 + i * 1.7) * 0.2 * (1 - gather);
      const amount = hoverAmount.current;
      amount[i] += ((hovered.current === i ? 1 : 0) - amount[i]) * Math.min(1, delta * 10);
      v.y += amount[i] * 0.18;
      let yaw = item.targetYaw;
      if (item.uncertain && lift > 0) {
        v.lerp(hover, lift);
        if (!reducedMotion) {
          v.y += Math.sin(t * 1.6) * 0.05 * lift;
          yaw += t * 0.4 * lift;
        }
        if (glowLight.current) {
          glowLight.current.position.set(v.x, v.y + 0.5, v.z);
          glowLight.current.intensity = lift * 6;
        }
      }
      if (item.uncertain) {
        const pulse = reducedMotion ? 1 : 1 + Math.sin(t * 3) * 0.2;
        group.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh) return;
          const material = mesh.material as THREE.MeshStandardMaterial;
          if (!mesh.userData.baseColor) mesh.userData.baseColor = material.color.clone();
          material.color.copy(mesh.userData.baseColor as THREE.Color).lerp(amber, lift * 0.45);
          material.emissive.copy(amber);
          material.emissiveIntensity = lift * 0.35 * pulse;
        });
      }
      group.position.copy(v);
      const spin = reducedMotion ? 0 : t * (1 - gather);
      const settle = Math.max(gather, 0);
      group.rotation.set(
        (item.startRot.x + item.spin.x * spin) * (1 - settle) + (item.uncertain ? lift * 0.25 : 0),
        THREE.MathUtils.lerp(item.startRot.y + item.spin.y * spin, yaw, settle),
        (item.startRot.z + item.spin.z * spin) * (1 - settle),
      );
      group.scale.setScalar(Math.max(0.001, appear) * (1 + amount[i] * 0.12));
    });
  });

  return (
    <>
      {items.map((item, index) => (
        <group
          key={index}
          ref={(element) => {
            groups.current[index] = element;
          }}
          onPointerOver={(event: ThreeEvent<PointerEvent>) => {
            if (!interactive) return;
            event.stopPropagation();
            hovered.current = index;
          }}
          onPointerOut={() => {
            if (hovered.current === index) hovered.current = -1;
          }}
        >
          <ItemView kind={item.kind} seed={index} />
        </group>
      ))}
      <pointLight ref={glowLight} color={PAL.amber} intensity={0} distance={3.5} decay={2} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Week stack                                                          */

function WeekStack({ progressRef, reducedMotion }: { progressRef: MutableRefObject<number>; reducedMotion: boolean }) {
  const group = useRef<THREE.Group>(null);
  const days = useMemo(
    () =>
      [1, 2, 3, 4, 5, 6].map((day) => {
        const scale = 1 - day * 0.06;
        const kinds = [0, 1, 2, 3].map((k) => KIND_CYCLE[(day * 3 + k) % KIND_CYCLE.length]);
        return {
          day,
          scale,
          items: kinds.map((kind, k) => {
            const angle = (k / 4) * TAU + day * 0.45;
            const radius = 1.55;
            return { kind, x: Math.cos(angle) * radius, z: -Math.sin(angle) * radius, yaw: angle + Math.PI / 2 };
          }),
        };
      }),
    [],
  );
  useFrame(({ clock }) => {
    if (!group.current) return;
    const show = range(progressRef.current, 0.7, 0.9);
    group.current.children.forEach((child, index) => {
      const local = smooth((show - index * 0.08) / 0.5);
      child.position.y = (index + 1) * 1.0 * local;
      child.scale.setScalar(Math.max(0.001, local) * days[index].scale);
      if (!reducedMotion) child.rotation.y = clock.getElapsedTime() * 0.06 * (index % 2 === 0 ? 1 : -1);
    });
  });
  return (
    <group ref={group}>
      {days.map((entry) => (
        <group key={entry.day}>
          <Platter
            body={entry.day % 2 === 0 ? PAL.discBody : PAL.discBodyAlt}
            felt={entry.day % 2 === 0 ? PAL.felt : PAL.feltAlt}
            studs={false}
          />
          {entry.items.map((item, index) => (
            <group key={index} position={[item.x, ITEM_Y, item.z]} rotation={[0, item.yaw, 0]} scale={0.85}>
              <ItemView kind={item.kind} seed={entry.day + index} />
            </group>
          ))}
        </group>
      ))}
    </group>
  );
}

function Stars({ reducedMotion }: { reducedMotion: boolean }) {
  const ref = useRef<THREE.Points>(null);
  const positions = useMemo(() => {
    const random = seededRandom(42);
    const count = 700;
    const array = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const r = 10 + random() * 22;
      const theta = random() * TAU;
      const phi = Math.acos(2 * random() - 1);
      array[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      array[i * 3 + 1] = r * Math.cos(phi) * 0.6;
      array[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    return array;
  }, []);
  useFrame((_, delta) => {
    if (ref.current && !reducedMotion) ref.current.rotation.y += delta * 0.008;
  });
  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color={PAL.star} size={0.045} sizeAttenuation transparent opacity={0.45} depthWrite={false} />
    </points>
  );
}

function World(props: PlanWorldProps) {
  const { reducedMotion, interactive } = props;
  const group = useRef<THREE.Group>(null);
  const drag = useRef({ active: false, lastX: 0, velocity: 0, spin: 0 });
  const { size } = useThree();
  useFrame((_, delta) => {
    if (!group.current) return;
    const d = drag.current;
    d.spin += d.velocity;
    d.velocity *= d.active ? 0.85 : 0.9;
    if (!d.active) d.spin += (0 - d.spin) * Math.min(1, delta * 1.6);
    group.current.rotation.y = d.spin;
  });
  const onPointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (!interactive) return;
    drag.current.active = true;
    drag.current.lastX = event.clientX;
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!drag.current.active) return;
    const dx = event.clientX - drag.current.lastX;
    drag.current.lastX = event.clientX;
    drag.current.velocity = (dx / size.width) * 2.2;
  };
  const onPointerUp = () => {
    drag.current.active = false;
  };
  return (
    <group ref={group} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}>
      <Platter studs={false} />
      <ClockFace />
      <ClockHands progressRef={props.progressRef} reducedMotion={reducedMotion} />
      <Items {...props} />
      <WeekStack progressRef={props.progressRef} reducedMotion={reducedMotion} />
    </group>
  );
}

export default function PlanWorldScene(props: PlanWorldProps) {
  return (
    <Canvas
      shadows="soft"
      dpr={[1, 1.6]}
      camera={{ position: [0, 3.2, 8.2], fov: 42, near: 0.1, far: 80 }}
      gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
      frameloop="always"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", background: "transparent" }}
      onCreated={() => props.onReady?.()}
    >
      <fog attach="fog" args={[PAL.fog, 15, 36]} />
      <hemisphereLight args={["#c4bfdb", "#1d1b26", 0.9]} />
      <ambientLight intensity={0.15} />
      <directionalLight
        position={[4, 10, 5]}
        intensity={2.7}
        color="#fff3e4"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-7}
        shadow-camera-right={7}
        shadow-camera-top={9}
        shadow-camera-bottom={-7}
        shadow-camera-near={1}
        shadow-camera-far={30}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />
      <directionalLight position={[-6, 3, -5]} intensity={0.6} color="#8f86b8" />
      {/* Invisible floor that only shows the shadows */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.6, 0]} receiveShadow>
        <planeGeometry args={[60, 60]} />
        <shadowMaterial opacity={0.35} />
      </mesh>
      <CameraRig {...props} />
      <Stars reducedMotion={props.reducedMotion} />
      <World {...props} />
    </Canvas>
  );
}
