# Local patches to maplibre-gl

pnpm applies `patches/maplibre-gl.patch` on every install (`pnpm.patchedDependencies` in
package.json), so the checked-out tree always runs the patched renderer. Each patch here
mirrors an upstream report; once a maplibre release ships the fix, bump the dependency
and delete the patch. The patch edits both shipped bundles — the readable
`maplibre-gl-dev.mjs` hunk is the reviewable part, the minified `maplibre-gl.mjs` hunk
is the same change in the bundle Vite actually serves.

## Stale drape textures after a zoom animation

With terrain on, every draped layer — the contour lines this was found with, but equally
the basemap's roads and buildings — is baked into per-terrain-tile textures that were
only invalidated when their source tiles changed, never when the zoom they were
evaluated at went stale. After an animated zoom the map keeps mid-animation styling
until an unrelated repaint.

The patch mirrors the upstream PR's current shape: the bake zoom becomes part of each
texture's RTT fingerprint (an `RTTFingerprint` value class replacing the fingerprint
string). While zoom is changing, a texture whose fingerprint differs only in zoom is
kept and `needsFollowUpFrame` makes the render loop schedule the one frame a finished
animation never schedules on its own — which also defers `idle` until after that
corrective re-render. Once zoom has settled, the stale texture is released and re-baked.
Oracle: `node scripts/probe-rtt-stale.mjs` — eased arrival vs forced re-bake at the
same camera must differ by 0 pixels.

- issue: https://github.com/maplibre/maplibre-gl-js/issues/8251
- fix PR: https://github.com/maplibre/maplibre-gl-js/pull/8250
