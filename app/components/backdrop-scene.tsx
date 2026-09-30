"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

/**
 * Backdrop — a calm, always-on 3D field behind the app screens: drifting
 * stars and three large tilted rings that parallax with the pointer.
 * Deliberately low-cost so it can run under every page.
 */

const TAU = Math.PI * 2;

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

function Field({ reducedMotion }: { reducedMotion: boolean }) {
  const stars = useRef<THREE.Points>(null);
  const rings = useRef<THREE.Group>(null);
  const positions = useMemo(() => {
    const random = seededRandom(7);
    const count = 700;
    const array = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      array[i * 3] = (random() - 0.5) * 40;
      array[i * 3 + 1] = (random() - 0.5) * 24;
      array[i * 3 + 2] = -4 - random() * 30;
    }
    return array;
  }, []);
  useFrame((state, delta) => {
    if (stars.current && !reducedMotion) stars.current.rotation.z += delta * 0.004;
    if (rings.current) {
      const targetX = state.pointer.y * 0.25;
      const targetY = state.pointer.x * 0.4;
      rings.current.rotation.x = THREE.MathUtils.lerp(rings.current.rotation.x, 1.1 + targetX, 0.03);
      rings.current.rotation.y = THREE.MathUtils.lerp(rings.current.rotation.y, targetY, 0.03);
      if (!reducedMotion) rings.current.rotation.z += delta * 0.03;
    }
    const cam = state.camera;
    cam.position.x = THREE.MathUtils.lerp(cam.position.x, state.pointer.x * 0.4, 0.03);
    cam.position.y = THREE.MathUtils.lerp(cam.position.y, state.pointer.y * 0.25, 0.03);
  });
  return (
    <>
      <points ref={stars}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <pointsMaterial color="#cfc6ff" size={0.05} sizeAttenuation transparent opacity={0.55} depthWrite={false} />
      </points>
      <group ref={rings} position={[6, -3, -9]}>
        {[
          { r: 5.5, c: "#7c3aed", o: 0.55 },
          { r: 7.6, c: "#db2777", o: 0.35 },
          { r: 9.8, c: "#0891b2", o: 0.25 },
        ].map((ring, index) => (
          <mesh key={index} rotation={[0, 0, (index * TAU) / 7]}>
            <torusGeometry args={[ring.r, 0.035, 12, 160]} />
            <meshBasicMaterial color={ring.c} transparent opacity={ring.o} depthWrite={false} />
          </mesh>
        ))}
      </group>
    </>
  );
}

export default function BackdropScene({ reducedMotion }: { reducedMotion: boolean }) {
  return (
    <Canvas
      dpr={[1, 1.25]}
      camera={{ position: [0, 0, 6], fov: 55 }}
      gl={{ alpha: true, antialias: false, powerPreference: "low-power" }}
      frameloop={reducedMotion ? "demand" : "always"}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", background: "transparent" }}
    >
      <Field reducedMotion={reducedMotion} />
    </Canvas>
  );
}
