// Motion board: live demos (mockup-only CSS) + production GIF/APNG specs.
const MOT = ES.TH.light;
const DEMOS = {
  lock:()=><HeroLock T={MOT}></HeroLock>, pulse:()=><HeroDevice T={MOT}></HeroDevice>, tiles:()=><HeroTiles T={MOT}></HeroTiles>,
  route:()=><HeroRoute T={MOT}></HeroRoute>, reverse:()=><HeroRoute T={MOT} reverse></HeroRoute>, scanner:()=><HeroScanner T={MOT}></HeroScanner>,
  settle:()=><HeroSettle T={MOT}></HeroSettle>, check:()=><HeroCheck T={MOT}></HeroCheck>, pin:()=><HeroPin T={MOT}></HeroPin>,
  tag:()=><HeroTag T={MOT}></HeroTag>, clock:()=><HeroClock T={MOT} tone="err" arc></HeroClock>, calendar:()=><HeroCalendar T={MOT}></HeroCalendar>,
  bars:()=><HeroBars T={MOT}></HeroBars>,
};
const LVL = {1:['sec','L1 · Restrained security'],2:['info','L2 · Operational'],3:['ok','L3 · Success']};
function MotionCard({m}){
  const T = MOT;
  const rows = [['What moves',m.moves],['Duration',m.dur],['Loop',m.loop],['Format',m.fmt],['Dimensions',m.dims],['Max file size',m.size]];
  return (
    <div style={{width:600,boxSizing:'border-box',background:T.paper,padding:22,fontFamily:ES.F1,color:T.ink}}>
      <ESHeroBox T={T} h={140} style={{marginBottom:14}}>{DEMOS[m.id]()}</ESHeroBox>
      <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',marginBottom:4}}>
        <span style={{fontSize:15.5,fontWeight:600,letterSpacing:'-0.01em'}}>{m.name}</span>
        <ESPill T={T} s={LVL[m.level][0]} dot={false}>{LVL[m.level][1]}</ESPill>
      </div>
      <div style={{fontSize:11.5,color:T.ink3,marginBottom:12}}>Used by: {m.emails}</div>
      <div style={{border:`1px solid ${T.hair}`,borderRadius:6,overflow:'hidden'}}>
        {rows.map((r,i)=>(
          <div key={i} style={{display:'grid',gridTemplateColumns:'120px 1fr',gap:12,padding:'8px 12px',fontSize:11.5,
            borderBottom:i<rows.length-1?`1px solid ${T.hair}`:'none',background:i%2?T.raise:'transparent'}}>
            <span style={{fontFamily:ES.MONO,fontSize:8.5,letterSpacing:'0.14em',textTransform:'uppercase',color:T.ink4,paddingTop:2}}>{r[0]}</span>
            <span style={{color:T.ink2,lineHeight:1.5}}>{r[1]}</span>
          </div>))}
      </div>
    </div>);
}
function GlobalCard(){
  const T = MOT, G = ES.MOTION_GLOBAL;
  const rows = [['Polished first frame',G.firstFrame],['Reduced motion',G.reduced],['Outlook fallback',G.outlook],['Images blocked',G.blocked],['Weight budget',G.budget]];
  return (
    <div style={{width:600,boxSizing:'border-box',background:T.paper,padding:22,fontFamily:ES.F1,color:T.ink}}>
      <ESEyebrow T={T} mb={4}>Global rules — every asset</ESEyebrow>
      <div style={{fontSize:15.5,fontWeight:600,letterSpacing:'-0.01em',marginBottom:12}}>Fallbacks are the design, not an afterthought.</div>
      <div style={{border:`1px solid ${T.hair}`,borderRadius:6,overflow:'hidden'}}>
        {rows.map((r,i)=>(
          <div key={i} style={{display:'grid',gridTemplateColumns:'150px 1fr',gap:12,padding:'10px 12px',fontSize:12,
            borderBottom:i<rows.length-1?`1px solid ${T.hair}`:'none',background:i%2?T.raise:'transparent'}}>
            <span style={{fontSize:12,fontWeight:600,color:T.ink}}>{r[0]}</span>
            <span style={{color:T.ink3,lineHeight:1.55}}>{r[1]}</span>
          </div>))}
      </div>
      <div style={{marginTop:12,fontSize:11,color:T.ink4,lineHeight:1.6}}>Live CSS in these boards is for the design prototypes only — production emails ship the specified GIF/APNG with a static first-frame fallback. No JS, no web-animation libraries, no video, nothing Outlook can’t hold.</div>
    </div>);
}
function LevelsCard(){
  const T = MOT;
  const lv = [
    ['L1 — Restrained security','sec','Password reset · sign-in alert. A single settle or ≤3 soft pulses. Nothing playful; motion says “verified,” not “exciting.”'],
    ['L2 — Operational','info','Orders · rentals · schedule · portal. Progress along a path, a scan, a tile appearing — motion mirrors the physical operation.'],
    ['L3 — Success','ok','Approved · delivered · returned · workspace ready. Draws and settles, restrained ticks. Never confetti — and never celebration on denials, overdue, cancellations, or security.'],
  ];
  return (
    <div style={{width:600,boxSizing:'border-box',background:T.paper,padding:22,fontFamily:ES.F1,color:T.ink}}>
      <ESEyebrow T={T} mb={4}>Intensity levels</ESEyebrow>
      <div style={{fontSize:15.5,fontWeight:600,letterSpacing:'-0.01em',marginBottom:12}}>Three levels, matched to stakes.</div>
      <div style={{display:'grid',gap:10}}>
        {lv.map((l,i)=>(
          <div key={i} style={{border:`1px solid ${T.hair}`,borderRadius:6,padding:'12px 14px'}}>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:5}}><ESPill T={T} s={l[1]} dot={false}>{l[0]}</ESPill></div>
            <div style={{fontSize:12,lineHeight:1.55,color:T.ink3}}>{l[2]}</div>
          </div>))}
      </div>
    </div>);
}
if (window.ES_MOUNT === 'motion'){
  function App(){
    return (
      <DesignCanvas>
        <DCSection id="rules" title="Motion System" subtitle="Email animation is GIF/APNG territory — these are the rules every asset obeys">
          <DCArtboard id="levels" label="Intensity levels" width={600} height={480} style={esA()}><LevelsCard></LevelsCard></DCArtboard>
          <DCArtboard id="global" label="Global fallback rules" width={600} height={560} style={esA()}><GlobalCard></GlobalCard></DCArtboard>
        </DCSection>
        <DCSection id="assets" title="Asset Specs" subtitle="One card per production asset — live demo above, export spec below">
          {ES.MOTION.map(m=>(
            <DCArtboard key={m.id} id={`m-${m.id}`} label={m.name} width={600} height={560} style={esA()}><MotionCard m={m}></MotionCard></DCArtboard>))}
        </DCSection>
      </DesignCanvas>);
  }
  ReactDOM.createRoot(document.getElementById('root')).render(<App></App>);
}
