"use client";

/**
 * Magepunk halo for the stacked week (copy only).
 *
 * Shape language taken from the Origin collection's crescent blade and
 * Vandal: long smooth crescents that taper to points, a thin gold arc nested
 * inside each one, engraved energy lines with small circle nodes, round gold
 * hubs with a hole through them, and straight etched rune bars. Everything is
 * swept geometry (no boxes) in the clock's own palette: dark bronze, brass,
 * and a warm amber glow.
 */

import { RoundedBox } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

const TAU = Math.PI * 2;

export const RING_PAL = {
  body: "#2a211d",
  brass: "#c9a862",
  glow: "#ffbf6b",
  dark: "#1a0f05",
} as const;

type Point = { x: number; y: number };

/** Lens-shaped cross-section: wide and thin, like a blade seen end-on. */
function lensProfile(width: number, height: number, lift = 0, count = 22): Point[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * TAU;
    const s = Math.sin(angle);
    return { x: width * Math.cos(angle), y: lift + height * s * (0.7 + 0.3 * Math.abs(s)) };
  });
}

function roundProfile(radius: number, lift = 0, count = 12): Point[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * TAU;
    return { x: radius * Math.cos(angle), y: lift + radius * Math.sin(angle) };
  });
}

/** Fat in the middle, pointed at both ends. */
const bladeTaper = (t: number) => 0.05 + 0.95 * Math.pow(Math.sin(Math.PI * t), 0.55);
const softTaper = (t: number) => 0.35 + 0.65 * Math.pow(Math.sin(Math.PI * t), 0.5);
const flat = () => 1;

/**
 * Sweeps a closed 2D profile (x = outward, y = up) along an arc around the Y
 * axis, centred on 12 o'clock. `taper(t)` scales the profile along the way.
 */
export function sweepGeometry(profile: Point[], radius: number, arc: number, taper: (t: number) => number = flat, steps = 56) {
  const n = profile.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const angle = -arc / 2 + t * arc;
    const k = taper(t);
    for (let j = 0; j <= n; j += 1) {
      const point = profile[j % n];
      const r = radius + point.x * k;
      positions.push(Math.sin(angle) * r, point.y * k, -Math.cos(angle) * r);
      uvs.push(t, j / n);
    }
  }
  const stride = n + 1;
  for (let i = 0; i < steps; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const a = i * stride + j;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function flatTorus(radius: number, tube: number, segments = 64) {
  const geometry = new THREE.TorusGeometry(radius, tube, 10, segments);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

function Bronze({ roughness = 0.36 }: { roughness?: number }) {
  return <meshStandardMaterial color={RING_PAL.body} metalness={0.88} roughness={roughness} envMapIntensity={1.2} side={THREE.DoubleSide} />;
}
function Brass() {
  return <meshStandardMaterial color={RING_PAL.brass} metalness={1} roughness={0.22} envMapIntensity={1.4} side={THREE.DoubleSide} />;
}

const BLADES = 4;
const BLADE_ARC = 1.85;

export function MageRing({
  radius,
  seed = 0,
  reducedMotion = false,
  detail = 3,
}: {
  radius: number;
  seed?: number;
  reducedMotion?: boolean;
  /** 1 = crescents only, 2 = + hubs and base track, 3 = + nodes and rune bars. */
  detail?: 1 | 2 | 3;
}) {
  const spin = useRef<THREE.Group>(null);
  const bars = useRef<THREE.Group>(null);
  const glows = useRef<THREE.MeshStandardMaterial[]>([]);
  const geometries = useMemo(
    () => ({
      blade: sweepGeometry(lensProfile(0.21, 0.07), radius, BLADE_ARC, bladeTaper),
      bladeEdge: sweepGeometry(roundProfile(0.012, 0), radius + 0.2, BLADE_ARC * 0.92, bladeTaper),
      innerArc: sweepGeometry(roundProfile(0.014, -0.01), radius - 0.3, BLADE_ARC * 0.7, softTaper),
      innerArcCap: new THREE.SphereGeometry(0.03, 16, 12),
      glowLine: sweepGeometry(roundProfile(0.011, 0.055), radius + 0.04, BLADE_ARC * 0.82, bladeTaper),
      node: flatTorus(0.04, 0.009, 32),
      track: sweepGeometry(lensProfile(0.075, 0.028, -0.16), radius + 0.12, TAU, flat, 160),
      trackRim: flatTorus(radius + 0.2, 0.012, 160),
      hub: flatTorus(0.1, 0.028, 40),
      hubRim: flatTorus(0.15, 0.009, 48),
      hubCore: new THREE.CylinderGeometry(0.055, 0.055, 0.03, 32),
      hubEye: new THREE.CylinderGeometry(0.028, 0.028, 0.034, 24),
    }),
    [radius],
  );
  const direction = seed % 2 === 0 ? 1 : -1;
  useFrame(({ clock }) => {
    if (reducedMotion) return;
    const t = clock.getElapsedTime();
    if (spin.current) {
      spin.current.rotation.y = t * 0.09 * direction + seed * 0.7;
      spin.current.position.y = Math.sin(t * 0.6 + seed) * 0.025;
    }
    if (bars.current) {
      bars.current.rotation.y = -t * 0.14 * direction + seed * 1.9;
      bars.current.position.y = 0.46 + Math.sin(t * 0.8 + seed * 2) * 0.04;
    }
    glows.current.forEach((material, index) => {
      if (material) material.emissiveIntensity = 2.2 + Math.sin(t * 2 + index * 0.9 + seed) * 1.1;
    });
  });
  const registerGlow = (index: number) => (material: THREE.MeshStandardMaterial | null) => {
    if (material) glows.current[index] = material;
  };
  const blades = useMemo(() => Array.from({ length: BLADES }, (_, index) => (index / BLADES) * TAU), []);
  return (
    <group>
      <group ref={spin}>
        {blades.map((angle, index) => (
          <group key={index} rotation={[0, angle, 0]}>
            <mesh geometry={geometries.blade} castShadow receiveShadow>
              <Bronze />
            </mesh>
            <mesh geometry={geometries.bladeEdge}>
              <Brass />
            </mesh>
            <mesh geometry={geometries.innerArc}>
              <Brass />
            </mesh>
            {[-1, 1].map((end) => (
              <mesh
                key={end}
                geometry={geometries.innerArcCap}
                position={[Math.sin((end * BLADE_ARC * 0.7) / 2) * (radius - 0.3), -0.01, -Math.cos((end * BLADE_ARC * 0.7) / 2) * (radius - 0.3)]}
              >
                <Brass />
              </mesh>
            ))}
            <mesh geometry={geometries.glowLine}>
              <meshStandardMaterial ref={registerGlow(index)} color={RING_PAL.dark} emissive={RING_PAL.glow} emissiveIntensity={2.4} toneMapped={false} />
            </mesh>
            {detail >= 3 &&
              [-0.42, 0, 0.42].map((offset) => (
                <mesh
                  key={offset}
                  geometry={geometries.node}
                  position={[Math.sin(offset * BLADE_ARC) * (radius + 0.04), 0.07, -Math.cos(offset * BLADE_ARC) * (radius + 0.04)]}
                >
                  <meshStandardMaterial color={RING_PAL.dark} emissive={RING_PAL.glow} emissiveIntensity={2.8} toneMapped={false} />
                </mesh>
              ))}
            {detail >= 2 && (
              <group position={[Math.sin(Math.PI / BLADES) * (radius - 0.02), 0.11, -Math.cos(Math.PI / BLADES) * (radius - 0.02)]}>
                <mesh geometry={geometries.hub} castShadow>
                  <Brass />
                </mesh>
                <mesh geometry={geometries.hubRim}>
                  <Brass />
                </mesh>
                <mesh geometry={geometries.hubCore}>
                  <Bronze roughness={0.3} />
                </mesh>
                <mesh geometry={geometries.hubEye} position={[0, 0.004, 0]}>
                  <meshStandardMaterial ref={registerGlow(BLADES + index)} color={RING_PAL.dark} emissive={RING_PAL.glow} emissiveIntensity={2.4} toneMapped={false} />
                </mesh>
              </group>
            )}
          </group>
        ))}
      </group>
      {detail >= 2 && (
        <group>
          <mesh geometry={geometries.track} receiveShadow>
            <Bronze roughness={0.4} />
          </mesh>
          <mesh geometry={geometries.trackRim} position={[0, -0.16, 0]}>
            <Brass />
          </mesh>
        </group>
      )}
      {detail >= 3 && (
        <group ref={bars} position={[0, 0.46, 0]}>
          {[0, 1, 2].map((index) => (
            <group key={index} rotation={[0, (index / 3) * TAU + 0.4, 0]}>
              <group position={[0, 0, -(radius - 0.45)]} rotation={[0.18, 0, 0]}>
                <RoundedBox args={[0.62, 0.05, 0.1]} radius={0.02} smoothness={4} castShadow>
                  <Bronze roughness={0.32} />
                </RoundedBox>
                {[-1, 1].map((end) => (
                  <RoundedBox key={end} args={[0.08, 0.056, 0.106]} radius={0.02} smoothness={4} position={[end * 0.3, 0, 0]}>
                    <Brass />
                  </RoundedBox>
                ))}
                {[-0.16, -0.08, 0, 0.08, 0.16].map((x, line) => (
                  <mesh key={x} position={[x, 0.027, 0]} rotation={[0, line % 2 === 0 ? 0.5 : -0.5, 0]}>
                    <boxGeometry args={[0.012, 0.004, 0.05]} />
                    <meshStandardMaterial color={RING_PAL.dark} emissive={RING_PAL.glow} emissiveIntensity={2.2} toneMapped={false} />
                  </mesh>
                ))}
              </group>
            </group>
          ))}
        </group>
      )}
    </group>
  );
}
