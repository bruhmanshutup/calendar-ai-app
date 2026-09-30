"use client";

import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";

/**
 * PlanWorld — the full-screen, scroll-driven 3D story behind the landing page.
 *
 * Scroll progress (0..1) is read from a ref every frame. The camera flies
 * through five beats:
 *   0.00  Hero: an empty day ring floats in a star field.
 *   0.20  Bring the mess: hundreds of scattered "note" cards drift in.
 *   0.45  Sorted: the notes converge into colored session blocks on the ring.
 *   0.65  Uncertainty: one block glows amber with a halo until confirmed.
 *   0.85  Your week: six more rings stack up into a realistic week.
 * Everything is procedural Three.js — no external scene files.
 */

const TAU = Math.PI * 2;
const RING_RADIUS = 2.4;
const NOTE_COUNT = 420;

type Tone = "violet" | "coral" | "cyan" | "amber" | "pink";
const TONE_COLORS: Record<Tone, string> = {
  violet: "#a78bfa",
  coral: "#fb7185",
  cyan: "#22d3ee",
  amber: "#fbbf24",
  pink: "#f0abfc",
};

type Block = { start: number; width: number; tone: Tone };
const BLOCKS: Block[] = [
  { start: 0.3, width: 0.06, tone: "violet" },
  { start: 0.39, width: 0.05, tone: "cyan" },
  { start: 0.5, width: 0.08, tone: "coral" },
  { start: 0.62, width: 0.04, tone: "amber" },
  { start: 0.7, width: 0.06, tone: "pink" },
  { start: 0.8, width: 0.05, tone: "violet" },
];
const UNCERTAIN_BLOCK = 3; // the amber one

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

type CameraKey = { p: number; pos: [number, number, number]; look: [number, number, number] };
const CAMERA_PATH: CameraKey[] = [
  { p: 0.0, pos: [0, 3.2, 8.2], look: [0, 0.2, 0] },
  { p: 0.2, pos: [4.5, 2.4, 6.5], look: [0, 0.3, 0] },
  { p: 0.45, pos: [0.5, 6.2, 3.8], look: [0, 0, 0] },
  { p: 0.65, pos: [-3.6, 2.2, 5.4], look: [0.6, 0.3, -0.6] },
  { p: 0.85, pos: [0, 5.5, 13.5], look: [0, 2.6, 0] },
  { p: 1.0, pos: [0, 3.6, 10.5], look: [0, 1.8, 0] },
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

/* ------------------------------------------------------------------ */

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

function Stars({ reducedMotion }: { reducedMotion: boolean }) {
  const ref = useRef<THREE.Points>(null);
  const positions = useMemo(() => {
    const random = seededRandom(42);
    const count = 900;
    const array = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const r = 9 + random() * 22;
      const theta = random() * TAU;
      const phi = Math.acos(2 * random() - 1);
      array[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      array[i * 3 + 1] = r * Math.cos(phi) * 0.6;
      array[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    return array;
  }, []);
  useFrame((_, delta) => {
    if (ref.current && !reducedMotion) ref.current.rotation.y += delta * 0.01;
  });
  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#d8d0ff" size={0.06} sizeAttenuation transparent opacity={0.7} depthWrite={false} />
    </points>
  );
}

function Ring({ y = 0, radius = RING_RADIUS, opacity = 1, color = "#7c3aed" }: { y?: number; radius?: number; opacity?: number; color?: string }) {
  return (
    <group position={[0, y, 0]}>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[radius, 0.05, 16, 140]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.8} roughness={0.4} transparent opacity={opacity} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]}>
        <ringGeometry args={[radius - 0.8, radius + 0.8, 96]} />
        <meshBasicMaterial color={color} transparent opacity={0.08 * opacity} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  );
}

function Ticks() {
  const items = useMemo(() => Array.from({ length: 24 }, (_, hour) => hour), []);
  return (
    <group>
      {items.map((hour) => {
        const angle = (hour / 24) * TAU;
        const major = hour % 6 === 0;
        return (
          <mesh key={hour} position={[Math.cos(angle) * (RING_RADIUS + 0.6), 0, -Math.sin(angle) * (RING_RADIUS + 0.6)]} rotation={[0, -angle, 0]}>
            <boxGeometry args={[major ? 0.18 : 0.08, 0.02, 0.03]} />
            <meshBasicMaterial color={major ? "#c4b5fd" : "#6d6a8f"} transparent opacity={major ? 0.9 : 0.6} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Hundreds of note cards that start scattered and converge into session blocks. */
function Notes({ progressRef, reducedMotion }: { progressRef: MutableRefObject<number>; reducedMotion: boolean }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const data = useMemo(() => {
    const random = seededRandom(2026);
    const start: THREE.Vector3[] = [];
    const target: THREE.Vector3[] = [];
    const rot: THREE.Euler[] = [];
    const targetRot: THREE.Euler[] = [];
    const colors = new Float32Array(NOTE_COUNT * 3);
    const color = new THREE.Color();
    const perBlock = Math.floor(NOTE_COUNT / BLOCKS.length);
    for (let i = 0; i < NOTE_COUNT; i += 1) {
      // Scattered start: a wide shell around the ring
      const r = 4 + random() * 7;
      const theta = random() * TAU;
      const phi = Math.acos(2 * random() - 1);
      start.push(new THREE.Vector3(r * Math.sin(phi) * Math.cos(theta), (random() - 0.5) * 6, r * Math.sin(phi) * Math.sin(theta)));
      rot.push(new THREE.Euler(random() * TAU, random() * TAU, random() * TAU));
      // Target: a slot inside one of the blocks (arc segment, 3 rows x 2 layers)
      const blockIndex = Math.min(BLOCKS.length - 1, Math.floor(i / perBlock));
      const block = BLOCKS[blockIndex];
      const j = i - blockIndex * perBlock;
      const cols = Math.ceil(perBlock / 6);
      const col = j % cols;
      const rowIndex = Math.floor(j / cols); // 0..5
      const row = rowIndex % 3;
      const layer = Math.floor(rowIndex / 3);
      const angle = (block.start + (block.width * (col + 0.5)) / cols) * TAU;
      const radius = RING_RADIUS - 0.28 + row * 0.28;
      target.push(new THREE.Vector3(Math.cos(angle) * radius, 0.08 + layer * 0.16, -Math.sin(angle) * radius));
      targetRot.push(new THREE.Euler(-Math.PI / 2, 0, -angle));
      color.set(TONE_COLORS[block.tone]);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    return { start, target, rot, targetRot, colors };
  }, []);

  useFrame(({ clock }) => {
    if (!mesh.current) return;
    const p = progressRef.current;
    const gather = range(p, 0.28, 0.5);
    const appear = range(p, 0.08, 0.28);
    const t = clock.getElapsedTime();
    for (let i = 0; i < NOTE_COUNT; i += 1) {
      const s = data.start[i];
      const e = data.target[i];
      const wobble = reducedMotion ? 0 : (1 - gather) * Math.sin(t * 0.8 + i) * 0.25;
      dummy.position.set(
        THREE.MathUtils.lerp(s.x, e.x, gather),
        THREE.MathUtils.lerp(s.y, e.y, gather) + wobble,
        THREE.MathUtils.lerp(s.z, e.z, gather),
      );
      const r0 = data.rot[i];
      const r1 = data.targetRot[i];
      const spin = reducedMotion ? 0 : (1 - gather) * t * 0.3;
      dummy.rotation.set(
        THREE.MathUtils.lerp(r0.x + spin, r1.x, gather),
        THREE.MathUtils.lerp(r0.y + spin, r1.y, gather),
        THREE.MathUtils.lerp(r0.z, r1.z, gather),
      );
      const scale = 0.001 + appear * 0.999;
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      mesh.current.setMatrixAt(i, dummy.matrix);
    }
    mesh.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, NOTE_COUNT]}>
      <boxGeometry args={[0.22, 0.13, 0.05]}>
        <instancedBufferAttribute attach="attributes-color" args={[data.colors, 3]} />
      </boxGeometry>
      <meshStandardMaterial vertexColors emissive="#ffffff" emissiveIntensity={0.25} roughness={0.35} metalness={0.1} />
    </instancedMesh>
  );
}

/** Amber halo that appears over the uncertain block during beat 4. */
function UncertaintyHalo({ progressRef, reducedMotion }: { progressRef: MutableRefObject<number>; reducedMotion: boolean }) {
  const group = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Mesh>(null);
  const block = BLOCKS[UNCERTAIN_BLOCK];
  const angle = (block.start + block.width / 2) * TAU;
  const x = Math.cos(angle) * RING_RADIUS;
  const z = -Math.sin(angle) * RING_RADIUS;
  useFrame(({ clock }) => {
    if (!group.current || !halo.current) return;
    const p = progressRef.current;
    const show = range(p, 0.55, 0.66) * (1 - range(p, 0.8, 0.9));
    group.current.scale.setScalar(Math.max(0.001, show));
    const pulse = reducedMotion ? 1 : 1 + Math.sin(clock.getElapsedTime() * 2.5) * 0.12;
    halo.current.scale.setScalar(pulse);
    halo.current.rotation.z = clock.getElapsedTime() * 0.4;
  });
  return (
    <group ref={group} position={[x, 0.5, z]}>
      <mesh ref={halo} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.7, 0.04, 12, 64]} />
        <meshBasicMaterial color="#fbbf24" transparent opacity={0.9} />
      </mesh>
      <mesh position={[0, 0.6, 0]}>
        <sphereGeometry args={[0.14, 24, 24]} />
        <meshStandardMaterial color="#fff7d6" emissive="#fbbf24" emissiveIntensity={2.4} />
      </mesh>
      <pointLight color="#fbbf24" intensity={12} distance={4} position={[0, 0.8, 0]} />
    </group>
  );
}

/** Six more rings rise into a stacked week in the final beat. */
function WeekStack({ progressRef, reducedMotion }: { progressRef: MutableRefObject<number>; reducedMotion: boolean }) {
  const group = useRef<THREE.Group>(null);
  const days = useMemo(() => [1, 2, 3, 4, 5, 6], []);
  useFrame(({ clock }) => {
    if (!group.current) return;
    const p = progressRef.current;
    const show = range(p, 0.7, 0.9);
    group.current.children.forEach((child, index) => {
      const local = smooth((show - index * 0.08) / 0.5);
      child.position.y = (index + 1) * 0.95 * local;
      child.scale.setScalar(Math.max(0.001, local));
      if (!reducedMotion) child.rotation.y = clock.getElapsedTime() * 0.08 * (index % 2 === 0 ? 1 : -1);
    });
  });
  return (
    <group ref={group}>
      {days.map((day) => (
        <group key={day}>
          <Ring radius={RING_RADIUS - day * 0.12} opacity={0.9 - day * 0.08} color={day % 2 === 0 ? "#22d3ee" : "#db2777"} />
          {[0.1, 0.35, 0.62].map((start, index) => (
            <mesh
              key={index}
              position={[Math.cos((start + day * 0.07) * TAU) * (RING_RADIUS - day * 0.12), 0.08, -Math.sin((start + day * 0.07) * TAU) * (RING_RADIUS - day * 0.12)]}
              rotation={[0, -(start + day * 0.07) * TAU, 0]}
            >
              <boxGeometry args={[0.5, 0.14, 0.4]} />
              <meshStandardMaterial color={TONE_COLORS[(["violet", "coral", "cyan"] as Tone[])[index]]} emissive={TONE_COLORS[(["violet", "coral", "cyan"] as Tone[])[index]]} emissiveIntensity={0.6} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

function NowMarker({ reducedMotion }: { reducedMotion: boolean }) {
  const glow = useRef<THREE.Mesh>(null);
  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!glow.current || !group.current || reducedMotion) return;
    const t = clock.getElapsedTime();
    glow.current.scale.setScalar(1 + Math.sin(t * 2.2) * 0.2);
    group.current.rotation.y = t * 0.05;
  });
  return (
    <group ref={group}>
      <mesh position={[RING_RADIUS, 0.02, 0]}>
        <sphereGeometry args={[0.14, 24, 24]} />
        <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={2} />
      </mesh>
      <mesh ref={glow} position={[RING_RADIUS, 0.02, 0]}>
        <sphereGeometry args={[0.3, 24, 24]} />
        <meshBasicMaterial color="#f5d0fe" transparent opacity={0.22} />
      </mesh>
    </group>
  );
}

function World({ progressRef, reducedMotion, interactive }: PlanWorldProps) {
  const group = useRef<THREE.Group>(null);
  const drag = useRef({ active: false, lastX: 0, velocity: 0, spin: 0 });
  const { size } = useThree();
  useFrame((_, delta) => {
    if (!group.current) return;
    const d = drag.current;
    if (!reducedMotion) {
      d.spin += (d.active ? 0 : delta * 0.05) + d.velocity;
      d.velocity *= d.active ? 0.85 : 0.93;
    }
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
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, 0]}>
        <circleGeometry args={[4, 48]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <Ring />
      <Ticks />
      <Notes progressRef={progressRef} reducedMotion={reducedMotion} />
      <UncertaintyHalo progressRef={progressRef} reducedMotion={reducedMotion} />
      <WeekStack progressRef={progressRef} reducedMotion={reducedMotion} />
      <NowMarker reducedMotion={reducedMotion} />
    </group>
  );
}

export default function PlanWorldScene(props: PlanWorldProps) {
  return (
    <Canvas
      dpr={[1, 1.6]}
      camera={{ position: [0, 3.2, 8.2], fov: 42, near: 0.1, far: 80 }}
      gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
      frameloop="always"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", background: "transparent" }}
      onCreated={() => props.onReady?.()}
    >
      <fog attach="fog" args={["#0a0912", 14, 34]} />
      <ambientLight intensity={0.5} />
      <pointLight position={[5, 6, 4]} intensity={60} color="#c4b5fd" />
      <pointLight position={[-6, 3, -4]} intensity={40} color="#fb7185" />
      <pointLight position={[0, -4, 3]} intensity={18} color="#22d3ee" />
      <CameraRig {...props} />
      <Stars reducedMotion={props.reducedMotion} />
      <World {...props} />
    </Canvas>
  );
}
