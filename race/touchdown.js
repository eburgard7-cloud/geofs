/*
 * FINSONLY Racing — touchdown detector.
 *
 * Pure-function landing analyzer: feed it a stream of flight samples and a runway definition,
 * get back liftoff/touchdown/bounce/go_around/settled events. Zero GeoFS/Cesium dependency, zero
 * DOM, zero globals, zero external deps — requireable from plain Node, same as
 * race/tools/terrain_probe.js and race/tools/probe.js's pure halves.
 *
 * race.js's Landing tab runs this detector: race.js stays one file with no build step, so it carries a
 * VERBATIM copy of the section between the "detector (BEGIN/END)" markers below (inside its own
 * Touchdown scope), and race/test/run.js fails if the two ever differ. Edit here, then paste the
 * section into race.js. The G adapter feeds it samples (G.landingSample()); nothing here reads GeoFS.
 *
 * Sample shape (one per tick): { t_ms, lat, lon, alt_m, agl_m, vs_mps, ias_mps, heading_deg,
 * bank_deg, pitch_deg, on_ground_bool }. Runway shape: { thr_lat, thr_lon, heading_deg,
 * length_m, width_m } (length_m/width_m are accepted but not required by the math here).
 *
 * Design notes:
 * - on_ground_bool is debounced: a raw flip only becomes a confirmed air<->ground transition
 *   once it has held for `debounceMs`, so a few noisy samples around the real contact point
 *   don't each read as their own event.
 * - Touchdown event shape: { type: 'touchdown', t_ms, vs_at_contact, vs_geom_mps, ias, bank, pitch,
 *   lat, lon, heading_deg, centerline_offset_m, distance_from_threshold_m }. This is the shape
 *   POST /landings (race/server/app.py) accepts as-is.
 * - vs_at_contact (and ias/bank/pitch/lat/lon/heading_deg) come from the last sample observed *before* the debounced
 *   contact was even raw-true — never from the contact sample itself or later, since gear
 *   compression and the debounce delay both corrupt those readings right at/after contact.
 * - vs_geom_mps is a sanity check on vs_at_contact: the least-squares slope of alt_m over the last
 *   `sinkWindowMs` (default DEFAULT_SINK_WINDOW_MS) of airborne samples before contact, negated to
 *   the same sign convention (negative = descending). Null when fewer than 2 usable points were
 *   seen in that window. score_touchdown() (app.py) scores min(|vs_at_contact|, |vs_geom_mps|*1.25)
 *   when both exist, so one lagged or spiky verticalSpeed sample can't zero a landing by itself.
 * - A ground contact within `bounceWindowMs` of the prior one, with a positive VS sample
 *   somewhere in the air between them, is a bounce (reuses the prior landing's sequence and
 *   rollout tally) rather than a fresh touchdown. Outside that window, or with no climb in
 *   between, it's a new touchdown.
 * - go_around fires once per landing sequence, either when the aircraft climbs back above
 *   `goAroundAglM` AGL while still ascending, or when the bounce window lapses with the aircraft
 *   still airborne — whichever comes first. Either way the sequence closes, so any later contact
 *   is a fresh touchdown, not a bounce.
 * - settled fires once per landing sequence, the first ground sample whose IAS has decayed to
 *   `settledIasMps` or below, carrying the total horizontal distance covered since the fresh
 *   touchdown (rollout across bounce hops included — the plane really did travel that ground).
 */
'use strict';

// ---- detector (BEGIN: race.js carries a verbatim copy; race/test/run.js fails if they drift)
const EARTH_R_M = 6371000;

const DEFAULT_DEBOUNCE_MS = 120;
const DEFAULT_BOUNCE_WINDOW_MS = 2500;
const DEFAULT_GO_AROUND_AGL_M = 15;
const DEFAULT_SETTLED_IAS_MPS = 15;
const DEFAULT_SINK_WINDOW_MS = 500;

function haversineM(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.sqrt(Math.min(1, h)));
}

// Least-squares slope (d alt_m / d t_s) of a { t_ms, alt_m } point cloud — the geometric sink rate
// sanity check: a lagged or spiky GeoFS verticalSpeed sample can misreport vs_at_contact, but the
// altitude trace over the last DEFAULT_SINK_WINDOW_MS before contact can't lie the same way. Needs
// at least 2 points spanning > 0 ms, else there is nothing to fit; returns null rather than guess.
function leastSquaresSlope(points) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => Number.isFinite(p.t_ms) && Number.isFinite(p.alt_m));
  if (pts.length < 2) return null;
  const t0 = pts[0].t_ms;
  const xs = pts.map((p) => (p.t_ms - t0) / 1000);
  const ys = pts.map((p) => p.alt_m);
  const n = xs.length;
  const sumX = xs.reduce((a, x) => a + x, 0);
  const sumY = ys.reduce((a, y) => a + y, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const sumXX = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (!(Math.abs(denom) > 1e-9)) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

// Runway-relative offsets for a lat/lon, in a flat-earth frame local to the threshold (fine at
// runway scale). alongM is signed distance from the threshold along the landing heading
// (negative = short of the threshold); crossM is signed centerline offset (positive = right of
// centerline, facing down the runway heading).
function runwayOffsets(runway, lat, lon) {
  if (!runway || !Number.isFinite(runway.thr_lat) || !Number.isFinite(runway.thr_lon) || !Number.isFinite(runway.heading_deg)) {
    return { alongM: null, crossM: null };
  }
  const latRad = (runway.thr_lat * Math.PI) / 180;
  const mPerDegLat = (Math.PI / 180) * EARTH_R_M;
  const mPerDegLon = mPerDegLat * Math.cos(latRad);
  const dNorth = (lat - runway.thr_lat) * mPerDegLat;
  const dEast = (lon - runway.thr_lon) * mPerDegLon;
  const hdg = (runway.heading_deg * Math.PI) / 180;
  const alongM = dEast * Math.sin(hdg) + dNorth * Math.cos(hdg);
  const crossM = dEast * Math.cos(hdg) - dNorth * Math.sin(hdg);
  return { alongM, crossM };
}

function touchdownInitialState(runway, options) {
  const opts = options || {};
  return {
    runway: runway || null,
    debounceMs: Number.isFinite(opts.debounceMs) ? opts.debounceMs : DEFAULT_DEBOUNCE_MS,
    bounceWindowMs: Number.isFinite(opts.bounceWindowMs) ? opts.bounceWindowMs : DEFAULT_BOUNCE_WINDOW_MS,
    goAroundAglM: Number.isFinite(opts.goAroundAglM) ? opts.goAroundAglM : DEFAULT_GO_AROUND_AGL_M,
    settledIasMps: Number.isFinite(opts.settledIasMps) ? opts.settledIasMps : DEFAULT_SETTLED_IAS_MPS,
    sinkWindowMs: Number.isFinite(opts.sinkWindowMs) ? opts.sinkWindowMs : DEFAULT_SINK_WINDOW_MS,
    phase: null,                // 'air' | 'ground', confirmed (debounced)
    candidateRaw: null,         // raw on_ground value currently being debounced toward
    candidateSinceT: null,      // t_ms the candidate raw value first appeared
    lastAirborneSample: null,   // most recent sample seen with raw on_ground === false
    altWindow: [],              // { t_ms, alt_m } for airborne samples in the last sinkWindowMs
    climbSincePriorContact: false, // saw vs_mps > 0 while airborne since the last confirmed contact
    priorContactRawT: null,     // raw (pre-debounce) t_ms of the last confirmed ground contact
    sequenceOpen: false,        // a landing sequence (touchdown..bounces..settled/go_around) is live
    goAroundEmitted: false,
    bounceCount: 0,
    lastGroundPos: null,
    rolloutDistanceM: 0,
    settledEmitted: false,
  };
}

function touchdownFeed(state, sample) {
  const s = Object.assign({}, state);
  const events = [];
  const raw = !!sample.on_ground_bool;

  if (s.phase === null) {
    // Bootstrap on the first sample: adopt whatever ground state it reports, no transition to report.
    s.phase = raw ? 'ground' : 'air';
    s.lastAirborneSample = raw ? null : sample;
    return { state: s, events };
  }

  if (!raw) {
    s.lastAirborneSample = sample;
    if (Number.isFinite(sample.t_ms) && Number.isFinite(sample.alt_m)) {
      s.altWindow = s.altWindow.concat([{ t_ms: sample.t_ms, alt_m: sample.alt_m }])
        .filter((p) => sample.t_ms - p.t_ms <= s.sinkWindowMs);
    }
  }
  if (s.phase === 'air' && Number.isFinite(sample.vs_mps) && sample.vs_mps > 0) {
    s.climbSincePriorContact = true;
  }

  // A landing sequence is live and we're airborne again: decide whether this is heading for a
  // bounce (handled below, on the next confirmed contact) or has become a real go-around.
  if (s.phase === 'air' && s.sequenceOpen && !s.goAroundEmitted) {
    const climbingClear = Number.isFinite(sample.agl_m) && sample.agl_m > s.goAroundAglM &&
      Number.isFinite(sample.vs_mps) && sample.vs_mps > 0;
    const timedOut = s.priorContactRawT != null && (sample.t_ms - s.priorContactRawT) > s.bounceWindowMs;
    if (climbingClear || timedOut) {
      events.push({ type: 'go_around', t_ms: sample.t_ms });
      s.goAroundEmitted = true;
      s.sequenceOpen = false;
    }
  }

  const confirmedGround = s.phase === 'ground';
  if (raw !== confirmedGround) {
    if (s.candidateRaw !== raw) {
      s.candidateRaw = raw;
      s.candidateSinceT = sample.t_ms;
    }
    if (sample.t_ms - s.candidateSinceT >= s.debounceMs) {
      const transitionRawT = s.candidateSinceT;
      s.candidateRaw = null;
      s.candidateSinceT = null;
      if (raw) {
        // ---- confirmed ground contact ----
        s.phase = 'ground';
        const ref = s.lastAirborneSample || sample;
        const isBounce = s.sequenceOpen && s.climbSincePriorContact &&
          s.priorContactRawT != null && (transitionRawT - s.priorContactRawT) <= s.bounceWindowMs;
        if (isBounce) {
          s.bounceCount += 1;
          events.push({ type: 'bounce', t_ms: transitionRawT, n: s.bounceCount });
        } else {
          const offsets = runwayOffsets(s.runway, ref.lat, ref.lon);
          s.bounceCount = 0;
          s.sequenceOpen = true;
          s.goAroundEmitted = false;
          s.settledEmitted = false;
          // Rollout starts at the pre-contact reference point, not the (later, debounce-delayed)
          // confirmation sample, so the accumulation below picks up the ground actually covered
          // between the real touchdown and the first confirmed ground reading.
          s.lastGroundPos = { lat: ref.lat, lon: ref.lon };
          s.rolloutDistanceM = 0;
          events.push({
            type: 'touchdown',
            t_ms: transitionRawT,
            vs_at_contact: ref.vs_mps,
            // Geometric sink check: least-squares slope of alt_m over the last sinkWindowMs before
            // contact, negated to match vs_at_contact's sign (negative = descending). Null when the
            // window has fewer than 2 usable points. See score_touchdown() (app.py): the server
            // scores min(|vs_at_contact|, |vs_geom_mps| * 1.25) when both exist, so a lagged or
            // spiky verticalSpeed reading can't zero a landing on its own.
            vs_geom_mps: (() => { const m = leastSquaresSlope(s.altWindow); return m == null ? null : m; })(),
            ias: ref.ias_mps,
            bank: ref.bank_deg,
            pitch: ref.pitch_deg,
            // Position and heading at contact, same pre-contact sample: the landing server
            // recomputes centerline/zone/crab from these rather than trusting the offsets below.
            lat: ref.lat,
            lon: ref.lon,
            heading_deg: ref.heading_deg,
            centerline_offset_m: offsets.crossM,
            distance_from_threshold_m: offsets.alongM,
          });
        }
        s.priorContactRawT = transitionRawT;
        s.climbSincePriorContact = false;
      } else {
        // ---- confirmed liftoff ----
        s.phase = 'air';
        s.climbSincePriorContact = false;
        events.push({ type: 'liftoff', t_ms: transitionRawT });
      }
    }
  } else if (s.candidateRaw !== null) {
    // Raw agrees with the confirmed phase again before debounce finished — noise, drop it.
    s.candidateRaw = null;
    s.candidateSinceT = null;
  }

  if (s.phase === 'ground' && s.sequenceOpen && !s.settledEmitted) {
    const pos = { lat: sample.lat, lon: sample.lon };
    if (s.lastGroundPos) s.rolloutDistanceM += haversineM(s.lastGroundPos, pos);
    s.lastGroundPos = pos;
    if (Number.isFinite(sample.ias_mps) && sample.ias_mps <= s.settledIasMps) {
      events.push({ type: 'settled', t_ms: sample.t_ms, total_rollout_m: s.rolloutDistanceM });
      s.settledEmitted = true;
      s.sequenceOpen = false;
    }
  }

  return { state: s, events };
}

// Convenience: run a whole sample array through a fresh detector and return the flat event list.
function runTouchdownDetector(samples, runway, options) {
  let state = touchdownInitialState(runway, options);
  const events = [];
  for (const sample of samples) {
    const res = touchdownFeed(state, sample);
    state = res.state;
    for (const e of res.events) events.push(e);
  }
  return { events, state };
}
// ---- detector (END)

module.exports = {
  EARTH_R_M,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_BOUNCE_WINDOW_MS,
  DEFAULT_GO_AROUND_AGL_M,
  DEFAULT_SETTLED_IAS_MPS,
  DEFAULT_SINK_WINDOW_MS,
  haversineM,
  leastSquaresSlope,
  runwayOffsets,
  touchdownInitialState,
  touchdownFeed,
  runTouchdownDetector,
};
