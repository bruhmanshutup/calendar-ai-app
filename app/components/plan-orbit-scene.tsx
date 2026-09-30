"use client";

import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";

/**
 * PlanOrbit — a real-time 3D "day disc" for the dashboard.
 *
 * A solid lacquered disc with a felt top, metal spindle, and studded rim.
 * Today's sessions sit on the felt as raised, matte pieces around a
 * 24-hour dial; a brass bead marks the current time. One warm key light
 * casts soft shadows. The disc tilts toward the pointer and can be dragged
 * to spin. Built with Three.js via React Three Fiber — no external files.
 */

export type OrbitBlock = {
  label: string;
  start: number; // 0..1 fraction of the day
  width: number; // 0..1 fraction of the day
  tone: "violet" | "coral" | "cyan" | "amber";
};

export type PlanOrbitSceneProps = {
  blocks: OrbitBlock[];
  progress: number; // 0..1 fraction of the day
  reducedMotion: boolean;
  interactive: boolean;
  compact?: boolean;
  onHoverBlock?: (label: string | undefined) => void;
};

// Calm, dusty tones (the names stay the same so callers don't change).
const TONES: Record<OrbitBlock["tone"], string> = {
  violet: "#8f86b8",
  coral: "#b58f96",
  cyan: "#7f9db0",
  amber: "#c2ad8a",
};

const TAU = Math.PI * 2;
const DISC_R = 2.5;
const FELT_R = DISC_R - 0.18;
const FELT_TOP = 0.13;
const METAL = "#b8b3c6";

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

/** A raised arc piece sitting on the felt, bottom at y = 0. */
function arcGeometry(start: number, width: number, inner = 1.55, outer = 2.12, depth = 0.06) {
  const startAngle = start * TAU;
  const endAngle = (start + width) * TAU;
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outer, startAngle, endAngle, false);
  shape.absarc(0, 0, inner, endAngle, startAngle, true);
  const bevel = 0.02;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 32,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, bevel, 0);
  return geometry;
}

function SessionPiece({
  block,
  onHoverBlock,
}: {
  block: OrbitBlock;
  onHoverBlock?: (label: string | undefined) => void;
}) {
  const geometry = useMemo(() => arcGeometry(block.start, block.width), [block.start, block.width]);
  const [hovered, setHovered] = useState(false);
  const mesh = useRef<THREE.Mesh>(null);
  const color = TONES[block.tone];

  useFrame(() => {
    if (!mesh.current) return;
    mesh.current.position.y = THREE.MathUtils.lerp(mesh.current.position.y, FELT_TOP + (hovered ? 0.12 : 0), 0.14);
    const material = mesh.current.material as THREE.MeshStandardMaterial;
    material.emissiveIntensity = THREE.MathUtils.lerp(material.emissiveIntensity, hovered ? 0.18 : 0, 0.12);
  });

  const over = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    setHovered(true);
    onHoverBlock?.(block.label);
  };
  const out = () => {
    setHovered(false);
    onHoverBlock?.(undefined);
  };

  return (
    <mesh ref={mesh} geometry={geometry} position={[0, FELT_TOP, 0]} onPointerOver={over} onPointerOut={out} castShadow receiveShadow>
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0} roughness={0.55} metalness={0.05} />
    </mesh>
  );
}

function NowMarker({ progress }: { progress: number }) {
  const angle = progress * TAU;
  return (
    <group rotation={[0, angle, 0]}>
      <mesh position={[DISC_R - 0.09, 0.16, 0]} castShadow>
        <sphereGeometry args={[0.07, 24, 16]} />
        <meshStandardMaterial color="#d6c39a" metalness={0.75} roughness={0.28} emissive="#d6c39a" emissiveIntensity={0.15} />
      </mesh>
      <mesh position={[(DISC_R - 0.09) / 2 + 0.1, FELT_TOP + 0.005, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.008, 0.008, DISC_R - 0.29, 8]} />
        <meshStandardMaterial color="#d6c39a" metalness={0.6} roughness={0.35} transparent opacity={0.6} />
      </mesh>
    </group>
  );
}

function Platter() {
  const geometry = useMemo(() => discGeometry(DISC_R), []);
  const hours = useMemo(() => Array.from({ length: 24 }, (_, hour) => hour), []);
  return (
    <group>
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshPhysicalMaterial color="#33303f" roughness={0.42} metalness={0.15} clearcoat={0.7} clearcoatRoughness={0.25} />
      </mesh>
      <mesh position={[0, 0.12, 0]} receiveShadow>
        <cylinderGeometry args={[FELT_R, FELT_R, 0.02, 96]} />
        <meshStandardMaterial color="#4a4462" roughness={0.95} />
      </mesh>
      {hours.map((hour) => {
        const angle = (hour / 24) * TAU;
        const major = hour % 6 === 0;
        return (
          <mesh key={hour} position={[Math.cos(angle) * (DISC_R - 0.09), 0.118, -Math.sin(angle) * (DISC_R - 0.09)]} castShadow>
            <cylinderGeometry args={[major ? 0.035 : 0.022, major ? 0.035 : 0.022, 0.018, 16]} />
            <meshStandardMaterial color={METAL} metalness={0.85} roughness={0.3} />
          </mesh>
        );
      })}
      <mesh position={[0, 0.2, 0]} castShadow>
        <cylinderGeometry args={[0.055, 0.065, 0.14, 24]} />
        <meshStandardMaterial color={METAL} metalness={0.9} roughness={0.22} />
      </mesh>
      <mesh position={[0, 0.275, 0]} castShadow>
        <sphereGeometry args={[0.055, 24, 16]} />
        <meshStandardMaterial color={METAL} metalness={0.9} roughness={0.22} />
      </mesh>
    </group>
  );
}

function OrbitRig({
  children,
  reducedMotion,
  interactive,
}: {
  children: React.ReactNode;
  reducedMotion: boolean;
  interactive: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const { size } = useThree();
  const drag = useRef<{ active: boolean; lastX: number; velocity: number }>({ active: false, lastX: 0, velocity: 0 });
  const target = useRef({ x: 0, y: 0 });
  const spin = useRef(0);

  useFrame((state, delta) => {
    if (!group.current) return;
    const pointer = state.pointer;
    if (interactive && !drag.current.active) {
      target.current.x = -pointer.y * 0.22;
      target.current.y = pointer.x * 0.3;
    }
    if (!reducedMotion) {
      if (drag.current.active) {
        spin.current += drag.current.velocity;
        drag.current.velocity *= 0.85;
      } else {
        spin.current += delta * 0.08 + drag.current.velocity;
        drag.current.velocity *= 0.92;
      }
    }
    const baseTilt = 0.2;
    group.current.rotation.x = THREE.MathUtils.lerp(group.current.rotation.x, baseTilt + target.current.x, 0.06);
    group.current.rotation.z = THREE.MathUtils.lerp(group.current.rotation.z, target.current.y * 0.4, 0.06);
    group.current.rotation.y = spin.current;
  });

  const onPointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (!interactive) return;
    drag.current = { active: true, lastX: event.clientX, velocity: 0 };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!drag.current.active) return;
    const dx = event.clientX - drag.current.lastX;
    drag.current.lastX = event.clientX;
    drag.current.velocity = (dx / size.width) * 2.4;
  };
  const onPointerUp = () => {
    drag.current.active = false;
  };

  return (
    <group
      ref={group}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      {children}
    </group>
  );
}

export default function PlanOrbitScene({
  blocks,
  progress,
  reducedMotion,
  interactive,
  compact = false,
  onHoverBlock,
}: PlanOrbitSceneProps) {
  return (
    <Canvas
      shadows="soft"
      dpr={[1, 1.75]}
      camera={{ position: [0, compact ? 3.3 : 3.8, compact ? 5.8 : 6.8], fov: 36 }}
      gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
      frameloop={reducedMotion ? "demand" : "always"}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", background: "transparent" }}
      onCreated={({ camera }) => camera.lookAt(0, -0.3, 0)}
    >
      <hemisphereLight args={["#c4bfdb", "#1d1b26", 0.9]} />
      <ambientLight intensity={0.15} />
      <directionalLight
        position={[3, 8, 4]}
        intensity={2.6}
        color="#fff3e4"
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-4}
        shadow-camera-right={4}
        shadow-camera-top={4}
        shadow-camera-bottom={-4}
        shadow-camera-near={1}
        shadow-camera-far={20}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />
      <directionalLight position={[-4, 2, -4]} intensity={0.5} color="#8f86b8" />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.6, 0]} receiveShadow>
        <planeGeometry args={[20, 20]} />
        <shadowMaterial opacity={0.3} />
      </mesh>
      <OrbitRig reducedMotion={reducedMotion} interactive={interactive}>
        <Platter />
        {blocks.map((block, index) => (
          <SessionPiece key={`${block.label}-${index}`} block={block} onHoverBlock={onHoverBlock} />
        ))}
        <NowMarker progress={progress} />
      </OrbitRig>
    </Canvas>
  );
}
