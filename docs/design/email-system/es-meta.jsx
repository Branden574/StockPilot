// Canvas chrome: inbox meta cards, decision flags, latent strips. Light-theme only (annotation layer, not email).
const MT = ES.TH.light;
const CAT = {
  ess:['sec','Essential — always sent'], pref:['info','Preference-controlled'],
  ext:['purple','External recipient'], int:['neutral','Internal only'],
};
const FOOTL = {ess:'Essential (no unsubscribe)', pref:'Preferences + unsubscribe', ext:'External explainer', int:'Internal compact'};
function ESMetaCard({e}){
  const T = MT;
  const R = ({k,children})=>(
    <div style={{display:'flex',gap:12,padding:'7px 0',borderBottom:`1px solid ${T.hair}`,alignItems:'baseline'}}>
      <span style={{fontFamily:ES.MONO,fontSize:8.5,letterSpacing:'0.16em',textTransform:'uppercase',color:T.ink4,width:76,flex:'0 0 auto',paddingTop:1}}>{k}</span>
      <span style={{fontSize:11.5,lineHeight:1.45,color:T.ink2,minWidth:0}}>{children}</span>
    </div>);
  return (
    <div style={{width:380,boxSizing:'border-box',background:T.paper,borderRadius:6,padding:'20px 22px',fontFamily:ES.F1,color:T.ink,
      boxShadow:'0 1px 0 rgba(255,255,255,0.4) inset, 0 8px 24px rgba(0,0,0,0.07)'}}>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
        <ESEyebrow T={T} mb={0}>Inbox &amp; routing</ESEyebrow>
        <span style={{marginLeft:'auto'}}><ESPill T={T} s={CAT[e.cat][0]} dot={false}>{e.cat}</ESPill></span>
      </div>
      <div style={{display:'flex',gap:10,alignItems:'flex-start'}}>
        <div style={{width:30,height:30,borderRadius:'50%',background:T.ink,display:'flex',alignItems:'center',justifyContent:'center',flex:'0 0 auto'}}>
          <ESMark size={19} T={{...T, ink:T.paper}}></ESMark>
        </div>
        <div style={{minWidth:0}}>
          <div style={{fontSize:11,color:T.ink3,fontFamily:ES.MONO,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{e.from}</div>
          <div style={{fontSize:13.5,fontWeight:600,lineHeight:1.35,marginTop:3}}>{e.subj}</div>
          <div style={{fontSize:11.5,color:T.ink4,lineHeight:1.5,marginTop:3}}>{e.pre}</div>
        </div>
      </div>
      {e.rec && (
        <div style={{marginTop:10,padding:'8px 10px',background:T.status.warn.bg,borderRadius:5,fontSize:11,lineHeight:1.5,color:T.status.warn.fg}}>
          <span style={{fontFamily:ES.MONO,fontSize:8.5,letterSpacing:'0.14em',textTransform:'uppercase',fontWeight:600}}>Recommended subject · </span>
          <span style={{color:T.ink2}}>{e.rec}</span>
        </div>)}
      <div style={{marginTop:12,borderTop:`1px solid ${T.hair}`}}>
        <R k="Trigger">{e.trig}</R>
        <R k="Recipient">{e.to}</R>
        <R k="Reply-to">{e.reply}</R>
        <R k="Status"><ESPill T={T} s={e.badge[0]}>{e.badge[1]}</ESPill></R>
        <R k="Primary CTA">{e.cta}{e.cta2 && <span style={{color:T.ink4}}> · 2nd: {e.cta2}</span>}</R>
        <R k="Motion">{e.motion}</R>
        <div style={{display:'flex',gap:12,padding:'7px 0',alignItems:'baseline'}}>
          <span style={{fontFamily:ES.MONO,fontSize:8.5,letterSpacing:'0.16em',textTransform:'uppercase',color:T.ink4,width:76,flex:'0 0 auto'}}>Footer</span>
          <span style={{fontSize:11.5,color:T.ink2}}>{FOOTL[e.foot]}</span>
        </div>
      </div>
    </div>);
}
function ESFlag({title='Product / engineering decision', children, w=380}){
  const T = MT;
  return (
    <div style={{width:w,boxSizing:'border-box',background:'#fbf5e6',border:'1.5px dashed #b98a2f',borderRadius:8,padding:'16px 18px',fontFamily:ES.F1}}>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
        <span style={{width:8,height:8,borderRadius:'50%',background:'#b98a2f',flex:'0 0 auto'}}></span>
        <span style={{fontFamily:ES.MONO,fontSize:9,letterSpacing:'0.2em',textTransform:'uppercase',color:'#7a5a1f',fontWeight:600}}>{title}</span>
      </div>
      <div style={{fontSize:12.5,lineHeight:1.6,color:'#4a4436'}}>{children}</div>
      <div style={{marginTop:10,fontSize:10.5,color:'#8a7a55',fontStyle:'italic'}}>Not solved visually — flagged for product/engineering. The design assumes nothing that doesn’t exist.</div>
    </div>);
}
function ESStrip({kind='latent', children, w=600}){
  const c = kind==='concept'?{fg:'#5b4a78',bg:'#eae4f1',label:'Recommended new email — not currently live'}:{fg:'#7a5a1f',bg:'#f0e7d2',label:'Designed — engineering dispatch decision required'};
  return (
    <div style={{width:w,boxSizing:'border-box',marginBottom:10,padding:'9px 14px',background:c.bg,border:`1.5px dashed ${c.fg}88`,borderRadius:6,
      display:'flex',alignItems:'center',gap:10,fontFamily:ES.MONO,fontSize:9.5,letterSpacing:'0.16em',textTransform:'uppercase',color:c.fg,fontWeight:600}}>
      <span style={{width:7,height:7,borderRadius:'50%',background:c.fg}}></span>{children||c.label}
    </div>);
}
// artboard style: auto-height card (declared height only guides focus-mode scaling)
const esA = (bg='#f6f4ef', extra={}) => ({height:'auto', background:bg, ...extra});
Object.assign(window, {ESMetaCard, ESFlag, ESStrip, esA});
