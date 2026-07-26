"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  ClothSimulation,
  clothFloorY,
  clothFormColliders,
  type ClothSettings,
  type PinPattern,
} from "./cloth-physics";

type ToolMode = "orbit" | "grab" | "pin";

type LabSettings = ClothSettings & {
  wireframe: boolean;
  formVisible: boolean;
  showColliders: boolean;
};

type FabricPreset = {
  id: string;
  label: string;
  code: string;
  color: string;
  sheen: string;
  roughness: number;
  mass: number;
  stretch: number;
  bend: number;
  damping: number;
  friction: number;
};

type SceneApi = {
  reset: () => void;
  setPinPattern: (pattern: PinPattern) => void;
  stepOnce: () => void;
  updateAppearance: (
    preset: FabricPreset,
    settings: Pick<LabSettings, "wireframe" | "formVisible" | "showColliders">,
  ) => void;
  cancelDrag: () => void;
  nudgeView: (horizontal: number, vertical: number, zoom: number) => void;
  pinCenter: () => void;
};

const PRESETS: FabricPreset[] = [
  {
    id: "silk",
    label: "Silk",
    code: "SK-01",
    color: "#c7f4dd",
    sheen: "#d8fff1",
    roughness: 0.22,
    mass: 0.42,
    stretch: 0.9,
    bend: 0.08,
    damping: 0.991,
    friction: 0.12,
  },
  {
    id: "cotton",
    label: "Cotton",
    code: "CT-02",
    color: "#d5d0ff",
    sheen: "#ffffff",
    roughness: 0.58,
    mass: 0.82,
    stretch: 0.95,
    bend: 0.24,
    damping: 0.995,
    friction: 0.34,
  },
  {
    id: "denim",
    label: "Denim",
    code: "DN-03",
    color: "#4f72ff",
    sheen: "#91a6ff",
    roughness: 0.72,
    mass: 1.38,
    stretch: 0.985,
    bend: 0.48,
    damping: 0.997,
    friction: 0.54,
  },
  {
    id: "leather",
    label: "Leather",
    code: "LT-04",
    color: "#d56f45",
    sheen: "#ffc0a3",
    roughness: 0.38,
    mass: 1.72,
    stretch: 0.993,
    bend: 0.68,
    damping: 0.998,
    friction: 0.68,
  },
];

const DEFAULT_SETTINGS: LabSettings = {
  mass: PRESETS[1].mass,
  gravity: 1,
  wind: 3.8,
  turbulence: 0.46,
  stretch: PRESETS[1].stretch,
  bend: PRESETS[1].bend,
  damping: PRESETS[1].damping,
  friction: PRESETS[1].friction,
  selfCollision: true,
  wireframe: false,
  formVisible: true,
  showColliders: false,
};

const PIN_LABELS: Record<PinPattern, string> = {
  shoulders: "Shoulder points",
  rail: "Full collar rail",
  single: "Center hook",
  free: "Free fall",
};

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  unit,
  displayValue,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  displayValue?: string;
  onChange: (value: number) => void;
}) {
  const progress = ((value - min) / (max - min)) * 100;
  return (
    <label className="range-control">
      <span className="range-meta">
        <span>{label}</span>
        <output>
          {displayValue ?? value.toFixed(step < 0.01 ? 3 : step < 1 ? 2 : 1)}
          {unit}
        </output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        style={{ "--range-progress": `${progress}%` } as CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true">
        <span />
      </span>
    </label>
  );
}

export default function ClothLab() {
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneApiRef = useRef<SceneApi | null>(null);
  const settingsRef = useRef<LabSettings>(DEFAULT_SETTINGS);
  const pausedRef = useRef(false);
  const toolRef = useRef<ToolMode>("grab");
  const guideButtonRef = useRef<HTMLButtonElement>(null);
  const helpCardRef = useRef<HTMLElement>(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [activePreset, setActivePreset] = useState("cotton");
  const [pinPattern, setPinPattern] = useState<PinPattern>("shoulders");
  const [tool, setTool] = useState<ToolMode>("grab");
  const [paused, setPaused] = useState(false);
  const [fps, setFps] = useState(60);
  const [strain, setStrain] = useState({ average: 0, max: 0 });
  const [pinCount, setPinCount] = useState(2);
  const [quality, setQuality] = useState("35 × 29");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const preset =
    PRESETS.find((candidate) => candidate.id === activePreset) ?? PRESETS[1];

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  const setSetting = useCallback(
    <Key extends keyof LabSettings>(key: Key, value: LabSettings[Key]) => {
      setSettings((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const applyPreset = useCallback((next: FabricPreset) => {
    setActivePreset(next.id);
    setSettings((current) => ({
      ...current,
      mass: next.mass,
      stretch: next.stretch,
      bend: next.bend,
      damping: next.damping,
      friction: next.friction,
    }));
  }, []);

  const reset = useCallback(() => {
    sceneApiRef.current?.reset();
  }, []);

  useEffect(() => {
    sceneApiRef.current?.updateAppearance(preset, {
      wireframe: settings.wireframe,
      formVisible: settings.formVisible,
      showColliders: settings.showColliders,
    });
  }, [
    preset,
    settings.wireframe,
    settings.formVisible,
    settings.showColliders,
  ]);

  useEffect(() => {
    sceneApiRef.current?.setPinPattern(pinPattern);
  }, [pinPattern]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "SELECT" ||
        target?.tagName === "TEXTAREA"
      ) {
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        setPaused((current) => !current);
      } else if (event.key.toLowerCase() === "r") {
        reset();
      } else if (event.key.toLowerCase() === "g") {
        setTool("grab");
      } else if (event.key.toLowerCase() === "p") {
        setTool("pin");
      } else if (event.key.toLowerCase() === "o") {
        setTool("orbit");
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        sceneApiRef.current?.nudgeView(-0.08, 0, 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        sceneApiRef.current?.nudgeView(0.08, 0, 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        sceneApiRef.current?.nudgeView(0, -0.06, 1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        sceneApiRef.current?.nudgeView(0, 0.06, 1);
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        sceneApiRef.current?.nudgeView(0, 0, 0.92);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        sceneApiRef.current?.nudgeView(0, 0, 1.08);
      } else if (event.key === "Enter" && toolRef.current === "pin") {
        event.preventDefault();
        sceneApiRef.current?.pinCenter();
      } else if (event.key === "Escape") {
        setHelpOpen(false);
        setInspectorOpen(false);
        sceneApiRef.current?.cancelDrag();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [reset]);

  useEffect(() => {
    if (!helpOpen) return;
    const dialog = helpCardRef.current;
    if (!dialog) return;
    const guideButton = guideButtonRef.current;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", trapFocus);
    return () => {
      document.removeEventListener("keydown", trapFocus);
      guideButton?.focus();
    };
  }, [helpOpen]);

  useEffect(() => {
    const host = stageRef.current;
    if (!host) return;

    const isCompact = window.innerWidth < 760;
    const cols = isCompact ? 29 : 35;
    const rows = isCompact ? 25 : 29;
    setQuality(`${cols} × ${rows}`);

    const initialPreset = PRESETS[1];
    const simulation = new ClothSimulation(cols, rows);
    simulation.setMass(settingsRef.current.mass);
    simulation.setPinPattern("shoulders");
    setPinCount(simulation.pinCount);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x080a0c, 0.055);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 60);
    camera.position.set(0.1, 0.55, 6.8);

    const renderer = new THREE.WebGLRenderer({
      antialias: !isCompact,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, isCompact ? 1.4 : 1.8));
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    renderer.shadowMap.enabled = !isCompact;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.domElement.className = "cloth-canvas";
    renderer.domElement.setAttribute(
      "aria-label",
      "Interactive 3D cape simulation. Drag the fabric, orbit the view, or pin points.",
    );
    renderer.domElement.setAttribute("aria-describedby", "viewport-instructions");
    renderer.domElement.setAttribute("role", "application");
    renderer.domElement.tabIndex = 0;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.065;
    controls.minDistance = 3.6;
    controls.maxDistance = 12;
    controls.maxPolarAngle = Math.PI * 0.87;
    controls.target.set(0, 0.2, -0.25);

    scene.add(new THREE.HemisphereLight(0xb8ddff, 0x17110e, 1.65));
    const keyLight = new THREE.DirectionalLight(0xffffff, 4.2);
    keyLight.position.set(4.2, 6.5, 5.2);
    keyLight.castShadow = !isCompact;
    keyLight.shadow.mapSize.set(1024, 1024);
    scene.add(keyLight);
    const rimLight = new THREE.PointLight(0x9cff57, 16, 12, 2);
    rimLight.position.set(-4.4, 2.1, 1.2);
    scene.add(rimLight);
    const coolLight = new THREE.PointLight(0x66d9ff, 11, 10, 2);
    coolLight.position.set(4, -0.2, 2.5);
    scene.add(coolLight);

    const clothGeometry = new THREE.BufferGeometry();
    const positionAttribute = new THREE.BufferAttribute(simulation.positions, 3);
    positionAttribute.setUsage(THREE.DynamicDrawUsage);
    clothGeometry.setAttribute("position", positionAttribute);
    clothGeometry.setAttribute("uv", new THREE.BufferAttribute(simulation.uvs, 2));
    clothGeometry.setIndex(new THREE.BufferAttribute(simulation.indices, 1));
    clothGeometry.computeVertexNormals();
    clothGeometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(0, 0, -0.3),
      12,
    );

    const syncGeometry = () => {
      positionAttribute.needsUpdate = true;
      clothGeometry.computeVertexNormals();
    };

    const clothMaterial = new THREE.MeshPhysicalMaterial({
      color: initialPreset.color,
      roughness: initialPreset.roughness,
      metalness: 0.02,
      side: THREE.DoubleSide,
      sheen: 1,
      sheenColor: new THREE.Color(initialPreset.sheen),
      sheenRoughness: 0.38,
      clearcoat: 0.08,
      clearcoatRoughness: 0.5,
    });
    const clothMesh = new THREE.Mesh(clothGeometry, clothMaterial);
    clothMesh.castShadow = !isCompact;
    clothMesh.receiveShadow = true;
    clothMesh.frustumCulled = false;
    scene.add(clothMesh);

    const formMaterial = new THREE.MeshStandardMaterial({
      color: 0x242b2e,
      roughness: 0.42,
      metalness: 0.2,
      transparent: true,
      opacity: 0.82,
    });
    const formGroup = new THREE.Group();
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.45, 32, 24),
      formMaterial,
    );
    head.position.set(0, 2.1, -0.36);
    formGroup.add(head);
    const neck = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.24, 0.44, 24),
      formMaterial,
    );
    neck.position.set(0, 1.68, -0.35);
    formGroup.add(neck);
    const shoulders = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.4, 1.28, 10, 24),
      formMaterial,
    );
    shoulders.rotation.z = Math.PI / 2;
    shoulders.position.set(0, 1.28, -0.35);
    formGroup.add(shoulders);
    const torso = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.62, 1.15, 12, 28),
      formMaterial,
    );
    torso.position.set(0, 0.34, -0.35);
    torso.scale.set(1.04, 1, 0.72);
    formGroup.add(torso);
    scene.add(formGroup);

    const colliderMaterial = new THREE.MeshBasicMaterial({
      color: 0x9cff57,
      wireframe: true,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    });
    const colliderGroup = new THREE.Group();
    for (const collider of clothFormColliders) {
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(collider.radius, 16, 12),
        colliderMaterial,
      );
      sphere.position.set(
        collider.center[0],
        collider.center[1],
        collider.center[2],
      );
      colliderGroup.add(sphere);
    }
    colliderGroup.visible = false;
    scene.add(colliderGroup);

    const floorMaterial = new THREE.MeshStandardMaterial({
      color: 0x0b0f11,
      roughness: 0.86,
      metalness: 0.1,
      transparent: true,
      opacity: 0.72,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = clothFloorY;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(18, 36, 0x536269, 0x202a2e);
    grid.position.y = clothFloorY + 0.006;
    const gridMaterials = Array.isArray(grid.material)
      ? grid.material
      : [grid.material];
    for (const material of gridMaterials) {
      material.transparent = true;
      material.opacity = 0.28;
    }
    scene.add(grid);

    const pinGeometry = new THREE.BufferGeometry();
    const pinMaterial = new THREE.PointsMaterial({
      color: 0x6fe7ff,
      size: 0.11,
      sizeAttenuation: true,
      depthTest: false,
    });
    const pinPoints = new THREE.Points(pinGeometry, pinMaterial);
    pinPoints.renderOrder = 4;
    scene.add(pinPoints);

    const refreshPins = () => {
      pinGeometry.setAttribute(
        "position",
        new THREE.BufferAttribute(simulation.pinnedPositions, 3),
      );
      setPinCount(simulation.pinCount);
    };
    refreshPins();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const dragPlane = new THREE.Plane();
    const dragTarget = new THREE.Vector3();
    const cameraDirection = new THREE.Vector3();
    const vertexA = new THREE.Vector3();
    const vertexB = new THREE.Vector3();
    const vertexC = new THREE.Vector3();
    const barycentric = new THREE.Vector3();
    const triangle = new THREE.Triangle();
    let activePointer: number | null = null;

    const updatePointer = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      updatePointer(event);
      const hit = raycaster.intersectObject(clothMesh, false)[0];
      const pinIntent = toolRef.current === "pin" || event.shiftKey;
      if (!hit?.face) return;

      const { a, b, c } = hit.face;
      const positions = simulation.positions;
      vertexA.fromArray(positions, a * 3);
      vertexB.fromArray(positions, b * 3);
      vertexC.fromArray(positions, c * 3);
      triangle.set(vertexA, vertexB, vertexC);
      triangle.getBarycoord(hit.point, barycentric);

      if (pinIntent) {
        const weights = [barycentric.x, barycentric.y, barycentric.z];
        const vertices = [a, b, c];
        let selected = 0;
        if (weights[1] > weights[selected]) selected = 1;
        if (weights[2] > weights[selected]) selected = 2;
        simulation.togglePin(vertices[selected]);
        refreshPins();
        return;
      }

      if (toolRef.current !== "grab") return;
      activePointer = event.pointerId;
      renderer.domElement.setPointerCapture(event.pointerId);
      camera.getWorldDirection(cameraDirection);
      dragPlane.setFromNormalAndCoplanarPoint(cameraDirection, hit.point);
      simulation.beginDrag(
        [a, b, c],
        [barycentric.x, barycentric.y, barycentric.z],
        hit.point,
      );
      controls.enabled = false;
      renderer.domElement.classList.add("is-grabbing");
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (activePointer !== event.pointerId || !simulation.isDragging) return;
      updatePointer(event);
      if (raycaster.ray.intersectPlane(dragPlane, dragTarget)) {
        simulation.updateDragTarget(dragTarget);
      }
    };

    const releasePointer = (event?: PointerEvent) => {
      if (
        event &&
        activePointer !== null &&
        event.pointerId !== activePointer
      ) {
        return;
      }
      if (
        event &&
        activePointer !== null &&
        renderer.domElement.hasPointerCapture(activePointer)
      ) {
        renderer.domElement.releasePointerCapture(activePointer);
      }
      activePointer = null;
      simulation.endDrag();
      controls.enabled = true;
      renderer.domElement.classList.remove("is-grabbing");
    };

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerup", releasePointer);
    renderer.domElement.addEventListener("pointercancel", releasePointer);
    renderer.domElement.addEventListener("lostpointercapture", releasePointer);

    sceneApiRef.current = {
      reset: () => {
        simulation.reset();
        syncGeometry();
        refreshPins();
      },
      setPinPattern: (pattern) => {
        simulation.setPinPattern(pattern);
        syncGeometry();
        refreshPins();
      },
      stepOnce: () => {
        simulation.step(1 / 60, settingsRef.current);
        syncGeometry();
      },
      updateAppearance: (nextPreset, nextSettings) => {
        clothMaterial.color.set(nextPreset.color);
        clothMaterial.sheenColor.set(nextPreset.sheen);
        clothMaterial.roughness = nextPreset.roughness;
        clothMaterial.wireframe = nextSettings.wireframe;
        clothMaterial.needsUpdate = true;
        formGroup.visible = nextSettings.formVisible;
        colliderGroup.visible = nextSettings.showColliders;
      },
      cancelDrag: () => releasePointer(),
      nudgeView: (horizontal, vertical, zoom) => {
        const offset = camera.position.clone().sub(controls.target);
        const spherical = new THREE.Spherical().setFromVector3(offset);
        spherical.theta += horizontal;
        spherical.phi = THREE.MathUtils.clamp(
          spherical.phi + vertical,
          0.18,
          Math.PI * 0.87,
        );
        spherical.radius = THREE.MathUtils.clamp(
          spherical.radius * zoom,
          controls.minDistance,
          controls.maxDistance,
        );
        offset.setFromSpherical(spherical);
        camera.position.copy(controls.target).add(offset);
        camera.lookAt(controls.target);
        controls.update();
      },
      pinCenter: () => {
        pointer.set(0, 0);
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObject(clothMesh, false)[0];
        if (!hit?.face) return;
        const { a, b, c } = hit.face;
        vertexA.fromArray(simulation.positions, a * 3);
        vertexB.fromArray(simulation.positions, b * 3);
        vertexC.fromArray(simulation.positions, c * 3);
        triangle.set(vertexA, vertexB, vertexC);
        triangle.getBarycoord(hit.point, barycentric);
        const weights = [barycentric.x, barycentric.y, barycentric.z];
        const vertices = [a, b, c];
        let selected = 0;
        if (weights[1] > weights[selected]) selected = 1;
        if (weights[2] > weights[selected]) selected = 2;
        simulation.togglePin(vertices[selected]);
        refreshPins();
      },
    };

    sceneApiRef.current.updateAppearance(initialPreset, settingsRef.current);

    let animationFrame = 0;
    let lastTime = performance.now();
    let accumulator = 0;
    let fpsWindowStart = lastTime;
    let renderedFrames = 0;
    let metricsTimer = 0;

    const resize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (
        renderer.domElement.width !== Math.floor(width * renderer.getPixelRatio()) ||
        renderer.domElement.height !== Math.floor(height * renderer.getPixelRatio())
      ) {
        camera.aspect = width / Math.max(height, 1);
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      }
    };

    const renderFrame = (now: number) => {
      animationFrame = requestAnimationFrame(renderFrame);
      resize();
      const frameDelta = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      let simulated = false;
      if (!pausedRef.current) {
        accumulator += frameDelta;
        let catchUp = 0;
        while (accumulator >= 1 / 60 && catchUp < 3) {
          simulation.step(1 / 60, settingsRef.current);
          accumulator -= 1 / 60;
          catchUp += 1;
          simulated = true;
        }
        if (catchUp === 3) accumulator = 0;
      } else {
        accumulator = 0;
      }

      if (simulated) {
        syncGeometry();
      }

      controls.update();
      renderer.render(scene, camera);
      renderedFrames += 1;
      metricsTimer += frameDelta;

      if (now - fpsWindowStart >= 650) {
        const nextFps = Math.round(
          (renderedFrames * 1000) / (now - fpsWindowStart),
        );
        setFps(nextFps);
        renderedFrames = 0;
        fpsWindowStart = now;
      }

      if (metricsTimer >= 0.8) {
        setStrain(simulation.measureStrain());
        metricsTimer = 0;
      }
    };
    animationFrame = requestAnimationFrame(renderFrame);

    return () => {
      cancelAnimationFrame(animationFrame);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerup", releasePointer);
      renderer.domElement.removeEventListener("pointercancel", releasePointer);
      renderer.domElement.removeEventListener("lostpointercapture", releasePointer);
      controls.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material)
            ? object.material
            : [object.material];
          for (const material of materials) material.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
      sceneApiRef.current = null;
    };
  }, []);

  const liveSummary = useMemo(
    () =>
      `${preset.label} preset, ${settings.wind.toFixed(1)} meters per second wind, ${
        settings.selfCollision ? "self-collision on" : "self-collision off"
      }, ${pinCount} active pins, simulation ${paused ? "paused" : "running"}.`,
    [paused, pinCount, preset.label, settings.selfCollision, settings.wind],
  );

  return (
    <main className="cloth-lab">
      <div
        ref={stageRef}
        className={`simulation-stage tool-${tool}`}
        aria-label="3D cloth simulation viewport"
        aria-hidden={helpOpen ? true : undefined}
      >
        <div className="stage-vignette" aria-hidden="true" />
        <div className="stage-axis" aria-hidden="true">
          <span>Y+</span>
          <span>Z−</span>
        </div>
        <div className="stage-caption">
          <span className="eyebrow">Specimen 02 / Cape panel</span>
          <h1>Digital Draping Lab</h1>
          <p>Drape, pull, pin, and stress-test fabric in real time.</p>
        </div>
        <div className="interaction-hint" aria-hidden="true">
          <span className="hint-pulse" />
          {tool === "grab"
            ? "Drag the cloth to test its response"
            : tool === "pin"
              ? "Click the fabric to place or release a pin"
              : "Drag to orbit · scroll to zoom"}
        </div>
      </div>

      <p id="viewport-instructions" className="sr-only">
        Use O, G, and P to select orbit, grab, and pin tools. Arrow keys orbit,
        plus and minus zoom, Enter pins the fabric at the center when the pin
        tool is active, Space pauses, and R resets.
      </p>

      <header className="lab-header" aria-hidden={helpOpen ? true : undefined}>
        <a className="brand" href="#simulation" aria-label="Morrow Cloth Lab home">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          <span>
            Morrow
            <small>Cloth systems</small>
          </span>
        </a>
        <div className="header-status" aria-label="Simulation status">
          <span className={`status-dot ${paused ? "paused" : ""}`} />
          <span>{paused ? "Physics paused" : "Physics online"}</span>
          <span className="header-divider" />
          <span>{fps} FPS</span>
        </div>
        <div className="header-actions">
          <button
            ref={guideButtonRef}
            className="quiet-button"
            onClick={() => setHelpOpen(true)}
          >
            Guide
          </button>
          <button
            className="mobile-inspector-button"
            aria-expanded={inspectorOpen}
            aria-controls="fabric-inspector"
            onClick={() => setInspectorOpen((current) => !current)}
          >
            Tune fabric
          </button>
        </div>
      </header>

      <nav
        className="tool-rail"
        aria-label="Simulation tools"
        aria-hidden={helpOpen ? true : undefined}
      >
        {(
          [
            ["orbit", "01", "Orbit", "O"],
            ["grab", "02", "Grab", "G"],
            ["pin", "03", "Pin", "P"],
          ] as const
        ).map(([id, number, label, key]) => (
          <button
            key={id}
            className={tool === id ? "active" : ""}
            aria-pressed={tool === id}
            onClick={() => setTool(id)}
          >
            <span className="tool-number">{number}</span>
            <span>{label}</span>
            <kbd>{key}</kbd>
          </button>
        ))}
      </nav>

      <aside
        id="fabric-inspector"
        className={`inspector ${inspectorOpen ? "open" : ""}`}
        aria-label="Fabric inspector"
        aria-hidden={helpOpen ? true : undefined}
      >
        <div className="inspector-heading">
          <div>
            <span className="eyebrow">Material inspector</span>
            <h2>{preset.label}</h2>
          </div>
          <button
            className="inspector-close"
            aria-label="Close fabric inspector"
            onClick={() => setInspectorOpen(false)}
          >
            ×
          </button>
        </div>

        <section className="inspector-section">
          <div className="section-title">
            <h3>Fabric preset</h3>
            <span>{preset.code}</span>
          </div>
          <div className="preset-grid">
            {PRESETS.map((candidate) => (
              <button
                key={candidate.id}
                className={activePreset === candidate.id ? "active" : ""}
                aria-pressed={activePreset === candidate.id}
                onClick={() => applyPreset(candidate)}
              >
                <span
                  className="swatch"
                  style={{ backgroundColor: candidate.color }}
                  aria-hidden="true"
                />
                <span>{candidate.label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="inspector-section">
          <div className="section-title">
            <h3>Material response</h3>
            <span>Live</span>
          </div>
          <RangeControl
            label="Weight"
            value={settings.mass}
            min={0.3}
            max={2}
            step={0.01}
            unit=" kg"
            onChange={(value) => setSetting("mass", value)}
          />
          <RangeControl
            label="Stretch resistance"
            value={settings.stretch}
            min={0.72}
            max={0.998}
            step={0.001}
            displayValue={`${Math.round(settings.stretch * 100)}%`}
            onChange={(value) => setSetting("stretch", value)}
          />
          <RangeControl
            label="Bend resistance"
            value={settings.bend}
            min={0.02}
            max={0.82}
            step={0.01}
            displayValue={`${Math.round(settings.bend * 100)}%`}
            onChange={(value) => setSetting("bend", value)}
          />
          <RangeControl
            label="Air damping"
            value={settings.damping}
            min={0.982}
            max={0.999}
            step={0.001}
            displayValue={`${Math.round(settings.damping * 1000) / 10}%`}
            onChange={(value) => setSetting("damping", value)}
          />
          <RangeControl
            label="Surface friction"
            value={settings.friction}
            min={0}
            max={0.9}
            step={0.01}
            displayValue={`${Math.round(settings.friction * 100)}%`}
            onChange={(value) => setSetting("friction", value)}
          />
        </section>

        <section className="inspector-section">
          <div className="section-title">
            <h3>Environment</h3>
            <span>World</span>
          </div>
          <RangeControl
            label="Gravity"
            value={settings.gravity}
            min={0}
            max={1.5}
            step={0.01}
            unit=" g"
            onChange={(value) => setSetting("gravity", value)}
          />
          <RangeControl
            label="Wind"
            value={settings.wind}
            min={0}
            max={8}
            step={0.1}
            unit=" m/s"
            onChange={(value) => setSetting("wind", value)}
          />
          <RangeControl
            label="Turbulence"
            value={settings.turbulence}
            min={0}
            max={1}
            step={0.01}
            displayValue={`${Math.round(settings.turbulence * 100)}%`}
            onChange={(value) => setSetting("turbulence", value)}
          />
        </section>

        <section className="inspector-section">
          <div className="section-title">
            <h3>Constraints</h3>
            <span>{pinCount} pins</span>
          </div>
          <label className="select-row">
            <span>Pin pattern</span>
            <select
              value={pinPattern}
              onChange={(event) =>
                setPinPattern(event.target.value as PinPattern)
              }
            >
              {(Object.keys(PIN_LABELS) as PinPattern[]).map((id) => (
                <option key={id} value={id}>
                  {PIN_LABELS[id]}
                </option>
              ))}
            </select>
          </label>
          <Toggle
            label="Self-collision"
            checked={settings.selfCollision}
            onChange={(checked) => setSetting("selfCollision", checked)}
          />
          <Toggle
            label="Dress form"
            checked={settings.formVisible}
            onChange={(checked) => setSetting("formVisible", checked)}
          />
          <Toggle
            label="Collision volumes"
            checked={settings.showColliders}
            onChange={(checked) => setSetting("showColliders", checked)}
          />
          <Toggle
            label="Wireframe"
            checked={settings.wireframe}
            onChange={(checked) => setSetting("wireframe", checked)}
          />
        </section>
      </aside>

      <div
        className="transport"
        id="simulation"
        aria-hidden={helpOpen ? true : undefined}
      >
        <div className="transport-controls">
          <button
            className="primary-transport"
            onClick={() => setPaused((current) => !current)}
          >
            <span aria-hidden="true">{paused ? "▶" : "Ⅱ"}</span>
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            className="transport-button"
            disabled={!paused}
            onClick={() => sceneApiRef.current?.stepOnce()}
          >
            Step
          </button>
          <button className="transport-button" onClick={reset}>
            Reset
          </button>
        </div>
        <div className="strain-meter">
          <div className="strain-label">
            <span>Live strain</span>
            <span>{Math.min(99, Math.round(strain.max * 100))}% peak</span>
          </div>
          <div className="strain-track" aria-hidden="true">
            <span
              style={{
                width: `${Math.min(100, Math.max(2, strain.average * 520))}%`,
              }}
            />
          </div>
        </div>
        <div className="solver-readout">
          <span>PBD / {quality}</span>
          <span>3 substeps · 6 passes</span>
        </div>
      </div>

      {helpOpen && (
        <div
          className="help-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setHelpOpen(false);
          }}
        >
          <section
            ref={helpCardRef}
            className="help-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="guide-title"
          >
            <button
              className="help-close"
              aria-label="Close guide"
              onClick={() => setHelpOpen(false)}
            >
              ×
            </button>
            <span className="eyebrow">Interaction guide</span>
            <h2 id="guide-title">Treat it like fabric.</h2>
            <p>
              The cape is solved in real time. Forces and constraints are
              recalculated every frame—nothing here is pre-animated.
            </p>
            <div className="guide-grid">
              <article>
                <span>01</span>
                <h3>Orbit</h3>
                <p>Drag empty space to rotate. Scroll or pinch to move closer.</p>
              </article>
              <article>
                <span>02</span>
                <h3>Grab</h3>
                <p>Pull any point on the fabric. Release it to continue the solve.</p>
              </article>
              <article>
                <span>03</span>
                <h3>Pin</h3>
                <p>Click to hold or release a vertex. Shift-click works in any tool.</p>
              </article>
            </div>
            <div className="keyboard-line">
              <span>
                <kbd>Space</kbd> pause
              </span>
              <span>
                <kbd>R</kbd> reset
              </span>
              <span>
                <kbd>G</kbd> grab
              </span>
              <span>
                <kbd>P</kbd> pin
              </span>
            </div>
          </section>
        </div>
      )}

      <p className="sr-only" aria-live="polite">
        {liveSummary}
      </p>
    </main>
  );
}
