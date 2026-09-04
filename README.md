# Outline Globe Sandbox

A zero-build Three.js playground centered on a wireframe/outline globe.

## Run

```sh
npm run dev
```

Then open http://localhost:5173. Any static file server works — there is no
build step; Three.js and lil-gui load from a CDN via an import map in
`index.html`.

## Structure

- `index.html` — import map + canvas host
- `main.js` — scene, outline globe, orbit controls, GUI

## Experiment ideas

- Plot lat/lon points on the surface (`Vector3` from spherical coords)
- Great-circle arcs between two points (`THREE.CatmullRomCurve3` or slerp)
- Swap `LineBasicMaterial` for `Line2`/`LineMaterial` (in `three/addons/`)
  to get thick lines
- Add landmass outlines from GeoJSON
