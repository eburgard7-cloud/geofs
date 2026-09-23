#!/usr/bin/env node
/*
 * FINSONLY Racing — touchdown replay CLI.
 *
 * Runs race/touchdown.js's pure detector over a recorded sample stream — from
 * race/tools/recorder.js's Copy JSON output, or any JSON matching its sample shape — and prints
 * the resulting events plus a table of the key numbers off each touchdown. No scoring, no server
 * calls: this is a read tool for eyeballing what the detector saw.
 *
 * Usage: node replay_landing.mjs recording.json [runway.json]
 *
 * recording.json: either { samples: [...] } (recorder.js's own output shape) or a bare [...]
 * array of samples, each matching touchdown.js's documented sample shape ({ t_ms, lat, lon,
 * alt_m, agl_m, vs_mps, ias_mps, heading_deg, bank_deg, pitch_deg, on_ground_bool }).
 *
 * runway.json (optional): { thr_lat, thr_lon, heading_deg, length_m, width_m } — without it,
 * centerline_offset_m/distance_from_threshold_m on every touchdown come back null (see
 * touchdown.js's runwayOffsets).
 *
 * See race/tools/sample_landing_recording.json and race/tools/sample_runway.json for a worked
 * (synthetic) example.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import TD from '../touchdown.js';

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function extractSamples(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.samples)) return data.samples;
  throw new Error('expected either a bare array of samples or { samples: [...] }');
}

function padLeft(s, n) {
  s = String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function fmtNum(v, digits) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : 'n/a';
}

export function formatEvents(events) {
  return events.map((e) => {
    const base = `${e.type.padEnd(11)} t=${padLeft(e.t_ms, 7)}ms`;
    if (e.type === 'bounce') return `${base}  n=${e.n}`;
    if (e.type === 'settled') return `${base}  total_rollout_m=${fmtNum(e.total_rollout_m, 1)}`;
    return base;
  });
}

export function formatTouchdownTable(events) {
  const touchdowns = events.filter((e) => e.type === 'touchdown');
  if (touchdowns.length === 0) return '(no touchdown events)';
  const headers = ['#', 't_ms', 'vs_mps', 'ias_mps', 'bank_deg', 'pitch_deg', 'centerline_m', 'dist_thr_m'];
  const rows = touchdowns.map((td, i) => [
    String(i + 1),
    String(td.t_ms),
    fmtNum(td.vs_at_contact, 2),
    fmtNum(td.ias, 2),
    fmtNum(td.bank, 2),
    fmtNum(td.pitch, 2),
    fmtNum(td.centerline_offset_m, 2),
    fmtNum(td.distance_from_threshold_m, 2),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => padLeft(c, widths[i])).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

function indent(text, prefix) {
  return text.split('\n').map((l) => prefix + l).join('\n');
}

export function run(recordingPath, runwayPath) {
  const samples = extractSamples(readJson(recordingPath));
  const runway = runwayPath ? readJson(runwayPath) : null;

  const lines = [];
  lines.push(`Loaded ${samples.length} samples from ${recordingPath}` +
    (runway ? `, runway from ${runwayPath}` : ' (no runway supplied — centerline/threshold distances will be null)'));

  const { events } = TD.runTouchdownDetector(samples, runway);

  lines.push('');
  lines.push('Events:');
  lines.push(events.length ? indent(formatEvents(events).join('\n'), '  ') : '  (none)');

  lines.push('');
  lines.push('Touchdowns:');
  lines.push(indent(formatTouchdownTable(events), '  '));

  return { text: lines.join('\n'), events };
}

function main() {
  const [, , recordingPath, runwayPath] = process.argv;
  if (!recordingPath) {
    console.error('Usage: node replay_landing.mjs recording.json [runway.json]');
    process.exitCode = 1;
    return;
  }
  const { text } = run(recordingPath, runwayPath);
  console.log(text);
}

// Only run as a CLI when invoked directly (`node replay_landing.mjs ...`), not when imported by a
// test — same guard shape as require.main === module in a CommonJS tool. argv[1] is a filesystem
// path, so it goes through pathToFileURL: a bare `file://${argv[1]}` never matches on Windows
// (drive letter, backslashes) or for any path with a space in it, and the CLI silently did nothing.
export function invokedDirectly(metaUrl, argv1) {
  return typeof argv1 === 'string' && argv1.length > 0 && metaUrl === pathToFileURL(argv1).href;
}

if (invokedDirectly(import.meta.url, process.argv[1])) {
  try {
    main();
  } catch (e) {
    console.error('replay_landing failed: ' + e.message);
    process.exitCode = 1;
  }
}
