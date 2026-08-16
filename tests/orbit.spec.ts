import { test } from '@playwright/test';
import { open, check } from './helpers';

/* Shift+drag orbits the subject of the frame */

test('shift+drag orbits around a pivot on the terrain', async ({ browser }) => {
  // A small window: the pitched default view is the expensive one to settle, and the
  // gesture only needs terrain in the frame and a rendered frame to raycast.
  const orbit = await open(browser, { viewport: { width: 800, height: 600 } });
  await orbit.waitForTimeout(10000);

  const grabbed = await orbit.evaluate(() => {
    const map = window.map;
    const tr = map._camera.transform;
    const pivot = window.choosePivot(map);
    if (!pivot) return null;
    const at = window.projectPoint(map, pivot.point)!;

    // On the terrain, not hanging in front of or inside it: the pixel the pivot projects to
    // must raycast back to the pivot's own depth.
    const under = map.terrain.pointCoordinate(at);
    const lat = under && under.toLngLat().lat;
    // Mercator units per metre at that latitude, the same scale MercatorCoordinate uses.
    const perMetre = under && 1 / (6378137 * 2 * Math.PI * Math.cos((lat * Math.PI) / 180));
    const underDepth = under
      ? Math.hypot(under.x - pivot.point.x, under.y - pivot.point.y) / perMetre
      : null;

    // Oracle for projectPoint, which the pivot's screen position is measured with: a point
    // raycast from a pixel has to project back onto that pixel.
    const probe = { x: tr.width * 0.35, y: tr.height * 0.7 };
    const hit = map.terrain.pointCoordinate(probe);
    const back = hit && window.projectPoint(map, { x: hit.x, y: hit.y, elevation: hit.z });

    return {
      from: pivot.from,
      depth: pivot.depth,
      share: pivot.share,
      point: pivot.point,
      hits: pivot.samples.filter((s: any) => s.point).length,
      voted: pivot.samples.filter((s: any) => s.chosen).length,
      total: pivot.samples.length,
      at,
      offCentre: Math.hypot(at.x - tr.width / 2, at.y - tr.height / 2),
      surfaceGapM: underDepth,
      surfaceDropM: under ? Math.abs(under.z - pivot.point.elevation) : null,
      roundTripPx: back ? Math.hypot(back.x - probe.x, back.y - probe.y) : null,
      bearing: tr.bearing,
      pitch: tr.pitch,
    };
  });
  await check(!!grabbed, 'the frame grid finds a pivot');
  if (!grabbed) return;
  await check(
    grabbed.from === 'subject' && grabbed.hits >= 3,
    'the grid, not the anchor ladder, chooses it',
    `${grabbed.hits}/${grabbed.total} hits`,
  );
  // A band of the depth range rather than everything down to the horizon, so the share is a
  // minority of a frame that runs from the foreground to 40 km out — and has to be one.
  await check(
    grabbed.voted >= 3 && grabbed.share > 0.2 && grabbed.share < 0.9,
    'one surface carries the choice',
    `${grabbed.voted} pts, ${(grabbed.share * 100).toFixed(0)}% of the weight`,
  );
  // The point of choosing a surface rather than a depth: the pivot is on the terrain, which
  // means the pixel it projects to looks back at the pivot itself.
  await check(
    grabbed.surfaceGapM !== null && grabbed.surfaceGapM < 30 && grabbed.surfaceDropM! < 30,
    'the pivot sits on the terrain surface',
    `${grabbed.surfaceGapM?.toFixed(1)} m across, ${grabbed.surfaceDropM?.toFixed(1)} m up`,
  );
  await check(
    grabbed.roundTripPx !== null && grabbed.roundTripPx < 5,
    'a raycast point projects back onto the pixel it came from',
    `${grabbed.roundTripPx?.toFixed(1)} px`,
  );

  // terrain.pointCoordinate encodes the tile a pixel came from in one byte, so past 255
  // rendered terrain tiles it decodes the wrong tile and answers with a real coordinate from
  // somewhere else — a 1900×1532 window at pitch 85 draws 306 and every sample came back
  // 200-350 km out. These checks run at detail=low, 18 tiles, and would never see it. So
  // assert the pivot does not ask that question at all: break the call, expect no change.
  const withoutCoords = await orbit.evaluate((g) => {
    const map = window.map;
    const real = map.terrain.pointCoordinate;
    map.terrain.pointCoordinate = () => null;
    try {
      const pivot = window.choosePivot(map);
      return (
        pivot && {
          from: pivot.from,
          movedM: Math.abs(pivot.depth - g.depth),
          hits: pivot.samples.filter((s: any) => s.point).length,
        }
      );
    } finally {
      map.terrain.pointCoordinate = real;
    }
  }, grabbed);
  await check(
    withoutCoords?.from === 'subject' && withoutCoords.movedM < 1,
    'the pivot is marched off the DEM, not read from the coords framebuffer',
    `${withoutCoords?.hits} hits, ${withoutCoords?.movedM.toFixed(2)} m`,
  );

  // Off centre and away from the mountain: where the drag starts must not move the pivot.
  await orbit.keyboard.down('Shift');
  await orbit.mouse.move(620, 460);
  await orbit.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await orbit.mouse.move(620 + i * 9, 460 + i * 5);
    await orbit.waitForTimeout(20);
  }
  // The camera as the drag ends, to compare with where it settles: MapLibre pins the
  // centre's elevation to the terrain every frame, and a gesture that hands back a state
  // it disagrees with gets dragged a kilometre vertically the moment the mouse comes up.
  const midDrag = await orbit.evaluate(() => window.map._camera.transform.getCameraAltitude());

  await orbit.mouse.up();
  await orbit.keyboard.up('Shift');
  await orbit.waitForTimeout(1000);

  const turned = await orbit.evaluate((g) => {
    const tr = window.map._camera.transform;
    const p = window.projectPoint(window.map, g.point);
    return {
      bearing: tr.bearing,
      pitch: tr.pitch,
      camAlt: tr.getCameraAltitude(),
      errPx: p ? Math.hypot(p.x - g.at.x, p.y - g.at.y) : Infinity,
    };
  }, grabbed);

  await check(
    Math.abs(turned.bearing - (grabbed.bearing + 72 * 0.4)) < 0.5,
    'a 72 px drag turns by the rotate speed',
    `${turned.bearing.toFixed(2)}°`,
  );
  await check(
    Math.abs(turned.pitch - (grabbed.pitch - 40 * 0.25)) < 0.5,
    'a 40 px drag tilts by the pitch speed',
    `${turned.pitch.toFixed(2)}°`,
  );
  // The whole point of the pivot: it keeps its pixel, however far from it the drag began.
  await check(turned.errPx < 10, 'the pivot holds its place through the turn', `${turned.errPx.toFixed(1)} px`);
  await check(
    Math.abs(turned.camAlt - midDrag) < 2,
    'letting go leaves the camera where the drag left it',
    `${(turned.camAlt - midDrag).toFixed(1)} m`,
  );
  await orbit.close();
});
