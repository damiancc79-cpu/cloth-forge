# Morrow Digital Draping Lab

An interactive browser-based 3D cloth simulation built with React, Three.js,
and a custom position-based dynamics solver.

The simulated cape uses a typed-array particle grid with structural, shear, and
bend constraints. It supports triangle-pressure wind, gravity, dress-form and
floor collisions, particle self-collision, multiple pin patterns, and
barycentric fabric grabbing.

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
material presets, live strain feedback, wireframe and collider views, and
adjustable material and environment parameters.
