import { useEffect, useRef } from "react";
import * as THREE from "three";

interface RopePullProps {
  running: boolean;
  progress: number;
  onPull: () => void;
  onStretchChange: (ratio: number) => void;
}

const NODE_COUNT = 9;
const REST_LENGTH = 0.175;
const DOWN = new THREE.Vector3(0, -1, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export default function RopePull({ running, progress, onPull, onStretchChange }: RopePullProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef(running);
  const progressRef = useRef(progress);
  const onPullRef = useRef(onPull);
  const onStretchRef = useRef(onStretchChange);

  runningRef.current = running;
  progressRef.current = progress;
  onPullRef.current = onPull;
  onStretchRef.current = onStretchChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
    } catch {
      host.classList.add("rope-pull-fallback");
      return undefined;
    }

    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    const canvas = renderer.domElement;
    canvas.className = "rope-pull-canvas";
    canvas.setAttribute("aria-hidden", "true");
    host.prepend(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1.5, 1.5, 1.2, -1.2, 0.1, 20);
    camera.position.set(0, 0, 6);
    scene.add(new THREE.HemisphereLight(0xfff6e3, 0x492057, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 3.8);
    key.position.set(-2, 4, 6);
    scene.add(key);

    const colors = [0xff4f93, 0xff7a45, 0xffd44d, 0x52e7d6, 0x5e9bff];
    const ropeMaterials = colors.map((color) => new THREE.MeshPhysicalMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.2,
      roughness: 0.46,
      clearcoat: 0.72,
      clearcoatRoughness: 0.3,
    }));
    const segmentGeometry = new THREE.CylinderGeometry(0.048, 0.048, 1, 14, 2);
    const segments = Array.from({ length: NODE_COUNT - 1 }, (_, index) => {
      const mesh = new THREE.Mesh(segmentGeometry, ropeMaterials[index % ropeMaterials.length]);
      mesh.castShadow = true;
      scene.add(mesh);
      return mesh;
    });

    const collarMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xfff3a1,
      emissive: 0xffb429,
      emissiveIntensity: 0.45,
      roughness: 0.32,
      metalness: 0.18,
      clearcoat: 1,
    });
    const collars = Array.from({ length: NODE_COUNT - 2 }, () => {
      const mesh = new THREE.Mesh(new THREE.TorusGeometry(0.052, 0.012, 8, 20), collarMaterial);
      scene.add(mesh);
      return mesh;
    });

    const anchorMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x70f2e0,
      emissive: 0x2fdac5,
      emissiveIntensity: 0.65,
      metalness: 0.35,
      roughness: 0.24,
    });
    const anchorRing = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.035, 16, 48), anchorMaterial);
    anchorRing.position.z = 0.03;
    scene.add(anchorRing);

    const knotMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xff5f87,
      emissive: 0xff315f,
      emissiveIntensity: 0.48,
      roughness: 0.35,
      clearcoat: 1,
      clearcoatRoughness: 0.2,
    });
    const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.19, 0.057, 112, 16, 2, 3), knotMaterial);
    knot.scale.setScalar(0.92);
    scene.add(knot);
    const knotLight = new THREE.PointLight(0xff477b, 2.7, 2.2);
    knotLight.position.z = 0.55;
    knot.add(knotLight);

    const tasselGeometry = new THREE.CylinderGeometry(0.032, 0.018, 0.26, 10);
    const tassels = [0, 1].map((index) => {
      const mesh = new THREE.Mesh(tasselGeometry, ropeMaterials[index === 0 ? 2 : 3]);
      mesh.rotation.z = index === 0 ? 0.28 : -0.28;
      scene.add(mesh);
      return mesh;
    });

    const anchor = new THREE.Vector3(-1.08, 0.93, 0);
    const positions = Array.from({ length: NODE_COUNT }, (_, index) => (
      anchor.clone().add(new THREE.Vector3(0.09 * Math.sin(index * 0.72), -REST_LENGTH * index, 0))
    ));
    const previous = positions.map((position, index) => position.clone().add(new THREE.Vector3(index ? -0.012 : 0, 0, 0)));
    const pointerWorld = new THREE.Vector3();
    const dragOffset = new THREE.Vector3();
    const dragTarget = new THREE.Vector3();
    const midpoint = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let dragging = false;
    let pointerId = -1;
    let pullOriginY = positions.at(-1)?.y ?? -0.85;
    let maximumPull = 0;
    let width = 1;
    let height = 1;
    let raf = 0;
    let last = performance.now();
    let elapsed = 0;
    let alive = true;

    const updateCamera = () => {
      width = Math.max(1, host.clientWidth);
      height = Math.max(1, host.clientHeight);
      const aspect = width / height;
      const vertical = 2.45;
      camera.left = -(vertical * aspect) / 2;
      camera.right = (vertical * aspect) / 2;
      camera.top = vertical / 2;
      camera.bottom = -vertical / 2;
      camera.updateProjectionMatrix();
      anchor.set(camera.left + 0.48, camera.top - 0.28, 0);
      positions[0].copy(anchor);
      previous[0].copy(anchor);
      anchorRing.position.copy(anchor);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
    };

    const eventToWorld = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointerWorld.set(
        camera.left + ((event.clientX - rect.left) / rect.width) * (camera.right - camera.left),
        camera.top - ((event.clientY - rect.top) / rect.height) * (camera.top - camera.bottom),
        0,
      );
      return pointerWorld;
    };

    const solveRope = () => {
      for (let iteration = 0; iteration < 7; iteration += 1) {
        positions[0].copy(anchor);
        for (let index = 0; index < NODE_COUNT - 1; index += 1) {
          const a = positions[index];
          const b = positions[index + 1];
          direction.subVectors(b, a);
          const length = Math.max(direction.length(), 0.0001);
          const correction = direction.multiplyScalar((length - REST_LENGTH) / length);
          if (index === 0) b.addScaledVector(correction, -1);
          else {
            a.addScaledVector(correction, 0.5);
            b.addScaledVector(correction, -0.5);
          }
        }
        if (dragging) positions[NODE_COUNT - 1].copy(dragTarget);
      }
      positions[0].copy(anchor);
    };

    const updateMeshes = () => {
      segments.forEach((segment, index) => {
        const start = positions[index];
        const end = positions[index + 1];
        direction.subVectors(end, start);
        const length = direction.length();
        midpoint.addVectors(start, end).multiplyScalar(0.5);
        segment.position.copy(midpoint);
        segment.quaternion.setFromUnitVectors(Y_AXIS, direction.normalize());
        segment.scale.set(1, length, 1);
      });
      collars.forEach((collar, index) => {
        const nodeIndex = index + 1;
        collar.position.copy(positions[nodeIndex]);
        direction.subVectors(positions[nodeIndex + 1], positions[nodeIndex - 1]).normalize();
        collar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
      });
      const tail = positions[NODE_COUNT - 1];
      knot.position.copy(tail);
      knot.rotation.x = elapsed * 0.45;
      knot.rotation.y = elapsed * 0.8;
      const intensity = runningRef.current ? 0.58 + progressRef.current / 145 : 0.48;
      knotMaterial.emissiveIntensity = intensity;
      knot.scale.setScalar(0.92 + (runningRef.current ? Math.sin(elapsed * 13) * 0.045 : Math.sin(elapsed * 2) * 0.018));
      tassels[0].position.copy(tail).add(new THREE.Vector3(-0.075, -0.24, 0));
      tassels[1].position.copy(tail).add(new THREE.Vector3(0.075, -0.24, 0));
      anchorRing.rotation.z = elapsed * 0.22;
    };

    const tick = (now: number) => {
      if (!alive) return;
      const dt = Math.min(1 / 30, Math.max(1 / 240, (now - last) / 1000));
      last = now;
      elapsed += dt;
      const activity = runningRef.current ? 0.024 + (progressRef.current / 100) * 0.045 : 0;
      for (let index = 1; index < NODE_COUNT; index += 1) {
        if (dragging && index === NODE_COUNT - 1) continue;
        const point = positions[index];
        const old = previous[index];
        const vx = (point.x - old.x) * 0.978;
        const vy = (point.y - old.y) * 0.978;
        old.copy(point);
        const breeze = reducedMotion ? 0 : Math.sin(elapsed * 1.35 + index * 0.58) * 0.00008 * index;
        const pulse = activity ? Math.sin(elapsed * (13 + progressRef.current * 0.08) + index) * activity * dt : 0;
        point.x += vx + breeze + pulse;
        point.y += vy - 7.2 * dt * dt + (activity ? Math.cos(elapsed * 11 + index) * activity * dt * 0.25 : 0);
      }
      if (dragging) positions[NODE_COUNT - 1].copy(dragTarget);
      solveRope();
      updateMeshes();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };

    const beginDrag = (event: PointerEvent) => {
      if (runningRef.current || event.button > 0) return;
      const world = eventToWorld(event);
      const tail = positions[NODE_COUNT - 1];
      if (world.distanceTo(tail) > 0.47) return;
      dragging = true;
      pointerId = event.pointerId;
      pullOriginY = tail.y;
      maximumPull = 0;
      dragOffset.subVectors(tail, world);
      dragTarget.copy(tail);
      host.classList.add("is-grabbing");
      canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    };

    const moveDrag = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== pointerId) return;
      eventToWorld(event);
      dragTarget.copy(pointerWorld).add(dragOffset);
      dragTarget.x = clamp(dragTarget.x, camera.left + 0.18, camera.right - 0.18);
      dragTarget.y = clamp(dragTarget.y, camera.bottom + 0.14, camera.top - 0.3);
      const ratio = clamp((pullOriginY - dragTarget.y) / 0.55, 0, 1);
      maximumPull = Math.max(maximumPull, ratio);
      onStretchRef.current(ratio);
      host.dataset.pullReady = ratio >= 0.78 ? "true" : "false";
      event.preventDefault();
    };

    const endDrag = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== pointerId) return;
      dragging = false;
      host.classList.remove("is-grabbing");
      delete host.dataset.pullReady;
      canvas.releasePointerCapture?.(event.pointerId);
      previous[NODE_COUNT - 1].copy(positions[NODE_COUNT - 1]).add(new THREE.Vector3(0, maximumPull > 0.78 ? -0.15 : -0.03, 0));
      onStretchRef.current(0);
      if (maximumPull >= 0.78) onPullRef.current();
      maximumPull = 0;
      pointerId = -1;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key === "Enter" || event.key === " ") && !runningRef.current) {
        event.preventDefault();
        onStretchRef.current(1);
        window.setTimeout(() => onStretchRef.current(0), 180);
        onPullRef.current();
      }
    };

    canvas.addEventListener("pointerdown", beginDrag);
    canvas.addEventListener("pointermove", moveDrag);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    host.addEventListener("keydown", onKeyDown);
    const resizeObserver = new ResizeObserver(updateCamera);
    resizeObserver.observe(host);
    updateCamera();
    updateMeshes();
    raf = requestAnimationFrame(tick);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", beginDrag);
      canvas.removeEventListener("pointermove", moveDrag);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
      host.removeEventListener("keydown", onKeyDown);
      segmentGeometry.dispose();
      tasselGeometry.dispose();
      collars.forEach((mesh) => mesh.geometry.dispose());
      anchorRing.geometry.dispose();
      knot.geometry.dispose();
      [...ropeMaterials, collarMaterial, anchorMaterial, knotMaterial].forEach((material) => material.dispose());
      renderer.dispose();
      canvas.remove();
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className={`rope-pull ${running ? "is-running" : ""}`}
      role="button"
      tabIndex={running ? -1 : 0}
      aria-disabled={running}
      aria-label={running ? `正在下载，进度 ${progress}%` : "抓住绳结向下拉，重新下载全部附件"}
    >
      <div className="rope-callout">
        <strong>{running ? `${progress}%` : "PULL!"}</strong>
        <span>{running ? "正在把文件装进口袋" : "抓住绳结，向下拽"}</span>
      </div>
      <div className="rope-ready-copy">松手发射！</div>
    </div>
  );
}
