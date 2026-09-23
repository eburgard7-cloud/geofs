/*
 * FINSONLY Racing — touchdown detector.
 *
 * Pure-function landing analyzer: feed it a stream of flight samples and a runway definition,
 * get back liftoff/touchdown/bounce/go_around/settled events. Zero GeoFS/Cesium dependency, zero
 * DOM, zero globals, zero external deps — requireable from plain Node, same as
 * race/tools/terrain_probe.js and race/tools/probe.js's pure halves.
 *
 * NOT wired into race.js. This is the module + its tests only; the G adapter never sees it.
 *
 * Sample shape (one per tick): { t_ms, lat, lon, alt_m, agl_m, vs_mps, ias_mps, heading_deg,
 * bank_deg, pitch_deg, on_ground_bool }. Runway shape: { thr_lat, thr_lon, heading_deg,
 * length_m, width_m } (length_m/width_m are accepted but not required by the math here).
 *
 * Design notes:
 * - on_ground_bool is debounced: a raw flip only becomes a confirmed air<->ground transition
 *   once it has held for `debounceMs`, so a few noisy samples around the real contact point
 *   don't each read as their own event.
 * - vs_at_contact (and ias/bank/pitch) come from the last sample observed *before* the debounced
 *   contact was even raw-true — never from the contact sample itself or later, since gear
 *   compression and the debounce delay both corrupt those readings right at/after contact.
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

const EARTH_R_M = 6371000;

const DEFAULT_DEBOUNCE_MS = 120;
const DEFAULT_BOUNCE_WINDOW_MS = 2500;
const DEFAULT_GO_AROUND_AGL_M = 15;
const DEFAULT_SETTLED_IAS_MPS = 15;

function haversineM(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.sqrt(Math.min(1, h)));
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
    phase: null,                // 'air' | 'ground', confirmed (debounced)
    candidateRaw: null,         // raw on_ground value currently being debounced toward
    candidateSinceT: null,      // t_ms the candidate raw value first appeared
    lastAirborneSample: null,   // most recent sample seen with raw on_ground === false
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

  if (!raw) s.lastAirborneSample = sample;
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
            ias: ref.ias_mps,
            bank: ref.bank_deg,
            pitch: ref.pitch_deg,
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

module.exports = {
  EARTH_R_M,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_BOUNCE_WINDOW_MS,
  DEFAULT_GO_AROUND_AGL_M,
  DEFAULT_SETTLED_IAS_MPS,
  haversineM,
  runwayOffsets,
  touchdownInitialState,
  touchdownFeed,
  runTouchdownDetector,
};
