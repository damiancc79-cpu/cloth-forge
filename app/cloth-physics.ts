import * as THREE from "three";

export type PinPattern = "shoulders" | "rail" | "single" | "free";

export type ClothSettings = {
  mass: number;
  gravity: number;
  wind: number;
  turbulence: number;
  stretch: number;
  bend: number;
  damping: number;
  friction: number;
  selfCollision: boolean;
  tearEnabled: boolean;
  tearStrain: number;
};

type SphereCollider = {
  center: [number, number, number];
  radius: number;
};

type DragConstraint = {
  indices: [number, number, number];
  weights: [number, number, number];
  target: THREE.Vector3;
};

const FLOOR_Y = -2.2;
const CLOTH_THICKNESS = 0.045;
const FIXED_SUBSTEPS = 3;
const SOLVER_ITERATIONS = 6;

// Diagonals carry less of the load than the grain, so they are allowed to
// stretch further before failing. Tears then run along the weave instead of
// shattering the quad into loose triangles.
const SHEAR_TEAR_TOLERANCE = 1.35;

const FORM_COLLIDERS: SphereCollider[] = [
  { center: [0, 2.1, -0.36], radius: 0.47 },
  { center: [0, 1.63, -0.35], radius: 0.24 },
  { center: [-0.62, 1.3, -0.34], radius: 0.66 },
  { center: [0.62, 1.3, -0.34], radius: 0.66 },
  { center: [0, 0.78, -0.34], radius: 0.76 },
  { center: [0, 0.16, -0.34], radius: 0.68 },
  { center: [0, -0.42, -0.34], radius: 0.56 },
];

export const clothFloorY = FLOOR_Y;
export const clothFormColliders = FORM_COLLIDERS;

export class ClothSimulation {
  readonly cols: number;
  readonly rows: number;
  readonly count: number;
  readonly positions: Float32Array;
  readonly previous: Float32Array;
  readonly initial: Float32Array;
  readonly invMass: Float32Array;
  readonly pinned: Uint8Array;
  readonly anchors: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;

  private readonly constraintA: Uint32Array;
  private readonly constraintB: Uint32Array;
  private readonly constraintRest: Float32Array;
  private readonly constraintType: Uint8Array;
  private readonly constraintBroken: Uint8Array;
  private readonly acceleration: Float32Array;
  private readonly customPins = new Set<number>();

  /** Pristine triangle list. `indices` holds the surviving subset, compacted. */
  private readonly baseIndices: Uint32Array;
  /** Constraint index for each of a triangle's three bounding edges. */
  private readonly triangleEdges: Int32Array;
  /** `min(i,j) * count + max(i,j)` to constraint index. */
  private readonly edgeLookup = new Map<number, number>();
  private readonly weaveTotal: number;

  private activeIndices = 0;
  private brokenWeave = 0;
  private topology = 0;
  private pinPattern: PinPattern = "shoulders";
  private drag: DragConstraint | null = null;
  private elapsed = 0;
  private frame = 0;
  private currentMass = 1;

  constructor(cols = 35, rows = 29) {
    this.cols = cols;
    this.rows = rows;
    this.count = cols * rows;
    this.positions = new Float32Array(this.count * 3);
    this.previous = new Float32Array(this.count * 3);
    this.initial = new Float32Array(this.count * 3);
    this.invMass = new Float32Array(this.count);
    this.pinned = new Uint8Array(this.count);
    this.anchors = new Float32Array(this.count * 3);
    this.uvs = new Float32Array(this.count * 2);
    this.acceleration = new Float32Array(this.count * 3);

    this.buildInitialCape();
    this.baseIndices = this.buildTriangles();
    this.indices = new Uint32Array(this.baseIndices);

    const constraints = this.buildConstraints();
    this.constraintA = constraints.a;
    this.constraintB = constraints.b;
    this.constraintRest = constraints.rest;
    this.constraintType = constraints.type;
    this.constraintBroken = new Uint8Array(this.constraintA.length);

    let weave = 0;
    for (let c = 0; c < this.constraintType.length; c += 1) {
      if (this.constraintType[c] !== 2) weave += 1;
    }
    this.weaveTotal = weave;

    this.triangleEdges = this.buildTriangleEdges();
    this.rebuildTopology();

    this.setMass(1);
    this.setPinPattern("shoulders");
  }

  private buildInitialCape() {
    for (let row = 0; row < this.rows; row += 1) {
      const v = row / (this.rows - 1);
      const capeWidth = THREE.MathUtils.lerp(2.25, 4.35, Math.pow(v, 0.78));
      const y = 2.48 - v * 4.05;

      for (let col = 0; col < this.cols; col += 1) {
        const u = col / (this.cols - 1);
        const index = row * this.cols + col;
        const p = index * 3;
        const uv = index * 2;
        const x = (u - 0.5) * capeWidth;
        const z =
          0.28 +
          0.11 * Math.sin(v * Math.PI) -
          0.08 * Math.cos((u - 0.5) * Math.PI * 2) * v;

        this.positions[p] = x;
        this.positions[p + 1] = y;
        this.positions[p + 2] = z;
        this.previous[p] = x;
        this.previous[p + 1] = y;
        this.previous[p + 2] = z;
        this.initial[p] = x;
        this.initial[p + 1] = y;
        this.initial[p + 2] = z;
        this.anchors[p] = x;
        this.anchors[p + 1] = y;
        this.anchors[p + 2] = z;
        this.uvs[uv] = u;
        this.uvs[uv + 1] = 1 - v;
      }
    }
  }

  private buildTriangles() {
    const values: number[] = [];
    for (let row = 0; row < this.rows - 1; row += 1) {
      for (let col = 0; col < this.cols - 1; col += 1) {
        const a = row * this.cols + col;
        const b = a + 1;
        const c = a + this.cols;
        const d = c + 1;
        values.push(a, c, b, b, c, d);
      }
    }
    return new Uint32Array(values);
  }

  private buildConstraints() {
    const a: number[] = [];
    const b: number[] = [];
    const rest: number[] = [];
    const type: number[] = [];

    const add = (i: number, j: number, kind: number) => {
      const ia = i * 3;
      const ib = j * 3;
      const dx = this.initial[ib] - this.initial[ia];
      const dy = this.initial[ib + 1] - this.initial[ia + 1];
      const dz = this.initial[ib + 2] - this.initial[ia + 2];
      this.edgeLookup.set(this.edgeKey(i, j), a.length);
      a.push(i);
      b.push(j);
      rest.push(Math.hypot(dx, dy, dz));
      type.push(kind);
    };

    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const i = row * this.cols + col;
        if (col + 1 < this.cols) add(i, i + 1, 0);
        if (row + 1 < this.rows) add(i, i + this.cols, 0);
        if (col + 1 < this.cols && row + 1 < this.rows) {
          add(i, i + this.cols + 1, 1);
          add(i + 1, i + this.cols, 1);
        }
        if (col + 2 < this.cols) add(i, i + 2, 2);
        if (row + 2 < this.rows) add(i, i + this.cols * 2, 2);
      }
    }

    return {
      a: new Uint32Array(a),
      b: new Uint32Array(b),
      rest: new Float32Array(rest),
      type: new Uint8Array(type),
    };
  }

  private edgeKey(i: number, j: number) {
    return i < j ? i * this.count + j : j * this.count + i;
  }

  private buildTriangleEdges() {
    const triangles = this.baseIndices.length / 3;
    const edges = new Int32Array(triangles * 3);
    for (let t = 0; t < triangles; t += 1) {
      const i0 = this.baseIndices[t * 3];
      const i1 = this.baseIndices[t * 3 + 1];
      const i2 = this.baseIndices[t * 3 + 2];
      edges[t * 3] = this.edgeLookup.get(this.edgeKey(i0, i1)) ?? -1;
      edges[t * 3 + 1] = this.edgeLookup.get(this.edgeKey(i1, i2)) ?? -1;
      edges[t * 3 + 2] = this.edgeLookup.get(this.edgeKey(i2, i0)) ?? -1;
    }
    return edges;
  }

  private isEdgeSevered(i: number, j: number) {
    const edge = this.edgeLookup.get(this.edgeKey(i, j));
    return edge === undefined || this.constraintBroken[edge] === 1;
  }

  private breakConstraint(c: number) {
    if (this.constraintBroken[c]) return false;
    this.constraintBroken[c] = 1;
    if (this.constraintType[c] !== 2) this.brokenWeave += 1;
    return true;
  }

  /**
   * Drops every triangle that lost a bounding edge and compacts the survivors
   * to the front of the index buffer.
   */
  private rebuildTopology() {
    // A bend spring spans two grain edges. Once either is severed the fabric
    // between its endpoints is gone, so the spring must stop holding the two
    // sides of the rip together.
    for (let c = 0; c < this.constraintType.length; c += 1) {
      if (this.constraintType[c] !== 2 || this.constraintBroken[c]) continue;
      const i = this.constraintA[c];
      const j = this.constraintB[c];
      const mid = j - i === 2 ? i + 1 : i + this.cols;
      if (this.isEdgeSevered(i, mid) || this.isEdgeSevered(mid, j)) {
        this.constraintBroken[c] = 1;
      }
    }

    let cursor = 0;
    const triangles = this.baseIndices.length / 3;
    for (let t = 0; t < triangles; t += 1) {
      const e0 = this.triangleEdges[t * 3];
      const e1 = this.triangleEdges[t * 3 + 1];
      const e2 = this.triangleEdges[t * 3 + 2];
      if (
        (e0 >= 0 && this.constraintBroken[e0]) ||
        (e1 >= 0 && this.constraintBroken[e1]) ||
        (e2 >= 0 && this.constraintBroken[e2])
      ) {
        continue;
      }
      this.indices[cursor] = this.baseIndices[t * 3];
      this.indices[cursor + 1] = this.baseIndices[t * 3 + 1];
      this.indices[cursor + 2] = this.baseIndices[t * 3 + 2];
      cursor += 3;
    }

    // three.js computes vertex normals over the entire index buffer rather
    // than the draw range, so the tail is filled with degenerate triangles —
    // they render nothing and contribute no normal.
    this.indices.fill(0, cursor);
    this.activeIndices = cursor;
    this.topology += 1;
  }

  private applyTearing(threshold: number) {
    let severed = false;
    for (let c = 0; c < this.constraintA.length; c += 1) {
      const kind = this.constraintType[c];
      // Bend springs sit far from rest by design; they fail with their grain.
      if (kind === 2 || this.constraintBroken[c]) continue;
      const a = this.constraintA[c] * 3;
      const b = this.constraintB[c] * 3;
      const dx = this.positions[b] - this.positions[a];
      const dy = this.positions[b + 1] - this.positions[a + 1];
      const dz = this.positions[b + 2] - this.positions[a + 2];
      const limit = kind === 1 ? threshold * SHEAR_TEAR_TOLERANCE : threshold;
      if (Math.hypot(dx, dy, dz) / this.constraintRest[c] - 1 <= limit) continue;
      if (this.breakConstraint(c)) severed = true;
    }
    if (severed) this.rebuildTopology();
  }

  /** Cuts the weave inside a world-space sphere. Returns true if anything gave. */
  tearAt(point: THREE.Vector3, radius: number) {
    const radiusSq = radius * radius;
    let severed = false;
    for (let c = 0; c < this.constraintA.length; c += 1) {
      if (this.constraintType[c] === 2 || this.constraintBroken[c]) continue;
      const a = this.constraintA[c] * 3;
      const b = this.constraintB[c] * 3;
      const dx = (this.positions[a] + this.positions[b]) * 0.5 - point.x;
      const dy = (this.positions[a + 1] + this.positions[b + 1]) * 0.5 - point.y;
      const dz = (this.positions[a + 2] + this.positions[b + 2]) * 0.5 - point.z;
      if (dx * dx + dy * dy + dz * dz > radiusSq) continue;
      if (this.breakConstraint(c)) severed = true;
    }
    if (severed) this.rebuildTopology();
    return severed;
  }

  /** Number of index entries currently in use; feed to `setDrawRange`. */
  get activeIndexCount() {
    return this.activeIndices;
  }

  /** Increments whenever triangles are dropped, so renderers can resync. */
  get topologyVersion() {
    return this.topology;
  }

  /** Share of the structural and shear weave still intact, 0 to 1. */
  get integrity() {
    return this.weaveTotal ? 1 - this.brokenWeave / this.weaveTotal : 1;
  }

  setMass(mass: number) {
    this.currentMass = Math.max(0.12, mass);
    const value = 1 / this.currentMass;
    for (let i = 0; i < this.count; i += 1) {
      this.invMass[i] = this.pinned[i] ? 0 : value;
    }
  }

  setPinPattern(pattern: PinPattern) {
    this.pinPattern = pattern;
    this.customPins.clear();
    this.pinned.fill(0);

    const pinInitial = (index: number) => {
      this.pinned[index] = 1;
      const p = index * 3;
      this.anchors[p] = this.initial[p];
      this.anchors[p + 1] = this.initial[p + 1];
      this.anchors[p + 2] = this.initial[p + 2];
    };

    if (pattern === "shoulders") {
      pinInitial(2);
      pinInitial(this.cols - 3);
    } else if (pattern === "rail") {
      for (let col = 0; col < this.cols; col += 2) pinInitial(col);
      pinInitial(this.cols - 1);
    } else if (pattern === "single") {
      pinInitial(Math.floor(this.cols / 2));
    }

    this.setMass(this.currentMass);
    this.applyPins();
  }

  togglePin(index: number) {
    if (index < 0 || index >= this.count) return;
    const p = index * 3;

    if (this.pinned[index]) {
      this.pinned[index] = 0;
      this.customPins.delete(index);
      this.invMass[index] = 1 / this.currentMass;
      return;
    }

    this.pinned[index] = 1;
    this.customPins.add(index);
    this.invMass[index] = 0;
    this.anchors[p] = this.positions[p];
    this.anchors[p + 1] = this.positions[p + 1];
    this.anchors[p + 2] = this.positions[p + 2];
    this.previous[p] = this.positions[p];
    this.previous[p + 1] = this.positions[p + 1];
    this.previous[p + 2] = this.positions[p + 2];
  }

  reset() {
    this.positions.set(this.initial);
    this.previous.set(this.initial);
    this.drag = null;
    this.elapsed = 0;
    this.constraintBroken.fill(0);
    this.brokenWeave = 0;
    this.rebuildTopology();
    this.setPinPattern(this.pinPattern);
  }

  beginDrag(
    indices: [number, number, number],
    weights: [number, number, number],
    target: THREE.Vector3,
  ) {
    this.drag = {
      indices,
      weights,
      target: target.clone(),
    };
  }

  updateDragTarget(target: THREE.Vector3) {
    if (!this.drag) return;
    const delta = target.clone().sub(this.drag.target);
    const maxMove = 0.45;
    if (delta.lengthSq() > maxMove * maxMove) {
      delta.setLength(maxMove);
      this.drag.target.add(delta);
    } else {
      this.drag.target.copy(target);
    }
  }

  endDrag() {
    this.drag = null;
  }

  get isDragging() {
    return this.drag !== null;
  }

  get pinCount() {
    let total = 0;
    for (let i = 0; i < this.count; i += 1) total += this.pinned[i];
    return total;
  }

  get pinnedPositions() {
    const values = new Float32Array(this.pinCount * 3);
    let cursor = 0;
    for (let i = 0; i < this.count; i += 1) {
      if (!this.pinned[i]) continue;
      const p = i * 3;
      values[cursor] = this.positions[p];
      values[cursor + 1] = this.positions[p + 1];
      values[cursor + 2] = this.positions[p + 2];
      cursor += 3;
    }
    return values;
  }

  step(dt: number, settings: ClothSettings) {
    if (Math.abs(settings.mass - this.currentMass) > 0.0001) {
      this.setMass(settings.mass);
    }

    const subDt = dt / FIXED_SUBSTEPS;
    this.elapsed += dt;

    for (let substep = 0; substep < FIXED_SUBSTEPS; substep += 1) {
      this.computeWind(settings, subDt);
      this.integrate(settings, subDt);

      const structural = this.perPassStiffness(settings.stretch);
      const shear = this.perPassStiffness(settings.stretch * 0.86);
      const bend = this.perPassStiffness(settings.bend);

      for (let iteration = 0; iteration < SOLVER_ITERATIONS; iteration += 1) {
        this.solveDistanceConstraints(structural, shear, bend);
        this.solveGrab();
        this.solveFormCollisions(settings.friction);
        this.solveFloorCollision(settings.friction);
        this.applyPins();
      }

      if (settings.selfCollision) {
        this.solveSelfCollisions();
        this.solveFormCollisions(settings.friction);
        this.solveFloorCollision(settings.friction);
        this.applyPins();
      }
    }

    if (settings.tearEnabled) {
      this.applyTearing(Math.max(0.02, settings.tearStrain));
    }

    this.frame += 1;
    if (this.frame % 120 === 0 && !this.isFinite()) this.reset();
  }

  measureStrain() {
    let total = 0;
    let max = 0;
    let samples = 0;
    for (let c = 0; c < this.constraintA.length; c += 1) {
      if (this.constraintType[c] === 2 || this.constraintBroken[c]) continue;
      const a = this.constraintA[c] * 3;
      const b = this.constraintB[c] * 3;
      const dx = this.positions[b] - this.positions[a];
      const dy = this.positions[b + 1] - this.positions[a + 1];
      const dz = this.positions[b + 2] - this.positions[a + 2];
      const value = Math.abs(Math.hypot(dx, dy, dz) / this.constraintRest[c] - 1);
      total += value;
      max = Math.max(max, value);
      samples += 1;
    }
    return {
      average: samples ? total / samples : 0,
      max,
    };
  }

  private perPassStiffness(value: number) {
    const desired = THREE.MathUtils.clamp(value, 0.001, 0.9999);
    return 1 - Math.pow(1 - desired, 1 / SOLVER_ITERATIONS);
  }

  private computeWind(settings: ClothSettings, dt: number) {
    this.acceleration.fill(0);
    if (settings.wind <= 0.001) return;

    const gust =
      1 +
      settings.turbulence *
        (0.34 * Math.sin(this.elapsed * 1.7) +
          0.22 * Math.sin(this.elapsed * 3.1 + 1.2) +
          0.13 * Math.sin(this.elapsed * 6.3 + 0.4));
    const windX = settings.wind * 0.2 * Math.sin(this.elapsed * 0.72) * gust;
    const windY = settings.wind * 0.07 * Math.sin(this.elapsed * 0.41 + 0.8) * gust;
    const windZ = -settings.wind * gust;
    const invDt = 1 / Math.max(dt, 0.00001);
    const dragCoefficient = 1.7;

    for (let t = 0; t < this.indices.length; t += 3) {
      const ia = this.indices[t] * 3;
      const ib = this.indices[t + 1] * 3;
      const ic = this.indices[t + 2] * 3;

      const abx = this.positions[ib] - this.positions[ia];
      const aby = this.positions[ib + 1] - this.positions[ia + 1];
      const abz = this.positions[ib + 2] - this.positions[ia + 2];
      const acx = this.positions[ic] - this.positions[ia];
      const acy = this.positions[ic + 1] - this.positions[ia + 1];
      const acz = this.positions[ic + 2] - this.positions[ia + 2];
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      const doubleArea = Math.hypot(nx, ny, nz);
      if (doubleArea < 0.000001) continue;

      const normalX = nx / doubleArea;
      const normalY = ny / doubleArea;
      const normalZ = nz / doubleArea;
      const velocityX =
        ((this.positions[ia] - this.previous[ia]) +
          (this.positions[ib] - this.previous[ib]) +
          (this.positions[ic] - this.previous[ic])) *
        (invDt / 3);
      const velocityY =
        ((this.positions[ia + 1] - this.previous[ia + 1]) +
          (this.positions[ib + 1] - this.previous[ib + 1]) +
          (this.positions[ic + 1] - this.previous[ic + 1])) *
        (invDt / 3);
      const velocityZ =
        ((this.positions[ia + 2] - this.previous[ia + 2]) +
          (this.positions[ib + 2] - this.previous[ib + 2]) +
          (this.positions[ic + 2] - this.previous[ic + 2])) *
        (invDt / 3);
      const relativeX = windX - velocityX;
      const relativeY = windY - velocityY;
      const relativeZ = windZ - velocityZ;
      const pressure =
        relativeX * normalX + relativeY * normalY + relativeZ * normalZ;
      const area = doubleArea * 0.5;
      const force = dragCoefficient * pressure * Math.abs(pressure) * area;
      const fx = normalX * force;
      const fy = normalY * force;
      const fz = normalZ * force;

      const scaleA = this.invMass[ia / 3] / 3;
      const scaleB = this.invMass[ib / 3] / 3;
      const scaleC = this.invMass[ic / 3] / 3;
      this.acceleration[ia] += fx * scaleA;
      this.acceleration[ia + 1] += fy * scaleA;
      this.acceleration[ia + 2] += fz * scaleA;
      this.acceleration[ib] += fx * scaleB;
      this.acceleration[ib + 1] += fy * scaleB;
      this.acceleration[ib + 2] += fz * scaleB;
      this.acceleration[ic] += fx * scaleC;
      this.acceleration[ic + 1] += fy * scaleC;
      this.acceleration[ic + 2] += fz * scaleC;
    }
  }

  private integrate(settings: ClothSettings, dt: number) {
    const dtSq = dt * dt;
    const damping = Math.pow(
      THREE.MathUtils.clamp(settings.damping, 0.9, 0.9999),
      dt / (1 / 60),
    );
    const gravity = -9.81 * settings.gravity;

    for (let i = 0; i < this.count; i += 1) {
      if (this.invMass[i] === 0) continue;
      const p = i * 3;
      const x = this.positions[p];
      const y = this.positions[p + 1];
      const z = this.positions[p + 2];
      const vx = (x - this.previous[p]) * damping;
      const vy = (y - this.previous[p + 1]) * damping;
      const vz = (z - this.previous[p + 2]) * damping;
      this.previous[p] = x;
      this.previous[p + 1] = y;
      this.previous[p + 2] = z;

      const ax = THREE.MathUtils.clamp(this.acceleration[p], -42, 42);
      const ay = THREE.MathUtils.clamp(this.acceleration[p + 1] + gravity, -42, 42);
      const az = THREE.MathUtils.clamp(this.acceleration[p + 2], -42, 42);
      this.positions[p] = x + vx + ax * dtSq;
      this.positions[p + 1] = y + vy + ay * dtSq;
      this.positions[p + 2] = z + vz + az * dtSq;
    }
  }

  private solveDistanceConstraints(
    structuralStiffness: number,
    shearStiffness: number,
    bendStiffness: number,
  ) {
    for (let c = 0; c < this.constraintA.length; c += 1) {
      if (this.constraintBroken[c]) continue;
      const i = this.constraintA[c];
      const j = this.constraintB[c];
      const wi = this.invMass[i];
      const wj = this.invMass[j];
      const weight = wi + wj;
      if (weight <= 0) continue;

      const a = i * 3;
      const b = j * 3;
      const dx = this.positions[b] - this.positions[a];
      const dy = this.positions[b + 1] - this.positions[a + 1];
      const dz = this.positions[b + 2] - this.positions[a + 2];
      const distance = Math.hypot(dx, dy, dz);
      if (distance < 0.000001) continue;

      const kind = this.constraintType[c];
      const stiffness =
        kind === 0
          ? structuralStiffness
          : kind === 1
            ? shearStiffness
            : bendStiffness;
      const correction =
        ((distance - this.constraintRest[c]) / distance) * (stiffness / weight);
      const cx = dx * correction;
      const cy = dy * correction;
      const cz = dz * correction;

      if (wi > 0) {
        this.positions[a] += cx * wi;
        this.positions[a + 1] += cy * wi;
        this.positions[a + 2] += cz * wi;
      }
      if (wj > 0) {
        this.positions[b] -= cx * wj;
        this.positions[b + 1] -= cy * wj;
        this.positions[b + 2] -= cz * wj;
      }
    }
  }

  private solveGrab() {
    if (!this.drag) return;
    const { indices, weights, target } = this.drag;
    let qx = 0;
    let qy = 0;
    let qz = 0;
    let denominator = 0;
    let movableWeight = 0;

    for (let n = 0; n < 3; n += 1) {
      const index = indices[n];
      const weight = weights[n];
      const p = index * 3;
      qx += this.positions[p] * weight;
      qy += this.positions[p + 1] * weight;
      qz += this.positions[p + 2] * weight;
      denominator += this.invMass[index] * weight * weight;
      if (this.invMass[index] > 0) movableWeight += weight;
    }

    if (denominator < 0.000001 || movableWeight < 0.025) return;
    const dx = target.x - qx;
    const dy = target.y - qy;
    const dz = target.z - qz;
    const maxCorrection = 0.085;

    for (let n = 0; n < 3; n += 1) {
      const index = indices[n];
      const scale = (this.invMass[index] * weights[n]) / denominator;
      if (scale <= 0) continue;
      const p = index * 3;
      let moveX = dx * scale;
      let moveY = dy * scale;
      let moveZ = dz * scale;
      const moveLength = Math.hypot(moveX, moveY, moveZ);
      if (moveLength > maxCorrection) {
        const clamp = maxCorrection / moveLength;
        moveX *= clamp;
        moveY *= clamp;
        moveZ *= clamp;
      }
      this.positions[p] += moveX;
      this.positions[p + 1] += moveY;
      this.positions[p + 2] += moveZ;
    }
  }

  private solveFormCollisions(friction: number) {
    for (let i = 0; i < this.count; i += 1) {
      if (this.invMass[i] === 0) continue;
      const p = i * 3;

      for (const collider of FORM_COLLIDERS) {
        const dx = this.positions[p] - collider.center[0];
        const dy = this.positions[p + 1] - collider.center[1];
        const dz = this.positions[p + 2] - collider.center[2];
        const distance = Math.hypot(dx, dy, dz);
        const target = collider.radius + CLOTH_THICKNESS;
        if (distance >= target) continue;

        const inverse = distance > 0.000001 ? 1 / distance : 0;
        const nx = distance > 0.000001 ? dx * inverse : 0;
        const ny = distance > 0.000001 ? dy * inverse : 0;
        const nz = distance > 0.000001 ? dz * inverse : 1;
        const penetration = target - distance;
        const cx = nx * penetration;
        const cy = ny * penetration;
        const cz = nz * penetration;
        this.positions[p] += cx;
        this.positions[p + 1] += cy;
        this.positions[p + 2] += cz;
        this.previous[p] += cx;
        this.previous[p + 1] += cy;
        this.previous[p + 2] += cz;

        const vx = this.positions[p] - this.previous[p];
        const vy = this.positions[p + 1] - this.previous[p + 1];
        const vz = this.positions[p + 2] - this.previous[p + 2];
        const normalVelocity = vx * nx + vy * ny + vz * nz;
        const tangentScale = THREE.MathUtils.clamp(friction * 0.08, 0, 0.15);
        this.previous[p] +=
          nx * Math.min(0, normalVelocity) + (vx - nx * normalVelocity) * tangentScale;
        this.previous[p + 1] +=
          ny * Math.min(0, normalVelocity) + (vy - ny * normalVelocity) * tangentScale;
        this.previous[p + 2] +=
          nz * Math.min(0, normalVelocity) + (vz - nz * normalVelocity) * tangentScale;
      }
    }
  }

  private solveFloorCollision(friction: number) {
    const floor = FLOOR_Y + CLOTH_THICKNESS;
    const tangentScale = THREE.MathUtils.clamp(friction * 0.12, 0, 0.2);
    for (let i = 0; i < this.count; i += 1) {
      if (this.invMass[i] === 0) continue;
      const p = i * 3;
      if (this.positions[p + 1] >= floor) continue;
      this.positions[p + 1] = floor;
      this.previous[p + 1] = floor;
      this.previous[p] += (this.positions[p] - this.previous[p]) * tangentScale;
      this.previous[p + 2] +=
        (this.positions[p + 2] - this.previous[p + 2]) * tangentScale;
    }
  }

  private solveSelfCollisions() {
    const separation = CLOTH_THICKNESS * 1.8;
    const separationSq = separation * separation;
    const cellSize = separation * 1.15;
    const buckets = new Map<number, number[]>();
    const hash = (x: number, y: number, z: number) =>
      (x + 512) * 1_048_576 + (y + 512) * 1_024 + (z + 512);

    for (let i = 0; i < this.count; i += 1) {
      const p = i * 3;
      const cellX = Math.floor(this.positions[p] / cellSize);
      const cellY = Math.floor(this.positions[p + 1] / cellSize);
      const cellZ = Math.floor(this.positions[p + 2] / cellSize);
      const rowI = Math.floor(i / this.cols);
      const colI = i % this.cols;

      for (let x = cellX - 1; x <= cellX + 1; x += 1) {
        for (let y = cellY - 1; y <= cellY + 1; y += 1) {
          for (let z = cellZ - 1; z <= cellZ + 1; z += 1) {
            const candidates = buckets.get(hash(x, y, z));
            if (!candidates) continue;

            for (const j of candidates) {
              const rowJ = Math.floor(j / this.cols);
              const colJ = j % this.cols;
              if (Math.abs(rowI - rowJ) <= 2 && Math.abs(colI - colJ) <= 2) {
                continue;
              }

              const q = j * 3;
              const dx = this.positions[p] - this.positions[q];
              const dy = this.positions[p + 1] - this.positions[q + 1];
              const dz = this.positions[p + 2] - this.positions[q + 2];
              const distanceSq = dx * dx + dy * dy + dz * dz;
              if (distanceSq >= separationSq || distanceSq < 0.0000001) continue;

              const wi = this.invMass[i];
              const wj = this.invMass[j];
              const weight = wi + wj;
              if (weight <= 0) continue;
              const distance = Math.sqrt(distanceSq);
              const correction = (separation - distance) / (distance * weight);
              const cx = dx * correction;
              const cy = dy * correction;
              const cz = dz * correction;
              if (wi > 0) {
                this.positions[p] += cx * wi;
                this.positions[p + 1] += cy * wi;
                this.positions[p + 2] += cz * wi;
                this.previous[p] += cx * wi;
                this.previous[p + 1] += cy * wi;
                this.previous[p + 2] += cz * wi;
              }
              if (wj > 0) {
                this.positions[q] -= cx * wj;
                this.positions[q + 1] -= cy * wj;
                this.positions[q + 2] -= cz * wj;
                this.previous[q] -= cx * wj;
                this.previous[q + 1] -= cy * wj;
                this.previous[q + 2] -= cz * wj;
              }
            }
          }
        }
      }

      const key = hash(cellX, cellY, cellZ);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(i);
      else buckets.set(key, [i]);
    }
  }

  private applyPins() {
    for (let i = 0; i < this.count; i += 1) {
      if (!this.pinned[i]) continue;
      const p = i * 3;
      this.positions[p] = this.anchors[p];
      this.positions[p + 1] = this.anchors[p + 1];
      this.positions[p + 2] = this.anchors[p + 2];
      this.previous[p] = this.anchors[p];
      this.previous[p + 1] = this.anchors[p + 1];
      this.previous[p + 2] = this.anchors[p + 2];
    }
  }

  private isFinite() {
    for (let i = 0; i < this.positions.length; i += 1) {
      const value = this.positions[i];
      if (!Number.isFinite(value) || Math.abs(value) > 80) return false;
    }
    return true;
  }
}
