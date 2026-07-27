# Morrow Digital Draping Lab

An interactive browser-based 3D cloth simulation built with React, Three.js,
and a custom position-based dynamics solver.

The simulated cape uses a typed-array particle grid with structural, shear, and
bend constraints. It supports triangle-pressure wind, gravity, dress-form and
floor collisions, particle self-collision, multiple pin patterns, barycentric
fabric grabbing, and destructive tearing.

## Tearing

Fabric fails in two ways:

- **Under stress.** Every structural and shear constraint has a breaking
  elongation. Once a thread stretches past it the constraint is severed, load
  redistributes to its neighbours, and the rip propagates on its own. Diagonals
  tolerate more strain than the grain, so tears tend to run along the weave.
- **By hand.** The tear tool (`T`) cuts every thread inside a small sphere as
  you drag across the surface.

Severed threads drop the triangles they bounded, so holes open in the mesh and
detached pieces fall away independently. Bend springs spanning a cut are
released with it. Breaking elongation is per-fabric — silk goes at 16 percent,
leather holds to 66 — and is adjustable live, along with a readout of how much
of the weave is still intact. Reset restores the cloth.

## Run locally

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

Then open the local URL printed by the development server.

## Validation

```bash
npm run build
npm test
```

The interface includes desktop and mobile layouts, keyboard controls, four
material presets, live strain and integrity feedback, wireframe and collider
views, and adjustable material, tear, and environment parameters.
