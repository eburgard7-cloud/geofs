const { JSDOM } = require('jsdom');
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join('..','race.js'),'utf8');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
const w = dom.window;
w.requestAnimationFrame = () => {};
w.fetch = async () => ({ok:false,status:404,json: async()=>({})});
w.WebSocket = class { constructor(){} send(){} close(){} };
w.eval(SRC);
const I = w.__finsRace._internals;
const g1={lat:45,lon:-122,alt:500}, g2=I.destination(g1,90,5000);
const track = I.formationBuildTrack(g1,g2,92.6);
console.log('approachLen', track.approachLen, 'legLen', track.legLen, 'turnLen', track.turnLen, 'lapLen', track.lapLen);
for (let s=-500; s<track.approachLen+track.lapLen*1.5; s+=37) {
  const eps=5;
  const p0=I.formationPositionAt(track,s+eps), p1=I.formationPositionAt(track,s-eps), pm=I.formationPositionAt(track,s);
  const wantHdg = I.bearingDeg(p0,p1);
  const diff = Math.abs(((wantHdg-pm.heading+540)%360)-180);
  if (diff>3) console.log('s='+s.toFixed(0), 'want='+wantHdg.toFixed(1), 'got='+pm.heading.toFixed(1), 'diff='+diff.toFixed(1));
}
