// StockPilot Email System — animated hero assets (live CSS previews; production = GIF/APNG per motion board).
// All are refined ink-line abstractions, 220×120 viewBox, tone-aware.
const HTL = ES.TH.light;
const hsvg = (T, children, key) => (
  <svg key={key} className="es-anim" viewBox="0 0 220 120" width="220" height="120" style={{display:'block',overflow:'visible'}}>{children}</svg>
);
function HeroLock({T=HTL}){
  const c = T.ink;
  return hsvg(T, <g fill="none" stroke={c} strokeOpacity="0.8" strokeWidth="2">
    <circle cx="110" cy="62" r="34" stroke={c} strokeOpacity="0.25" style={{animation:'es-ring 3s ease-out infinite',transformOrigin:'110px 62px'}}></circle>
    <circle cx="110" cy="62" r="34" stroke={c} strokeOpacity="0.18" style={{animation:'es-ring 3s ease-out 1s infinite',transformOrigin:'110px 62px'}}></circle>
    <path d="M 97 56 v-8 a13 13 0 0 1 26 0 v8"></path>
    <rect x="90" y="56" width="40" height="30" rx="6" fill={T.sunk}></rect>
    <circle cx="110" cy="68" r="3.5" fill={c} stroke="none"></circle>
    <line x1="110" y1="71" x2="110" y2="78"></line>
  </g>);
}
function HeroDevice({T=HTL}){
  const c = T.ink, a = T.status.info.fg;
  return hsvg(T, <g fill="none" stroke={c} strokeOpacity="0.8" strokeWidth="2">
    <rect x="62" y="30" width="82" height="52" rx="4"></rect>
    <line x1="50" y1="88" x2="156" y2="88" strokeLinecap="round"></line>
    <line x1="96" y1="58" x2="112" y2="58" strokeOpacity="0.35"></line>
    <line x1="88" y1="66" x2="120" y2="66" strokeOpacity="0.35"></line>
    <circle cx="158" cy="82" r="5" fill={a} stroke="none"></circle>
    <circle cx="158" cy="82" r="12" stroke={a} strokeOpacity="0.6" style={{animation:'es-ring 2.8s ease-out infinite',transformOrigin:'158px 82px'}}></circle>
    <circle cx="158" cy="82" r="12" stroke={a} strokeOpacity="0.4" style={{animation:'es-ring 2.8s ease-out 0.9s infinite',transformOrigin:'158px 82px'}}></circle>
  </g>);
}
function HeroTiles({T=HTL, check=true}){
  const c = T.ink, ok = T.status.ok.fg;
  const tiles = [[64,26],[94,26],[124,26],[64,56],[94,56],[124,56]];
  return hsvg(T, <g>
    {tiles.map((t,i)=>(
      <rect key={i} x={t[0]} y={t[1]} width="24" height="24" rx="5" fill={i===5&&check?T.status.ok.bg:T.sunk}
        stroke={i===5&&check?ok:c} strokeOpacity={i===5&&check?0.9:0.5} strokeWidth="1.5"
        style={{animation:`es-drop .5s cubic-bezier(.2,.7,.3,1.3) ${i*0.12}s both`}}></rect>))}
    {check && <path d="M 130 68 l 4 4 l 8 -8" fill="none" stroke={ok} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      strokeDasharray="20" strokeDashoffset="20" style={{animation:'es-draw .4s ease .9s forwards'}}></path>}
    <line x1="64" y1="92" x2="148" y2="92" stroke={c} strokeOpacity="0.25" strokeWidth="2" strokeLinecap="round"></line>
  </g>);
}
function HeroRoute({T=HTL, reverse=false}){
  const c = T.ink, a = T.status.info.fg;
  return hsvg(T, <g transform={reverse?'scale(-1,1) translate(-220,0)':undefined}>
    <line x1="28" y1="72" x2="192" y2="72" stroke={c} strokeOpacity="0.35" strokeWidth="2" strokeDasharray="6 6"
      style={{animation:'es-march 1.6s linear infinite'}}></line>
    <circle cx="28" cy="72" r="5" fill={c} fillOpacity="0.75"></circle>
    <circle cx="192" cy="72" r="5" fill="none" stroke={a} strokeWidth="2"></circle>
    <circle cx="192" cy="72" r="10" fill="none" stroke={a} strokeOpacity="0.5" style={{animation:'es-ring 3.6s ease-out infinite',transformOrigin:'192px 72px'}}></circle>
    <g style={{animation:'es-travel 3.6s ease-in-out infinite','--es-tx':'72px','--es-tx2':'144px'}}>
      <rect x="30" y="48" width="26" height="20" rx="3" fill={T.sunk} stroke={c} strokeOpacity="0.85" strokeWidth="2"></rect>
      <line x1="43" y1="48" x2="43" y2="54" stroke={c} strokeOpacity="0.85" strokeWidth="2"></line>
    </g>
  </g>);
}
function HeroScanner({T=HTL}){
  const c = T.ink, a = T.status.info.fg;
  return hsvg(T, <g fill="none" stroke={c} strokeOpacity="0.8" strokeWidth="2">
    <rect x="82" y="36" width="56" height="46" rx="4" fill={T.sunk}></rect>
    <line x1="110" y1="36" x2="110" y2="46"></line>
    {[92,99,104,113,120,127].map((x,i)=><line key={i} x1={x} y1="62" x2={x} y2="74" strokeWidth={i%2?1.5:3} strokeOpacity="0.65"></line>)}
    <g strokeOpacity="0.45">
      <path d="M 66 30 h -10 v 10"></path><path d="M 154 30 h 10 v 10"></path>
      <path d="M 66 90 h -10 v -10"></path><path d="M 154 90 h 10 v -10"></path>
    </g>
    <line x1="110" y1="26" x2="110" y2="94" stroke={a} strokeWidth="2" strokeOpacity="0.9"
      style={{animation:'es-scan 2.4s ease-in-out infinite'}}></line>
  </g>);
}
function HeroSettle({T=HTL}){
  const c = T.ink, ok = T.status.ok.fg;
  return hsvg(T, <g>
    {[[70,60,26,26],[102,68,22,18],[130,54,30,32]].map((b,i)=>(
      <g key={i} style={{animation:`es-drop .55s cubic-bezier(.2,.7,.3,1.35) ${i*0.16}s both`}}>
        <rect x={b[0]} y={b[1]} width={b[2]} height={b[3]} rx="3" fill={T.sunk} stroke={c} strokeOpacity="0.8" strokeWidth="2"></rect>
        <line x1={b[0]+b[2]/2} y1={b[1]} x2={b[0]+b[2]/2} y2={b[1]+5} stroke={c} strokeOpacity="0.8" strokeWidth="2"></line>
      </g>))}
    <line x1="56" y1="88" x2="168" y2="88" stroke={c} strokeOpacity="0.3" strokeWidth="2" strokeLinecap="round"></line>
    <circle cx="166" cy="48" r="4" fill={ok} style={{animation:'es-blinkonce 1.4s ease both'}}></circle>
  </g>);
}
function HeroCheck({T=HTL, tone='ok'}){
  const a = T.status[tone].fg;
  return hsvg(T, <g fill="none">
    <circle cx="110" cy="60" r="32" stroke={a} strokeWidth="2.5" strokeDasharray="202" strokeDashoffset="202"
      style={{animation:'es-draw .9s ease forwards',transform:'rotate(-90deg)',transformOrigin:'110px 60px'}}></circle>
    <path d="M 96 61 l 10 10 l 20 -22" stroke={a} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
      strokeDasharray="46" strokeDashoffset="46" style={{animation:'es-draw .5s ease .7s forwards'}}></path>
    {[[110,14],[156,60],[110,106],[64,60]].map((p,i)=>(
      <line key={i} x1={p[0]} y1={p[1]} x2={p[0]+(p[0]===110?0:p[0]>110?6:-6)} y2={p[1]+(p[1]===60?0:p[1]>60?6:-6)}
        stroke={a} strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" style={{animation:'es-fadein .5s ease 1.15s both'}}></line>))}
  </g>);
}
function HeroPin({T=HTL}){
  const c = T.ink, ok = T.status.ok.fg;
  return hsvg(T, <g fill="none" stroke={c} strokeOpacity="0.8" strokeWidth="2">
    <line x1="44" y1="88" x2="176" y2="88" strokeLinecap="round"></line>
    {[58,86,114,142,170].map((x,i)=><line key={i} x1={x} y1="88" x2={x-8} y2="98" strokeOpacity="0.3" strokeWidth="1.5"></line>)}
    <rect x="84" y="56" width="30" height="32" rx="3" fill={T.sunk}></rect>
    <line x1="99" y1="56" x2="99" y2="63"></line>
    <g style={{animation:'es-drop .6s cubic-bezier(.2,.7,.3,1.3) both'}}>
      <path d="M 142 44 a 11 11 0 1 1 0.01 0 M 142 55 l 0 14" stroke={ok} strokeWidth="2.5"></path>
      <circle cx="142" cy="38.5" r="4" fill={ok} stroke="none"></circle>
    </g>
    <circle cx="142" cy="72" r="8" stroke={ok} strokeOpacity="0.6" style={{animation:'es-ring 2.6s ease-out .5s infinite',transformOrigin:'142px 72px'}}></circle>
  </g>);
}
function HeroTag({T=HTL}){
  const c = T.ink;
  return hsvg(T, <g fill="none" stroke={c} strokeOpacity="0.8" strokeWidth="2">
    <path d="M 110 18 q 14 4 0 12" strokeOpacity="0.5"></path>
    <g style={{animation:'es-swing 3.2s ease-in-out infinite',transformOrigin:'110px 30px'}}>
      <rect x="86" y="30" width="48" height="62" rx="9" fill={T.sunk}></rect>
      <circle cx="110" cy="42" r="4.5"></circle>
      <line x1="96" y1="60" x2="124" y2="60" strokeOpacity="0.5"></line>
      <line x1="96" y1="70" x2="116" y2="70" strokeOpacity="0.35"></line>
      <line x1="96" y1="80" x2="120" y2="80" strokeOpacity="0.35"></line>
    </g>
  </g>);
}
function HeroClock({T=HTL, tone='warn', arc=false}){
  const c = T.ink, a = T.status[tone].fg;
  return hsvg(T, <g fill="none">
    <circle cx="110" cy="60" r="36" stroke={c} strokeOpacity="0.8" strokeWidth="2" fill={T.sunk}></circle>
    {[0,30,60,90,120,150,180,210,240,270,300,330].map((d,i)=>(
      <line key={i} x1="110" y1="27" x2="110" y2={i%3===0?32:30} stroke={c} strokeOpacity="0.5" strokeWidth={i%3===0?2:1}
        transform={`rotate(${d} 110 60)`}></line>))}
    {arc && <path d="M 110 24 A 36 36 0 0 1 141 78" stroke={a} strokeWidth="3.5" strokeOpacity="0.85"
      strokeLinecap="round" style={{animation:'es-fadein .8s ease .8s both'}}></path>}
    <line x1="110" y1="60" x2="110" y2="34" stroke={a} strokeWidth="3" strokeLinecap="round"
      style={{animation:'es-hand 2.6s cubic-bezier(.6,0,.3,1) forwards',transformOrigin:'110px 60px'}}></line>
    <line x1="110" y1="60" x2="94" y2="68" stroke={c} strokeOpacity="0.7" strokeWidth="2.5" strokeLinecap="round"></line>
    <circle cx="110" cy="60" r="3.5" fill={c}></circle>
  </g>);
}
function HeroCalendar({T=HTL}){
  const c = T.ink, a = T.status.info.fg;
  return hsvg(T, <g fill="none" stroke={c} strokeOpacity="0.8" strokeWidth="2">
    <rect x="74" y="30" width="72" height="62" rx="8" fill={T.sunk}></rect>
    <line x1="74" y1="48" x2="146" y2="48"></line>
    <line x1="92" y1="22" x2="92" y2="36" strokeLinecap="round"></line>
    <line x1="128" y1="22" x2="128" y2="36" strokeLinecap="round"></line>
    {[[88,60],[104,60],[120,60],[88,74],[120,74]].map((p,i)=><circle key={i} cx={p[0]} cy={p[1]} r="2" fill={c} fillOpacity="0.35" stroke="none"></circle>)}
    <rect x="98" y="66" width="16" height="16" rx="4" fill={T.status.info.bg} stroke={a} strokeWidth="2"
      style={{animation:'es-pop .5s cubic-bezier(.2,.7,.3,1.3) .4s both',transformOrigin:'106px 74px'}}></rect>
  </g>);
}
function HeroBars({T=HTL}){
  const c = T.ink, w = T.status.warn.fg;
  const bars = [[66,38],[90,52],[114,30],[138,58],[162,44]];
  return hsvg(T, <g>
    {bars.map((b,i)=>(
      <rect key={i} x={b[0]} y={92-b[1]} width="14" height={b[1]} rx="3" fill={i===3?w:c} fillOpacity={i===3?0.85:0.6}
        style={{animation:`es-rise .7s cubic-bezier(.2,.7,.3,1) ${i*0.1}s both`,transformOrigin:`${b[0]+7}px 92px`}}></rect>))}
    <line x1="56" y1="92" x2="186" y2="92" stroke={c} strokeOpacity="0.35" strokeWidth="2" strokeLinecap="round"></line>
  </g>);
}
Object.assign(window, {HeroLock, HeroDevice, HeroTiles, HeroRoute, HeroScanner, HeroSettle, HeroCheck, HeroPin, HeroTag, HeroClock, HeroCalendar, HeroBars});
