"use client";

import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";

/**
 * PlanOrbit — a real-time 3D "day ring".
 *
 * The ring is a 24-hour clock laid flat. Session blocks are extruded arcs
 * sitting on the ring; a glowing marker shows the current time; waypoint
 * spheres float above each block. The whole group slowly rotates, tilts
 * toward the pointer, and can be dragged to spin. Built with Three.js via
 * React Three Fiber so it needs no external scene URL.
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

const TONES: Record<OrbitBlock["tone"], string> = {
  violet: "#a78bfa",
  coral: "#fb7185",
  cyan: "#22d3ee",
  amber: "#fbbf24",
};

const RING_RADIUS = 2.15;
const TAU = Math.PI * 2;

function arcGeometry(start: number, width: number, inner = RING_RADIUS - 0.34, outer = RING_RADIUS + 0.34, depth = 0.28) {
  const startAngle = start * TAU;
  const endAngle = (start + width) * TAU;
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outer, startAngle, endAngle, false);
  shape.absarc(0, 0, inner, endAngle, startAngle, true);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.04,
    bevelSegments: 2,
    curveSegments: 24,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -depth / 2, 0);
  return geometry;
}

function SessionBlock({
  block,
  index,
  reducedMotion,
  onHoverBlock,
}: {
  block: OrbitBlock;
  index: number;
  reducedMotion: boolean;
  onHoverBlock?: (label: string | undefined) => void;
}) {
  const geometry = useMemo(() => arcGeometry(block.start, block.width), [block.start, block.width]);
  const [hovered, setHovered] = useState(false);
  const mesh = useRef<THREE.Mesh>(null);
  const sphere = useRef<THREE.Mesh>(null);
  const color = TONES[block.tone];
  const midAngle = (block.start + block.width / 2) * TAU;
  const sx = Math.cos(midAngle) * RING_RADIUS;
  const sz = -Math.sin(midAngle) * RING_RADIUS;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (mesh.current) {
      const lift = hovered ? 0.22 : 0;
      mesh.current.position.y = THREE.MathUtils.lerp(mesh.current.position.y, lift, 0.12);
      const material = mesh.current.material as THREE.MeshStandardMaterial;
      material.emissiveIntensity = THREE.MathUtils.lerp(material.emissiveIntensity, hovered ? 1.3 : 0.55, 0.1);
    }
    if (sphere.current) {
      const bob = reducedMotion ? 0 : Math.sin(t * 1.4 + index) * 0.08;
      sphere.current.position.y = 0.75 + bob + (hovered ? 0.2 : 0);
    }
  });

  const over = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    setHovered(true);
    onHoverBlock?.(block.label);
    document.body.style.cursor = "pointer";
  };
  const out = () => {
    setHovered(false);
    onHoverBlock?.(undefined);
    document.body.style.cursor = "";
  };

  return (
    <group>
      <mesh ref={mesh} geometry={geometry} onPointerOver={over} onPointerOut={out} castShadow>
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.55}
          roughness={0.35}
          metalness={0.15}
          transparent
          opacity={0.94}
        />
      </mesh>
      <mesh ref={sphere} position={[sx, 0.75, sz]}>
        <sphereGeometry args={[0.09, 24, 24]} />
        <meshStandardMaterial color="#ffffff" emissive={color} emissiveIntensity={1.6} roughness={0.2} />
      </mesh>
      <mesh position={[sx, 0.4, sz]}>
        <cylinderGeometry args={[0.008, 0.008, 0.6, 6]} />
        <meshBasicMaterial color={color} transparent opacity={0.45} />
      </mesh>
    </group>
  );
}

function NowMarker({ progress, reducedMotion }: { progress: number; reducedMotion: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const glow = useRef<THREE.Mesh>(null);
  const angle = progress * TAU;
  useFrame(({ clock }) => {
    if (!glow.current || reducedMotion) return;
    const s = 1 + Math.sin(clock.getElapsedTime() * 2.2) * 0.18;
    glow.current.scale.setScalar(s);
  });
  return (
    <group ref={ref} rotation={[0, angle, 0]}>
      <mesh position={[RING_RADIUS, 0.02, 0]}>
        <sphereGeometry args={[0.13, 24, 24]} />
        <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={2} />
      </mesh>
      <mesh ref={glow} position={[RING_RADIUS, 0.02, 0]}>
        <sphereGeometry args={[0.26, 24, 24]} />
        <meshBasicMaterial color="#f5d0fe" transparent opacity={0.22} />
      </mesh>
      <mesh position={[RING_RADIUS / 2, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.01, 0.01, RING_RADIUS, 6]} />
        <meshBasicMaterial color="#e9d5ff" transparent opacity={0.5} />
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
          <mesh
            key={hour}
            position={[Math.cos(angle) * (RING_RADIUS + 0.55), 0, -Math.sin(angle) * (RING_RADIUS + 0.55)]}
            rotation={[0, -angle, 0]}
          >
            <boxGeometry args={[major ? 0.16 : 0.08, 0.02, 0.03]} />
            <meshBasicMaterial color={major ? "#c4b5fd" : "#6d6a8f"} transparent opacity={major ? 0.9 : 0.6} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Small deterministic PRNG so the particle field is identical on every render. */
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

function Particles({ reducedMotion }: { reducedMotion: boolean }) {
  const ref = useRef<THREE.Points>(null);
  const positions = useMemo(() => {
    const random = seededRandom(1337);
    const count = 220;
    const array = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const radius = 2.6 + random() * 3.2;
      const angle = random() * TAU;
      array[i * 3] = Math.cos(angle) * radius;
      array[i * 3 + 1] = (random() - 0.5) * 2.6;
      array[i * 3 + 2] = Math.sin(angle) * radius;
    }
    return array;
  }, []);
  useFrame((_, delta) => {
    if (ref.current && !reducedMotion) ref.current.rotation.y += delta * 0.02;
  });
  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#c4b5fd" size={0.035} sizeAttenuation transparent opacity={0.55} depthWrite={false} />
    </points>
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
      target.current.x = -pointer.y * 0.28;
      target.current.y = pointer.x * 0.35;
    }
    if (!reducedMotion) {
      if (drag.current.active) {
        spin.current += drag.current.velocity;
        drag.current.velocity *= 0.85;
      } else {
        spin.current += delta * 0.12 + drag.current.velocity;
        drag.current.velocity *= 0.92;
      }
    }
    const baseTilt = 0.62;
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
      {/* Invisible drag plane so empty space is draggable too */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]}>
        <circleGeometry args={[3.4, 48]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
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
      dpr={[1, 1.75]}
      camera={{ position: [0, compact ? 3.4 : 3.9, compact ? 5.9 : 7.0], fov: 36 }}
      gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
      frameloop={reducedMotion ? "demand" : "always"}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", background: "transparent" }}
    >
      <ambientLight intensity={0.55} />
      <pointLight position={[4, 5, 3]} intensity={38} color="#c4b5fd" />
      <pointLight position={[-4, 3, -3]} intensity={26} color="#fb7185" />
      <pointLight position={[0, -3, 2]} intensity={10} color="#22d3ee" />
      <OrbitRig reducedMotion={reducedMotion} interactive={interactive}>
        {/* Base ring */}
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[RING_RADIUS, 0.05, 16, 120]} />
          <meshStandardMaterial color="#7c3aed" emissive="#7c3aed" emissiveIntensity={0.7} roughness={0.4} />
        </mesh>
        {/* Soft inner disc */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.12, 0]}>
          <ringGeometry args={[RING_RADIUS - 0.9, RING_RADIUS + 0.9, 96]} />
          <meshBasicMaterial color="#5b21b6" transparent opacity={0.12} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
        <Ticks />
        {blocks.map((block, index) => (
          <SessionBlock
            key={`${block.label}-${index}`}
            block={block}
            index={index}
            reducedMotion={reducedMotion}
            onHoverBlock={onHoverBlock}
          />
        ))}
        <NowMarker progress={progress} reducedMotion={reducedMotion} />
        <Particles reducedMotion={reducedMotion} />
      </OrbitRig>
    </Canvas>
  );
}
