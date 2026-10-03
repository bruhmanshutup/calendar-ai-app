"use client";

import { Environment, Html, useGLTF, useTexture } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { Suspense, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";

/**
 * PlanWorld — the full-screen, scroll-driven 3D story behind the landing page.
 *
 * A real, solid disc (lacquered platter, felt top, metal spindle, studded
 * rim) sits under one warm key light that casts soft shadows. Everyday
 * things (stacks of books, assignment sheets, folded laundry, spray bottles
 * for chores, mugs, pencils) drift in as "the mess", then settle onto the
 * disc. One assignment floats up and glows warm until it's confirmed.
 * Finally six more discs rise into a stacked week, each wrapped in a ring of
 * floating magepunk segments.
 *
 * Realism pass (copy only): the everyday things are photogrammetry scans from
 * Poly Haven (CC0), lit by a real photo-studio light probe; the clock is a
 * walnut-and-brass table with an enamel dial under a glass top. Fetch the
 * assets with `node scripts/fetch-polyhaven-assets.mjs`.
 */

const TAU = Math.PI * 2;
const R = 2.6; // main disc radius
const ITEM_Y = 0.17; // top of the glass

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
  bluedSteel: "#3d4a7a",
  gunmetal: "#171c2b",
  gold: "#d8b25e",
  teal: "#5ef2e0",
} as const;


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
  /** Called the first time the visitor drags the view. */
  onFirstDrag?: () => void;
};

/** How far the visitor has orbited the view away from the scripted camera path. */
type Orbit = {
  yaw: number;
  pitch: number;
  vYaw: number;
  vPitch: number;
  dragging: boolean;
  resetting: boolean;
  lastX: number;
  lastY: number;
  dragged: boolean;
};

const MIN_PHI = 0.08; // almost straight down from above
const MAX_PHI = 1.9; // a little below the clock, looking up

/** Click-and-drag anywhere on the scene to orbit; double-click to reset. */
function OrbitInput({
  orbitRef,
  interactive,
  onFirstDrag,
}: {
  orbitRef: MutableRefObject<Orbit>;
  interactive: boolean;
  onFirstDrag?: () => void;
}) {
  const element = useThree((state) => state.gl.domElement);
  useEffect(() => {
    if (!interactive) return;
    const orbit = orbitRef.current;
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      // Dragging the scene should never select page text.
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      orbit.dragging = true;
      orbit.resetting = false;
      orbit.lastX = event.clientX;
      orbit.lastY = event.clientY;
      orbit.vYaw = 0;
      orbit.vPitch = 0;
      element.setPointerCapture(event.pointerId);
      element.classList.add("is-dragging");
    };
    const move = (event: PointerEvent) => {
      if (!orbit.dragging) return;
      const width = element.clientWidth || 1;
      const dx = event.clientX - orbit.lastX;
      const dy = event.clientY - orbit.lastY;
      orbit.lastX = event.clientX;
      orbit.lastY = event.clientY;
      orbit.vYaw = -(dx / width) * Math.PI * 1.3;
      orbit.vPitch = (dy / width) * Math.PI * 1.3;
      orbit.yaw += orbit.vYaw;
      orbit.pitch += orbit.vPitch;
      if (!orbit.dragged && Math.abs(dx) + Math.abs(dy) > 2) {
        orbit.dragged = true;
        onFirstDrag?.();
      }
    };
    const up = (event: PointerEvent) => {
      if (!orbit.dragging) return;
      orbit.dragging = false;
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      element.classList.remove("is-dragging");
    };
    const reset = () => {
      orbit.resetting = true;
      orbit.vYaw = 0;
      orbit.vPitch = 0;
    };
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    element.addEventListener("dblclick", reset);
    return () => {
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      element.removeEventListener("dblclick", reset);
    };
  }, [element, interactive, orbitRef, onFirstDrag]);
  return null;
}

function CameraRig({
  progressRef,
  interactive,
  reducedMotion,
  orbitRef,
}: PlanWorldProps & { orbitRef: MutableRefObject<Orbit> }) {
  const scratch = useRef({
    pos: new THREE.Vector3(),
    look: new THREE.Vector3(),
    currentLook: new THREE.Vector3(0, 0, 0),
    offset: new THREE.Vector3(),
    right: new THREE.Vector3(),
    pivot: new THREE.Vector3(),
    spherical: new THREE.Spherical(),
    yawTurn: new THREE.Quaternion(),
    pitchTurn: new THREE.Quaternion(),
    turn: new THREE.Quaternion(),
    up: new THREE.Vector3(0, 1, 0),
  });
  useFrame((state, delta) => {
    const { pos, look, currentLook, offset, right, pivot, spherical, yawTurn, pitchTurn, turn, up } = scratch.current;
    const orbit = orbitRef.current;
    sampleCamera(progressRef.current, pos, look);

    // Let the view drift after a drag, or glide home after a double-click.
    if (!orbit.dragging) {
      if (!reducedMotion) {
        orbit.yaw += orbit.vYaw;
        orbit.pitch += orbit.vPitch;
      }
      orbit.vYaw *= 0.92;
      orbit.vPitch *= 0.92;
      if (orbit.resetting) {
        const ease = Math.min(1, delta * 4);
        orbit.yaw -= orbit.yaw * ease;
        orbit.pitch -= orbit.pitch * ease;
        if (Math.abs(orbit.yaw) < 0.001 && Math.abs(orbit.pitch) < 0.001) {
          orbit.yaw = 0;
          orbit.pitch = 0;
          orbit.resetting = false;
        }
      }
    }

    // Orbit around the center of the scene (the clock), turning the look
    // target with the camera so the clock keeps its place in the frame.
    // The whole camera rig turns rigidly: first around the upright axis
    // (yaw), then tilts around the horizontal axis (pitch).
    pivot.set(0, look.y, 0);
    offset.copy(pos).sub(pivot);
    spherical.setFromVector3(offset);
    orbit.pitch = THREE.MathUtils.clamp(orbit.pitch, spherical.phi - MAX_PHI, spherical.phi - MIN_PHI);
    yawTurn.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, orbit.yaw);
    offset.applyQuaternion(yawTurn);
    right.crossVectors(offset, THREE.Object3D.DEFAULT_UP).normalize();
    pitchTurn.setFromAxisAngle(right, orbit.pitch);
    turn.multiplyQuaternions(pitchTurn, yawTurn);
    pos.sub(pivot).applyQuaternion(turn).add(pivot);
    look.sub(pivot).applyQuaternion(turn).add(pivot);
    // Tilt the camera's "up" with the rig so the clock stays anchored in frame.
    up.copy(THREE.Object3D.DEFAULT_UP).applyQuaternion(turn);

    if (interactive && !orbit.dragging) {
      pos.x += state.pointer.x * 0.35;
      pos.y += state.pointer.y * 0.2;
    }
    const k = reducedMotion ? 1 : 1 - Math.exp(-delta * (orbit.dragging ? 14 : 5));
    const cam = state.camera;
    cam.position.lerp(pos, k);
    currentLook.lerp(look, k);
    cam.up.lerp(up, k).normalize();
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
/* Assets (Poly Haven, CC0 — see scripts/fetch-polyhaven-assets.mjs)   */

const MODEL = {
  books: "/models/book_encyclopedia_set_01/book_encyclopedia_set_01.gltf",
  binder: "/models/binder_notebook/binder_notebook.gltf",
  notepads: "/models/office_notepads/office_notepads.gltf",
  spray: "/models/multi_cleaner_bottle/multi_cleaner_bottle.gltf",
  basket: "/models/wicker_basket_01/wicker_basket_01.gltf",
  tea: "/models/tea_set_01/tea_set_01.gltf",
  stationery: "/models/stationery_supplies/stationery_supplies.gltf",
  pillows: "/models/throw_pillows_01/throw_pillows_01.gltf",
  alarm: "/models/alarm_clock_01/alarm_clock_01.gltf",
  laptop: "/models/classic_laptop/classic_laptop.gltf",
  croissant: "/models/croissant/croissant.gltf",
  apple: "/models/food_apple_01/food_apple_01.gltf",
  football: "/models/football/football.gltf",
  gamepad: "/models/gamepad/gamepad.gltf",
} as const;
const HDRI = "/hdr/brown_photostudio_02_1k.hdr";
const WALNUT = {
  map: "/textures/walnut_veneer_02/Diffuse_1k.jpg",
  normalMap: "/textures/walnut_veneer_02/nor_gl_1k.jpg",
  roughnessMap: "/textures/walnut_veneer_02/Rough_1k.jpg",
};
const FABRIC = {
  map: "/textures/fabric_pattern_07/col_1_1k.jpg",
  normalMap: "/textures/fabric_pattern_07/nor_gl_1k.jpg",
  roughnessMap: "/textures/fabric_pattern_07/Rough_1k.jpg",
};
Object.values(MODEL).forEach((url) => useGLTF.preload(url));

/** Tiling + colour space for a scanned material set (runs once, when the files load). */
function prepareTextures(loaded: THREE.Texture | THREE.Texture[] | Record<string, THREE.Texture>, repeat: number, anisotropy: number) {
  const list = Array.isArray(loaded) ? loaded : loaded instanceof THREE.Texture ? [loaded] : Object.values(loaded);
  list.forEach((texture, index) => {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeat, repeat);
    texture.anisotropy = anisotropy;
    if (index === 0) texture.colorSpace = THREE.SRGBColorSpace; // the colour map comes first
    texture.needsUpdate = true;
  });
}

/** A named piece of a scan: one mesh, or several when it uses more than one material. */
type Piece = THREE.Mesh[];
type Parts = Record<string, Piece>;
function useParts(url: string): Parts {
  const { nodes } = useGLTF(url);
  return useMemo(() => {
    const parts: Parts = {};
    Object.entries(nodes).forEach(([name, object]) => {
      const meshes: THREE.Mesh[] = [];
      if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
      else object.children.forEach((child) => (child as THREE.Mesh).isMesh && meshes.push(child as THREE.Mesh));
      if (meshes.length) parts[name] = meshes;
    });
    return parts;
  }, [nodes]);
}

function pieceBox(piece: Piece): THREE.Box3 {
  const box = new THREE.Box3();
  piece.forEach((mesh) => {
    mesh.geometry.computeBoundingBox();
    box.union(mesh.geometry.boundingBox!);
  });
  return box;
}

/**
 * One scanned part, placed so its bottom-centre (or its centre) sits at the
 * group origin. `unique` gives this instance its own material so it can glow
 * without affecting the other copies that share the scan.
 */
function Part({
  part,
  unique = false,
  align = "bottom",
  position,
  rotation,
  scale = 1,
}: {
  part: Piece;
  unique?: boolean;
  align?: "bottom" | "center";
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number | [number, number, number];
}) {
  const offset = useMemo(() => {
    const box = pieceBox(part);
    const center = box.getCenter(new THREE.Vector3());
    return [-center.x, align === "bottom" ? -box.min.y : -center.y, -center.z] as [number, number, number];
  }, [part, align]);
  const materials = useMemo(
    () => part.map((mesh) => (unique ? (mesh.material as THREE.Material).clone() : (mesh.material as THREE.Material))),
    [part, unique],
  );
  return (
    <group position={position} rotation={rotation} scale={scale}>
      {part.map((mesh, index) => (
        <mesh key={index} geometry={mesh.geometry} material={materials[index]} position={offset} {...SHADOW} />
      ))}
    </group>
  );
}

function WholeModel({
  url,
  only,
  unique = false,
  position,
  rotation,
  scale = 1,
}: {
  url: string;
  only?: string[];
  unique?: boolean;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
}) {
  const { scene } = useGLTF(url);
  const keep = only?.join("|") ?? "";
  const model = useMemo(() => {
    const clone = scene.clone(true);
    if (keep) clone.children.filter((child) => !keep.split("|").includes(child.name)).forEach((child) => clone.remove(child));
    clone.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (unique) mesh.material = (mesh.material as THREE.Material).clone();
    });
    clone.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(clone);
    const center = box.getCenter(new THREE.Vector3());
    clone.position.set(-center.x, -box.min.y, -center.z);
    return clone;
  }, [scene, keep, unique]);
  return (
    <group position={position} rotation={rotation} scale={scale}>
      <primitive object={model} />
    </group>
  );
}

function partSize(piece: Piece): THREE.Vector3 {
  return pieceBox(piece).getSize(new THREE.Vector3());
}

/* ------------------------------------------------------------------ */
/* The clock table                                                     */

const FACE_R = R - 0.24; // enamel dial radius
const GLASS_Y = 0.145; // underside of the glass top
const STACK_ITEM_Y = 0.13; // top of the felt on the stacked discs

function useWalnut(tint: string) {
  const textures = useTexture(WALNUT, (loaded) => prepareTextures(loaded, 0.45, 8));
  return (
    <meshPhysicalMaterial
      {...textures}
      color={tint}
      roughness={0.9}
      metalness={0}
      clearcoat={0.55}
      clearcoatRoughness={0.28}
      envMapIntensity={0.9}
    />
  );
}

function Brass({ roughness = 0.26, color = PAL.brass }: { roughness?: number; color?: string }) {
  return <meshStandardMaterial color={color} metalness={1} roughness={roughness} envMapIntensity={1.3} />;
}

function Platter({
  radius = R,
  tint = "#d9c3a8",
  top = "felt",
  felt = PAL.felt,
}: {
  radius?: number;
  tint?: string;
  top?: "glass" | "felt";
  felt?: string;
}) {
  const geometry = useMemo(() => discGeometry(radius), [radius]);
  const wood = useWalnut(tint);
  return (
    <group>
      <mesh geometry={geometry} {...SHADOW}>
        {wood}
      </mesh>
      {/* brass trims: outer edge and the dial bezel */}
      <mesh position={[0, 0.112, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <torusGeometry args={[radius - 0.035, 0.014, 10, 160]} />
        <Brass />
      </mesh>
      <mesh position={[0, 0.118, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <torusGeometry args={[radius - 0.22, 0.022, 12, 160]} />
        <Brass roughness={0.22} />
      </mesh>
      {top === "felt" && (
        <mesh position={[0, 0.118, 0]} receiveShadow>
          <cylinderGeometry args={[radius - 0.22, radius - 0.22, 0.016, 96]} />
          <meshStandardMaterial color={felt} roughness={1} />
        </mesh>
      )}
      {top === "glass" && (
        <mesh position={[0, GLASS_Y + 0.011, 0]} receiveShadow>
          <cylinderGeometry args={[radius - 0.09, radius - 0.09, 0.022, 128]} />
          <meshPhysicalMaterial
            color="#dfe9f0"
            transparent
            opacity={0.22}
            roughness={0.04}
            metalness={0}
            clearcoat={1}
            clearcoatRoughness={0.03}
            envMapIntensity={1.6}
            depthWrite={false}
          />
        </mesh>
      )}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Clock: enamel dial with Roman numerals, brass hands on a raised post */

function dialTexture() {
  const size = 1024;
  const c = size / 2;
  const px = c / FACE_R; // pixels per world unit
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    // Aged enamel: cream with a faint warm vignette and speckle.
    const base = context.createRadialGradient(c, c, 0, c, c, c);
    base.addColorStop(0, "#f3ecdc");
    base.addColorStop(0.75, "#ecE2cd");
    base.addColorStop(1, "#d9ccb1");
    context.fillStyle = base;
    context.fillRect(0, 0, size, size);
    const random = seededRandom(7);
    for (let i = 0; i < 2600; i += 1) {
      context.fillStyle = `rgba(90, 70, 40, ${0.03 + random() * 0.05})`;
      context.fillRect(random() * size, random() * size, 1.5, 1.5);
    }
    // Chapter rings.
    context.strokeStyle = "#2b2733";
    context.lineWidth = 3;
    context.globalAlpha = 0.9;
    [2.3, 2.02].forEach((r) => {
      context.beginPath();
      context.arc(c, c, r * px, 0, TAU);
      context.stroke();
    });
    // Minute ticks.
    context.lineCap = "butt";
    for (let i = 0; i < 60; i += 1) {
      const angle = (i / 60) * TAU;
      const major = i % 5 === 0;
      const inner = (major ? 2.08 : 2.17) * px;
      const outer = 2.27 * px;
      context.lineWidth = major ? 7 : 3;
      context.beginPath();
      context.moveTo(c + Math.sin(angle) * inner, c - Math.cos(angle) * inner);
      context.lineTo(c + Math.sin(angle) * outer, c - Math.cos(angle) * outer);
      context.stroke();
    }
    // Roman numerals (clockmakers use IIII for balance).
    const numerals = ["XII", "I", "II", "III", "IIII", "V", "VI", "VII", "VIII", "IX", "X", "XI"];
    context.fillStyle = "#24202c";
    context.font = "700 74px Georgia, 'Times New Roman', serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    numerals.forEach((numeral, hour) => {
      const angle = (hour / 12) * TAU;
      const r = 1.72 * px;
      context.save();
      context.translate(c + Math.sin(angle) * r, c - Math.cos(angle) * r);
      context.rotate(angle);
      context.fillText(numeral, 0, 4);
      context.restore();
    });
    context.globalAlpha = 0.7;
    context.font = "600 30px Georgia, 'Times New Roman', serif";
    context.fillText("P L A N P I L O T", c, c - 0.62 * px);
    context.font = "500 22px Georgia, 'Times New Roman', serif";
    context.fillText("E S T.  2 0 2 6", c, c + 0.66 * px);
    context.globalAlpha = 1;
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
  const dial = useMemo(() => dialTexture(), []);
  const hours = useMemo(() => Array.from({ length: 12 }, (_, hour) => hour), []);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.1185, 0]} receiveShadow>
        <circleGeometry args={[FACE_R, 128]} />
        <meshPhysicalMaterial map={dial} roughness={0.45} clearcoat={0.5} clearcoatRoughness={0.2} envMapIntensity={0.6} />
      </mesh>
      {hours.map((hour) => {
        const angle = (hour / 12) * TAU;
        return (
          <mesh key={hour} position={[Math.sin(angle) * (FACE_R - 0.5), 0.126, -Math.cos(angle) * (FACE_R - 0.5)]} castShadow>
            <sphereGeometry args={[hour % 3 === 0 ? 0.026 : 0.018, 16, 12]} />
            <Brass roughness={0.2} />
          </mesh>
        );
      })}
    </group>
  );
}

function ClockHands({ progressRef, reducedMotion }: { progressRef: MutableRefObject<number>; reducedMotion: boolean }) {
  const geometries = useMemo(
    () => ({
      hour: handGeometry(1.1, 0.14, 0.2),
      minute: handGeometry(1.75, 0.095, 0.24),
      second: handGeometry(1.9, 0.026, 0.4),
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
      {/* brass arbor rising through a collar in the glass */}
      <mesh position={[0, 0.465, 0]} castShadow>
        <cylinderGeometry args={[0.05, 0.07, 0.67, 32]} />
        <Brass roughness={0.22} />
      </mesh>
      <mesh position={[0, GLASS_Y + 0.02, 0]} castShadow>
        <cylinderGeometry args={[0.1, 0.11, 0.05, 32]} />
        <Brass roughness={0.3} />
      </mesh>
      <group ref={hour} position={[0, 0.7, 0]}>
        <mesh geometry={geometries.hour} castShadow>
          <Brass roughness={0.3} />
        </mesh>
      </group>
      <group ref={minute} position={[0, 0.74, 0]}>
        <mesh geometry={geometries.minute} castShadow>
          <Brass roughness={0.3} />
        </mesh>
      </group>
      <group ref={second} position={[0, 0.78, 0]}>
        <mesh geometry={geometries.second} castShadow>
          <meshStandardMaterial color={PAL.bluedSteel} metalness={0.95} roughness={0.32} envMapIntensity={1.2} />
        </mesh>
        <mesh position={[0, 0.012, 0.3]} castShadow>
          <cylinderGeometry args={[0.05, 0.05, 0.02, 24]} />
          <meshStandardMaterial color={PAL.bluedSteel} metalness={0.95} roughness={0.32} envMapIntensity={1.2} />
        </mesh>
      </group>
      <mesh position={[0, 0.81, 0]} castShadow>
        <sphereGeometry args={[0.065, 24, 16]} />
        <Brass roughness={0.22} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Everyday objects — real scans, each built resting on y = 0          */

const BOOK_PICKS = ["book13", "book15", "book17", "book01", "book14", "book20"];

function Books({ seed, unique }: { seed: number; unique?: boolean }) {
  const nodes = useParts(MODEL.books);
  const s = 2.2;
  const picks = [0, 1, 2].map((i) => nodes[`book_encyclopedia_set_01_${BOOK_PICKS[(seed + i) % BOOK_PICKS.length]}`]);
  let y = 0;
  return (
    <group>
      {picks.map((piece, i) => {
        const thickness = partSize(piece).x * s;
        const group = (
          <group key={i} position={[(i - 1) * 0.03, y + thickness / 2, i * 0.015]} rotation={[0, (i - 1) * 0.16 + seed * 0.05, 0]}>
            <Part part={piece} unique={unique} align="center" rotation={[0, 0, Math.PI / 2]} scale={s} />
          </group>
        );
        y += thickness;
        return group;
      })}
    </group>
  );
}

function Papers({ unique }: { unique?: boolean }) {
  const nodes = useParts(MODEL.notepads);
  const s = 2.2;
  const stackHeight = partSize(nodes.office_notepads_a4_stack).y * s;
  return (
    <group>
      <Part part={nodes.office_notepads_a4_stack} unique={unique} scale={s} />
      <Part part={nodes.office_notepads_a4_a} unique={unique} position={[0.03, stackHeight + 0.003, -0.02]} rotation={[0, -0.14, 0]} scale={s} />
      <Part part={nodes.office_notepads_sticky_stack} unique={unique} position={[0.14, stackHeight + 0.004, 0.2]} rotation={[0, 0.3, 0]} scale={s} />
    </group>
  );
}

function Binder({ unique }: { unique?: boolean }) {
  const nodes = useParts(MODEL.binder);
  const pens = useParts(MODEL.stationery);
  const s = 2.0;
  const height = partSize(nodes.binder_notebook).y * s;
  return (
    <group>
      <Part part={nodes.binder_notebook} unique={unique} scale={s} />
      <Part part={pens.stationery_supplies_pen_fancy} unique={unique} position={[0.12, height + 0.002, 0.03]} rotation={[0, 1.2, 0]} scale={2.4} />
    </group>
  );
}

function useFabric(tint: string) {
  const textures = useTexture(FABRIC, (loaded) => prepareTextures(loaded, 3, 4));
  return <meshStandardMaterial {...textures} color={tint} roughness={1} metalness={0} envMapIntensity={0.5} />;
}

function Laundry({ unique }: { unique?: boolean }) {
  const nodes = useParts(MODEL.basket);
  const slab = useMemo(() => roundedSlab(0.4, 0.3, 0.075, 0.05), []);
  const s = 1.75;
  const rim = partSize(nodes.wicker_basket_01).y * s;
  const tints = [PAL.fabricA, PAL.fabricB, PAL.fabricC];
  const materials = [useFabric(tints[0]), useFabric(tints[1]), useFabric(tints[2])];
  return (
    <group>
      <Part part={nodes.wicker_basket_01} unique={unique} scale={s} />
      {materials.map((material, i) => (
        <mesh
          key={i}
          geometry={slab}
          position={[(i - 1) * 0.02, rim - 0.1 + i * 0.077, (i % 2) * 0.015]}
          rotation={[0, (i - 1) * 0.12, 0]}
          {...SHADOW}
        >
          {material}
        </mesh>
      ))}
    </group>
  );
}

function SprayBottle({ unique }: { unique?: boolean }) {
  const nodes = useParts(MODEL.spray);
  const s = 2.2;
  return (
    <group>
      <Part part={nodes.multi_cleaner_bottle} unique={unique} scale={s} />
      <Part part={nodes.multi_cleaner_bottle_sticker} unique={unique} align="center" position={[0, partSize(nodes.multi_cleaner_bottle_sticker).y * s * 0.5 + 0.014 * s, 0]} scale={s} />
    </group>
  );
}

function Mug({ unique }: { unique?: boolean }) {
  const nodes = useParts(MODEL.tea);
  const s = 3.0;
  const saucer = partSize(nodes.tea_set_01_saucer_circular_03).y * s;
  return (
    <group>
      <Part part={nodes.tea_set_01_saucer_circular_03} unique={unique} scale={s} />
      <Part part={nodes.tea_set_01_cup_small_01} unique={unique} position={[0, saucer - 0.004, 0]} rotation={[0, 0.6, 0]} scale={s} />
    </group>
  );
}

function Pencils({ unique }: { unique?: boolean }) {
  const nodes = useParts(MODEL.stationery);
  const s = 2.6;
  return (
    <group>
      <Part part={nodes.stationery_supplies_pencil_new_a} unique={unique} rotation={[0, 0.1, 0]} scale={s} />
      <Part part={nodes.stationery_supplies_pen_blue} unique={unique} position={[0.05, 0, 0.07]} rotation={[0, -0.18, 0]} scale={s} />
      <Part part={nodes.stationery_supplies_pencil_used} unique={unique} position={[-0.08, 0, -0.06]} rotation={[0, 0.32, 0]} scale={s} />
      <Part part={nodes.stationery_supplies_eraser} unique={unique} position={[0.22, 0, -0.08]} rotation={[0, 0.9, 0]} scale={s} />
    </group>
  );
}

function Plate({ topping, unique }: { topping: "croissant" | "apple"; unique?: boolean }) {
  const tea = useParts(MODEL.tea);
  const s = 2.6;
  const plate = partSize(tea.tea_set_01_plate_large_circular_03).y * s;
  return (
    <group>
      <Part part={tea.tea_set_01_plate_large_circular_03} unique={unique} scale={s} />
      {topping === "croissant" ? (
        <>
          <WholeModel url={MODEL.croissant} unique={unique} position={[-0.02, plate, 0.02]} rotation={[0, 0.7, 0]} scale={2.2} />
          <Part part={tea.tea_set_01_cup_small_02} unique={unique} position={[0.36, 0, -0.14]} rotation={[0, 2.4, 0]} scale={s} />
        </>
      ) : (
        <>
          <WholeModel url={MODEL.apple} unique={unique} position={[-0.05, plate, 0.03]} scale={2.6} />
          <Part part={tea.tea_set_01_cup_small_02} unique={unique} position={[0.36, 0, -0.14]} rotation={[0, 2.4, 0]} scale={s} />
        </>
      )}
    </group>
  );
}

function Teapot({ unique }: { unique?: boolean }) {
  const tea = useParts(MODEL.tea);
  const s = 2.4;
  const body = partSize(tea.tea_set_01_teapot_01).y * s;
  return (
    <group>
      <Part part={tea.tea_set_01_teapot_01} unique={unique} scale={s} />
      <Part part={tea.tea_set_01_teapot_01_lid} unique={unique} position={[0, body - 0.024, 0]} scale={s} />
    </group>
  );
}

type Kind =
  | "books"
  | "papers"
  | "binder"
  | "laundry"
  | "spray"
  | "mug"
  | "pencil"
  | "alarm"
  | "breakfast"
  | "laptop"
  | "lunch"
  | "football"
  | "teapot"
  | "gamepad"
  | "pillow"
  | "pillow2";

function ItemView({ kind, seed, unique }: { kind: Kind; seed: number; unique?: boolean }) {
  if (kind === "books") return <Books seed={seed} unique={unique} />;
  if (kind === "papers") return <Papers unique={unique} />;
  if (kind === "binder") return <Binder unique={unique} />;
  if (kind === "laundry") return <Laundry unique={unique} />;
  if (kind === "spray") return <SprayBottle unique={unique} />;
  if (kind === "mug") return <Mug unique={unique} />;
  if (kind === "alarm") return <WholeModel url={MODEL.alarm} unique={unique} rotation={[0, -0.4, 0]} scale={2.3} />;
  if (kind === "breakfast") return <Plate topping="croissant" unique={unique} />;
  if (kind === "laptop") return <WholeModel url={MODEL.laptop} unique={unique} rotation={[0, Math.PI, 0]} scale={1.3} />;
  if (kind === "lunch") return <Plate topping="apple" unique={unique} />;
  if (kind === "football") return <WholeModel url={MODEL.football} only={["football_inflated"]} unique={unique} scale={2.2} />;
  if (kind === "teapot") return <Teapot unique={unique} />;
  if (kind === "gamepad") return <WholeModel url={MODEL.gamepad} unique={unique} rotation={[0, 0.3, 0]} scale={1.5} />;
  if (kind === "pillow") return <WholeModel url={MODEL.pillows} only={["throw_pillows_01_pillow02"]} unique={unique} rotation={[0, 0.5, 0]} scale={1.3} />;
  if (kind === "pillow2") return <WholeModel url={MODEL.pillows} only={["throw_pillows_01_pillow01"]} unique={unique} rotation={[0, -0.6, 0]} scale={1.25} />;
  return <Pencils unique={unique} />;
}

/** A typical student day. Each item sits at its hour on the dial; evenings use the inner ring. */
type DayEntry = { hour: number; kind: Kind; label: string; ring: "outer" | "inner"; uncertain?: boolean };
const DAY_PLAN: DayEntry[] = [
  { hour: 7, kind: "alarm", label: "7 AM · Wake up", ring: "outer" },
  { hour: 8, kind: "breakfast", label: "8 AM · Breakfast", ring: "outer" },
  { hour: 9, kind: "laptop", label: "9 AM · Lecture", ring: "outer" },
  { hour: 10, kind: "books", label: "10 AM · Study", ring: "outer" },
  { hour: 11, kind: "binder", label: "11 AM · Class notes", ring: "outer" },
  { hour: 12, kind: "lunch", label: "12 PM · Lunch", ring: "outer" },
  { hour: 1, kind: "books", label: "1 PM · Reading", ring: "outer" },
  { hour: 2, kind: "papers", label: "2 PM · Homework · time not confirmed", ring: "outer", uncertain: true },
  { hour: 3, kind: "football", label: "3 PM · Practice", ring: "outer" },
  { hour: 4, kind: "spray", label: "4 PM · Clean the room", ring: "outer" },
  { hour: 5, kind: "laundry", label: "5 PM · Laundry", ring: "outer" },
  { hour: 6, kind: "teapot", label: "6 PM · Dinner", ring: "outer" },
  { hour: 7, kind: "gamepad", label: "7 PM · Free time", ring: "inner" },
  { hour: 8, kind: "pencil", label: "8 PM · Problem set", ring: "inner" },
  { hour: 9, kind: "mug", label: "9 PM · Tea & wind down", ring: "inner" },
  { hour: 10, kind: "books", label: "10 PM · Reading", ring: "inner" },
  { hour: 11, kind: "pillow", label: "11 PM · Sleep", ring: "inner" },
  { hour: 12, kind: "pillow2", label: "12 AM · Sleep", ring: "inner" },
];
const STACK_KINDS: Kind[] = ["books", "laptop", "mug", "laundry", "football", "binder", "pencil", "gamepad", "spray", "pillow", "papers", "teapot"];

/* ------------------------------------------------------------------ */
/* Items that converge onto the clock                                  */

type ItemData = {
  kind: Kind;
  label: string;
  uncertain: boolean;
  far: THREE.Vector3;
  mess: THREE.Vector3;
  target: THREE.Vector3;
  startRot: THREE.Vector3;
  spin: THREE.Vector3;
  targetYaw: number;
};

function buildItems(): ItemData[] {
  const random = seededRandom(2026);
  const list: ItemData[] = [];
  for (const entry of DAY_PLAN) {
    // Clock convention: 12 at the far side (-z), hours running clockwise.
    const angle = (entry.hour / 12) * TAU;
    const radius = entry.ring === "inner" ? 1.14 : 1.76;
    const { kind, uncertain = false } = entry;
    const farAngle = random() * TAU;
    const farRadius = 5 + random() * 4;
    const messAngle = random() * TAU;
    const messRadius = 3 + random() * 2.5;
    list.push({
      kind,
      label: entry.label,
      uncertain,
      far: new THREE.Vector3(Math.cos(farAngle) * farRadius, (random() - 0.4) * 5, Math.sin(farAngle) * farRadius),
      mess: new THREE.Vector3(Math.cos(messAngle) * messRadius, -0.3 + random() * 2.8, Math.sin(messAngle) * messRadius),
      target: new THREE.Vector3(Math.sin(angle) * radius, ITEM_Y, -Math.cos(angle) * radius),
      startRot: new THREE.Vector3(random() * TAU, random() * TAU, random() * TAU),
      spin: new THREE.Vector3((random() - 0.5) * 1.2, (random() - 0.5) * 1.2, (random() - 0.5) * 0.9),
      // Long side along the ring, with a little natural scatter.
      targetYaw: -angle + (random() - 0.5) * 0.3,
    });
  }
  return list;
}

function Items({ progressRef, reducedMotion, interactive }: PlanWorldProps) {
  const items = useMemo(() => buildItems(), []);
  const groups = useRef<Array<THREE.Group | null>>([]);
  const hovered = useRef(-1);
  const [hoveredIndex, setHoveredIndex] = useState(-1);
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
          if (!material.emissive) return;
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
            setHoveredIndex(index);
          }}
          onPointerOut={() => {
            if (hovered.current === index) hovered.current = -1;
            setHoveredIndex((current) => (current === index ? -1 : current));
          }}
        >
          <ItemView kind={item.kind} seed={index} unique={item.uncertain} />
          {hoveredIndex === index && (
            <Html position={[0, 0.75, 0]} center distanceFactor={9} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
              <span className="world-tag">{item.label}</span>
            </Html>
          )}
        </group>
      ))}
      <pointLight ref={glowLight} color={PAL.amber} intensity={0} distance={3.5} decay={2} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Magepunk rings around the stacked week (dark metal, gold filigree,  */
/* glowing teal energy channels, floating shards)                      */

/** A flat ring segment (annular arc) with bevelled edges, bottom at y = 0. */
function arcSegmentGeometry(inner: number, outer: number, arc: number, depth: number) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outer, -arc / 2, arc / 2, false);
  shape.absarc(0, 0, inner, arc / 2, -arc / 2, true);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.012,
    bevelSegments: 3,
    curveSegments: 28,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, 0.012, 0);
  return geometry;
}

/** A thin flat arc of tube, centred on +x, lying in the XZ plane. */
function flatArcGeometry(radius: number, tube: number, arc: number) {
  const geometry = new THREE.TorusGeometry(radius, tube, 10, 56, arc);
  geometry.rotateZ(-arc / 2);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

const SEGMENTS = 6;
const SEGMENT_ARC = (TAU / SEGMENTS) * 0.74;

function MageRing({ radius, seed, reducedMotion }: { radius: number; seed: number; reducedMotion: boolean }) {
  const ring = useRef<THREE.Group>(null);
  const shards = useRef<THREE.Group>(null);
  const runes = useRef<THREE.MeshStandardMaterial[]>([]);
  const geometries = useMemo(
    () => ({
      segment: arcSegmentGeometry(radius - 0.26, radius, SEGMENT_ARC, 0.09),
      outerTrim: flatArcGeometry(radius + 0.006, 0.018, SEGMENT_ARC),
      innerTrim: flatArcGeometry(radius - 0.266, 0.013, SEGMENT_ARC),
      channel: flatArcGeometry(radius - 0.13, 0.014, SEGMENT_ARC * 0.84),
      shard: arcSegmentGeometry(radius + 0.3, radius + 0.46, 0.3, 0.05),
      shardTrim: flatArcGeometry(radius + 0.466, 0.012, 0.3),
    }),
    [radius],
  );
  const direction = seed % 2 === 0 ? 1 : -1;
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (reducedMotion) return;
    if (ring.current) {
      ring.current.rotation.y = t * 0.11 * direction + seed;
      ring.current.position.y = 0.04 + Math.sin(t * 0.7 + seed) * 0.03;
    }
    if (shards.current) {
      shards.current.rotation.y = -t * 0.19 * direction + seed * 1.7;
      shards.current.position.y = 0.42 + Math.sin(t * 0.9 + seed * 2) * 0.05;
    }
    runes.current.forEach((material, index) => {
      if (material) material.emissiveIntensity = 2.4 + Math.sin(t * 2.2 + index * 1.05 + seed) * 1.3;
    });
  });
  const segments = useMemo(() => Array.from({ length: SEGMENTS }, (_, index) => (index / SEGMENTS) * TAU), []);
  return (
    <group>
      <group ref={ring} position={[0, 0.04, 0]}>
        {segments.map((angle, index) => (
          <group key={index} rotation={[0, angle, 0]}>
            <mesh geometry={geometries.segment} {...SHADOW}>
              <meshStandardMaterial color={PAL.gunmetal} metalness={0.92} roughness={0.34} envMapIntensity={1.1} />
            </mesh>
            <mesh geometry={geometries.outerTrim} position={[0, 0.102, 0]} castShadow>
              <Brass color={PAL.gold} roughness={0.2} />
            </mesh>
            <mesh geometry={geometries.innerTrim} position={[0, 0.102, 0]}>
              <Brass color={PAL.gold} roughness={0.2} />
            </mesh>
            <mesh geometry={geometries.channel} position={[0, 0.108, 0]}>
              <meshStandardMaterial
                ref={(material) => {
                  if (material) runes.current[index] = material;
                }}
                color="#06110f"
                emissive={PAL.teal}
                emissiveIntensity={2.6}
                toneMapped={false}
              />
            </mesh>
            {[-0.3, 0, 0.3].map((offset) => (
              <mesh
                key={offset}
                position={[Math.cos(offset * SEGMENT_ARC) * (radius - 0.13), 0.13, -Math.sin(offset * SEGMENT_ARC) * (radius - 0.13)]}
                rotation={[0, offset * SEGMENT_ARC + Math.PI / 4, 0]}
              >
                <boxGeometry args={[0.05, 0.05, 0.05]} />
                <meshStandardMaterial color="#06110f" emissive={PAL.teal} emissiveIntensity={3.2} toneMapped={false} />
              </mesh>
            ))}
          </group>
        ))}
      </group>
      <group ref={shards} position={[0, 0.42, 0]} rotation={[0.08, 0, -0.05]}>
        {[0, 1, 2].map((index) => (
          <group key={index} rotation={[0, (index / 3) * TAU + 0.5, 0]}>
            <mesh geometry={geometries.shard} castShadow>
              <meshStandardMaterial color={PAL.gunmetal} metalness={0.92} roughness={0.3} envMapIntensity={1.1} />
            </mesh>
            <mesh geometry={geometries.shardTrim} position={[0, 0.062, 0]}>
              <Brass color={PAL.gold} roughness={0.2} />
            </mesh>
            <mesh position={[radius + 0.38, 0.08, 0]}>
              <boxGeometry args={[0.04, 0.04, 0.04]} />
              <meshStandardMaterial color="#06110f" emissive={PAL.teal} emissiveIntensity={3} toneMapped={false} />
            </mesh>
          </group>
        ))}
      </group>
    </group>
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
        const kinds = [0, 1, 2, 3].map((k) => STACK_KINDS[(day * 3 + k) % STACK_KINDS.length]);
        return {
          day,
          scale,
          items: kinds.map((kind, k) => {
            const angle = (k / 4) * TAU + day * 0.45;
            const radius = 1.5;
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
          <Platter tint={entry.day % 2 === 0 ? "#cfb393" : "#b89a7c"} top="felt" felt={entry.day % 2 === 0 ? PAL.felt : PAL.feltAlt} />
          <MageRing radius={R + 0.5} seed={entry.day} reducedMotion={reducedMotion} />
          {entry.items.map((item, index) => (
            <group key={index} position={[item.x, STACK_ITEM_Y, item.z]} rotation={[0, item.yaw, 0]} scale={0.85}>
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
  const { reducedMotion, onReady } = props;
  // Everything above has loaded (models, textures, lighting) once this mounts.
  useEffect(() => {
    onReady?.();
  }, [onReady]);
  return (
    <group>
      <Environment files={HDRI} environmentIntensity={0.55} />
      <Platter top="glass" />
      <ClockFace />
      <ClockHands progressRef={props.progressRef} reducedMotion={reducedMotion} />
      <Items {...props} />
      <WeekStack progressRef={props.progressRef} reducedMotion={reducedMotion} />
    </group>
  );
}

export default function PlanWorldScene(props: PlanWorldProps) {
  const orbitRef = useRef<Orbit>({
    yaw: 0,
    pitch: 0,
    vYaw: 0,
    vPitch: 0,
    dragging: false,
    resetting: false,
    lastX: 0,
    lastY: 0,
    dragged: false,
  });
  return (
    <Canvas
      shadows="soft"
      dpr={[1, 1.6]}
      camera={{ position: [0, 3.2, 8.2], fov: 42, near: 0.1, far: 80 }}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      frameloop="always"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
    >
      <color attach="background" args={[PAL.fog]} />
      <fog attach="fog" args={[PAL.fog, 15, 36]} />
      <hemisphereLight args={["#c4bfdb", "#1d1b26", 0.35]} />
      <directionalLight
        position={[4, 10, 5]}
        intensity={2.4}
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
      <directionalLight position={[-6, 3, -5]} intensity={0.5} color="#8f86b8" />
      {/* Invisible floor that only shows the shadows */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.6, 0]} receiveShadow>
        <planeGeometry args={[60, 60]} />
        <shadowMaterial opacity={0.35} />
      </mesh>
      <OrbitInput orbitRef={orbitRef} interactive={props.interactive} onFirstDrag={props.onFirstDrag} />
      <CameraRig {...props} orbitRef={orbitRef} />
      <Stars reducedMotion={props.reducedMotion} />
      <Suspense fallback={null}>
        <World {...props} />
      </Suspense>
      <EffectComposer multisampling={4}>
        <Bloom luminanceThreshold={1} mipmapBlur intensity={0.9} radius={0.65} />
      </EffectComposer>
    </Canvas>
  );
}
