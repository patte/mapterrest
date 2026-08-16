import { test } from '@playwright/test';
import { open, check } from './helpers';

// The anchor marches the view axis to find the terrain the centre should sit on. A march
// that stops short reports no terrain for a view that is nothing but terrain, and settle
// then puts the centre on a plane 10 km under the camera — so the map holds a zoom for a
// height it is nowhere near and asks the LOD for that detail across a continent. At
// pitch 0 the camera passes 80 km up at z10.5, which is why this checks from there down.
test('zooming out leaves the centre on the ground', async ({ browser }) => {
  const high = await open(browser, { hash: '#map=13/50.195639/11.502985' });
  const ground = await high.evaluate(() =>
    window.map.terrain.getElevationForLngLatZoom(window.map.getCenter(), 12),
  );
  for (const zoom of [11, 10, 9]) {
    const settled = await high.evaluate(async (z) => {
      window.map.jumpTo({ zoom: z });
      await new Promise((done) => setTimeout(done, 3000));
      const tr = window.map._camera.transform;
      return { zoom: tr.zoom, plane: tr.elevation, altitude: tr.getCameraAltitude() };
    }, zoom);
    await check(
      Math.abs(settled.plane - ground) < 500 && Math.abs(settled.zoom - zoom) < 0.5,
      `zooming out to z${zoom} leaves the centre on the ground`,
      `plane ${settled.plane.toFixed(0)} m against ${ground.toFixed(0)} m, reads z${settled.zoom.toFixed(2)}`,
    );
  }
  await high.close();
});

// Settling re-expresses the camera it was handed, so the zoom it writes has to be the one
// it was given. Metres are the trap: MapLibre measures the scene with a scale taken at the
// centre's latitude, and at low zoom under pitch the centre is degrees away from the
// camera — five of them here, which is 6 % of scale and 0.08 of zoom given away on every
// mouse-up. Equatorward bearings lost zoom, poleward gained it.
test('settling holds the zoom it was handed', async ({ browser }) => {
  const held = await open(browser, { hash: '#map=5.84/29.682/53.557/-149.8/24' });
  const drift = await held.evaluate(async () => {
    const before = window.map.getZoom();
    // A no-op move fires moveend, which is what settles the camera.
    window.map.jumpTo({ center: window.map.getCenter() });
    await new Promise((done) => setTimeout(done, 2000));
    const tr = window.map._camera.transform;
    return { before, after: tr.zoom, camera: tr.getCameraAltitude() };
  });
  await check(
    Math.abs(drift.after - drift.before) < 0.005,
    'settling holds the zoom it was handed, well away from the equator',
    `z${drift.before.toFixed(4)} → z${drift.after.toFixed(4)}`,
  );
  await held.close();
});

// Mid-ocean the march finds no DEM at all, which is the other way in: settling on a
// crossing that does not exist writes the same invented plane. Nothing to anchor to means
// leave the camera alone, so the plane stays at sea level and the LOD stays coarse.
test('a camera over open water keeps its centre at sea level', async ({ browser }) => {
  const sea = await open(browser, { hash: '#map=1.46/-40.3/-82.3' });
  await sea.evaluate(async () => {
    window.map.jumpTo({ zoom: 3 });
    await new Promise((done) => setTimeout(done, 3000));
  });
  const overWater = await sea.evaluate(() => ({
    plane: window.map._camera.transform.elevation,
    zoom: window.map._camera.transform.zoom,
    rtt: window.map.terrain.tileManager._renderableTilesKeys.length,
  }));
  await check(
    Math.abs(overWater.plane) < 500 && overWater.rtt < 255,
    'a camera over open water keeps its centre at sea level',
    `plane ${overWater.plane.toFixed(0)} m, z${overWater.zoom.toFixed(2)}, ${overWater.rtt} terrain tiles`,
  );
  await sea.close();
});
