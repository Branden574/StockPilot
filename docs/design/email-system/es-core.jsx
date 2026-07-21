// StockPilot Email System — shared email components. All take T (theme) + M (mobile).
const {F1, MONO, SERIF} = ES;
const TL = ES.TH.light;

function ESMark({size=22, T=TL}){
  const id = React.useId().replace(/:/g,'');
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={{display:'block',flex:'0 0 auto'}}>
      <defs><mask id={`esm${id}`} maskUnits="userSpaceOnUse">
        <rect width="100" height="100" fill="white"></rect>
        <path d="M 32 78 Q 72 78 72 66 Q 72 54 54 54 Q 32 54 32 42 Q 32 24 72 24" stroke="black" strokeWidth="11" strokeLinecap="round" fill="none"></path>
        <circle cx="72" cy="24" r="6" fill="black"></circle>
      </mask></defs>
      <rect x="12" y="12" width="76" height="76" rx="16" fill={T.ink} mask={`url(#esm${id})`}></rect>
    </svg>);
}
function ESWordmark({size=15, T=TL}){
  return <span style={{fontFamily:F1,fontWeight:600,fontSize:size,letterSpacing:'-0.025em',lineHeight:1,whiteSpace:'nowrap',color:T.ink}}>Stock<span style={{fontWeight:500,opacity:0.6}}>Pilot</span></span>;
}
function ESEyebrow({children, T=TL, size=9, mb=6, color}){
  return <div style={{fontFamily:MONO,fontSize:size,letterSpacing:'0.22em',textTransform:'uppercase',color:color||T.ink4,marginBottom:mb,fontWeight:500}}>{children}</div>;
}
function ESPill({s='ok', children, T=TL, dot=true}){
  const c = T.status[s]||T.status.neutral;
  return (
    <span style={{display:'inline-flex',alignItems:'center',gap:6,padding:'4px 10px',background:c.bg,borderRadius:999,
      border:c.line?`1px solid ${c.line}`:'1px solid transparent',
      fontFamily:MONO,fontSize:10,letterSpacing:'0.18em',textTransform:'uppercase',color:c.fg,fontWeight:600,whiteSpace:'nowrap'}}>
      {dot && <span style={{width:6,height:6,borderRadius:'50%',background:c.fg,flex:'0 0 auto'}}></span>}{children}
    </span>);
}
function ESFrame({T=TL, M=false, tag='', children, shadow=true}){
  return (
    <div style={{width:M?375:600,background:T.paper,color:T.ink,fontFamily:F1,borderRadius:6,overflow:'hidden',
      boxShadow:shadow?(T.name==='dark'?'0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(246,244,239,0.07)':'0 1px 0 rgba(255,255,255,0.4) inset, 0 12px 40px rgba(0,0,0,0.10)'):'none'}}>
      <div style={{padding:M?'16px 24px':'20px 36px',display:'flex',alignItems:'center',gap:M?10:12,borderBottom:`1px solid ${T.hair}`}}>
        <ESMark size={M?20:22} T={T}></ESMark><ESWordmark size={M?14:15} T={T}></ESWordmark>
        <span style={{marginLeft:'auto',fontFamily:MONO,fontSize:M?8.5:9.5,letterSpacing:'0.22em',textTransform:'uppercase',color:T.ink4,whiteSpace:'nowrap'}}>{tag}</span>
      </div>
      {children}
    </div>);
}
// Section wrapper with standard horizontal padding
function ESPad({T=TL, M=false, top=0, bottom=28, children, style}){
  return <div style={{padding:`${top}px ${M?24:36}px ${bottom}px`,...style}}>{children}</div>;
}
function ESH1({T=TL, M=false, children, sub}){
  return (
    <h1 style={{margin:'18px 0 14px',fontSize:M?24:32,lineHeight:1.12,letterSpacing:'-0.03em',fontWeight:500,color:T.ink}}>
      {children}{sub && <React.Fragment><br></br><span style={{color:T.ink3,fontFamily:SERIF,fontStyle:'italic',fontWeight:400}}>{sub}</span></React.Fragment>}
    </h1>);
}
function ESBody({T=TL, M=false, children, style}){
  return <p style={{margin:0,fontSize:M?13.5:14.5,lineHeight:1.55,color:T.ink2,maxWidth:480,...style}}>{children}</p>;
}
function ESBtn({T=TL, M=false, children, ghost=false}){
  return (
    <a href="#" style={{display:M?'flex':'inline-flex',alignItems:'center',justifyContent:M?'center':'flex-start',gap:8,
      padding:'13px 18px',minHeight:18,boxSizing:'border-box',
      background:ghost?'transparent':T.btnBg,color:ghost?T.ink:T.btnFg,
      border:ghost?`1px solid ${T.hair2}`:'1px solid transparent',
      borderRadius:6,fontSize:13.5,fontWeight:500,textDecoration:'none',whiteSpace:'nowrap'}}>{children}</a>);
}
function ESCTARow({T=TL, M=false, primary, secondary, note}){
  return (
    <div>
      <div style={{display:'flex',flexDirection:M?'column':'row',alignItems:M?'stretch':'center',gap:M?10:14,flexWrap:'wrap'}}>
        <ESBtn T={T} M={M}>{primary} <span style={{marginTop:-1}}>→</span></ESBtn>
        {secondary && (M
          ? <ESBtn T={T} M={M} ghost>{secondary}</ESBtn>
          : <a href="#" style={{fontSize:13,color:T.ink2,textDecoration:'underline',textUnderlineOffset:3}}>{secondary}</a>)}
      </div>
      {note && <div style={{marginTop:12,fontSize:11.5,color:T.ink3,lineHeight:1.55}}>{note}</div>}
    </div>);
}
function ESLinkFallback({T=TL, url}){
  return (
    <div style={{marginTop:14,fontSize:11.5,color:T.ink3,lineHeight:1.55}}>
      Or paste this link into your browser:{' '}
      <span style={{fontFamily:MONO,fontSize:10.5,color:T.ink2,wordBreak:'break-all'}}>{url}</span>
    </div>);
}
function ESCard({T=TL, children, pad='18px 20px', style, tone}){
  const c = tone?T.status[tone]:null;
  return <div style={{border:`1px solid ${c?c.fg+'33':T.hair}`,background:c?c.bg:'transparent',borderRadius:6,padding:pad,...style}}>{children}</div>;
}
function ESDetailGrid({T=TL, M=false, rows=[], cols=2, style}){
  return (
    <ESCard T={T} style={{display:'grid',gridTemplateColumns:`repeat(${M?Math.min(cols,2):cols}, 1fr)`,gap:'16px 20px',...style}}>
      {rows.map((r,i)=>(
        <div key={i} style={{minWidth:0}}>
          <ESEyebrow T={T} mb={5}>{r[0]}</ESEyebrow>
          <div style={{fontSize:13.5,fontWeight:600,color:T.ink,lineHeight:1.3,overflowWrap:'break-word'}}>{r[1]}</div>
          {r[2] && <div style={{fontSize:11.5,color:T.ink3,marginTop:3,fontFamily:r[3]==='mono'?MONO:F1,...(r[3]==='mono'?{fontSize:10}:{})}}>{r[2]}</div>}
        </div>))}
    </ESCard>);
}
function ESRow({T=TL, k, v, strong=false, last=false}){
  return (
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:16,padding:'9px 0',borderBottom:last?'none':`1px solid ${T.hair}`}}>
      <span style={{fontSize:12,color:T.ink3,flex:'0 0 auto'}}>{k}</span>
      <span style={{fontSize:12.5,color:T.ink,fontWeight:strong?600:400,textAlign:'right'}}>{v}</span>
    </div>);
}
function ESItemTable({T=TL, M=false, items, tagOf, totalLabel, totalValue}){
  return (
    <div style={{border:`1px solid ${T.hair}`,borderRadius:6,overflow:'hidden'}}>
      <div style={{display:'flex',padding:'8px 14px',background:T.sunk,borderBottom:`1px solid ${T.hair}`,
        fontFamily:MONO,fontSize:9,letterSpacing:'0.18em',textTransform:'uppercase',color:T.ink3,fontWeight:500}}>
        <span style={{flex:1}}>Item</span>{!M && <span style={{width:110}}>SKU</span>}<span style={{width:tagOf?110:36,textAlign:'right'}}>{tagOf?'Status':'Qty'}</span>
      </div>
      {items.map((it,i)=>(
        <div key={i} style={{display:'flex',alignItems:'center',padding:'10px 14px',gap:10,borderBottom:i<items.length-1||totalLabel?`1px solid ${T.hair}`:'none'}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:12.5,color:T.ink,fontWeight:500,lineHeight:1.3}}>{it.name}{tagOf && <span style={{color:T.ink4,fontWeight:400}}> · ×{it.qty}</span>}</div>
            {M && <div style={{fontFamily:MONO,fontSize:9.5,color:T.ink4,marginTop:2}}>{it.sku}</div>}
          </div>
          {!M && <span style={{width:110,fontFamily:MONO,fontSize:10,color:T.ink4}}>{it.sku}</span>}
          {tagOf
            ? <span style={{width:110,textAlign:'right'}}><ESPill T={T} s={tagOf(it)[0]} dot={false}>{tagOf(it)[1]}</ESPill></span>
            : <span style={{width:36,textAlign:'right',fontSize:12.5,fontWeight:600,color:T.ink}}>{it.qty}</span>}
        </div>))}
      {totalLabel && (
        <div style={{display:'flex',justifyContent:'space-between',padding:'10px 14px',background:T.sunk}}>
          <span style={{fontFamily:MONO,fontSize:9.5,letterSpacing:'0.18em',textTransform:'uppercase',color:T.ink3,fontWeight:500}}>{totalLabel}</span>
          <span style={{fontSize:12.5,fontWeight:600,color:T.ink}}>{totalValue}</span>
        </div>)}
    </div>);
}
// steps: [label, 'done'|'now'|'todo'|'stop'][] — stop = terminal denied/cancelled
function ESTimeline({T=TL, M=false, steps, tone='ok'}){
  const c = T.status[tone];
  return (
    <div style={{display:'flex',alignItems:'flex-start'}}>
      {steps.map(([label,st],i)=>{
        const done = st==='done', now = st==='now', stop = st==='stop';
        const dotC = stop?T.status.err.fg : done||now?c.fg : 'transparent';
        return (
          <React.Fragment key={i}>
            {i>0 && <div style={{flex:1,height:1,background:done||now||stop?c.fg:T.hair,opacity:done||now||stop?0.5:1,marginTop:5,minWidth:M?8:14}}></div>}
            <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:6,flex:'0 0 auto',maxWidth:M?56:76}}>
              <span className={now?'es-nowdot':''} style={{width:11,height:11,borderRadius:'50%',boxSizing:'border-box',background:dotC,
                border:`1.5px solid ${stop?T.status.err.fg:done||now?c.fg:T.hair2}`,position:'relative',
                boxShadow:now?`0 0 0 3px ${c.bg}`:'none'}}></span>
              <span style={{fontFamily:MONO,fontSize:M?7.5:8.5,letterSpacing:'0.08em',textTransform:'uppercase',textAlign:'center',lineHeight:1.35,
                color:stop?T.status.err.fg:now?c.fg:done?T.ink3:T.ink4,fontWeight:now||stop?600:400}}>{label}</span>
            </div>
          </React.Fragment>);
      })}
    </div>);
}
function ESBanner({T=TL, s='info', title, children, style}){
  const c = T.status[s];
  return (
    <div style={{background:c.bg,border:`1px solid ${c.fg}2e`,borderRadius:6,padding:'14px 16px',...style}}>
      {title && <div style={{fontSize:12.5,fontWeight:600,color:c.fg,marginBottom:children?4:0}}>{title}</div>}
      {children && <div style={{fontSize:12,lineHeight:1.55,color:T.ink2}}>{children}</div>}
    </div>);
}
function ESAvatar({initials, size=44, T=TL}){
  return (
    <div style={{width:size,height:size,borderRadius:'50%',background:'linear-gradient(140deg, #d8c9a8 0%, #b89b6a 100%)',
      color:'#0c0c0e',display:'inline-flex',alignItems:'center',justifyContent:'center',fontFamily:F1,fontWeight:600,
      fontSize:size*0.36,letterSpacing:'-0.01em',boxShadow:`0 0 0 3px ${T.paper}, 0 0 0 4px ${T.hair}`,flex:'0 0 auto'}}>{initials}</div>);
}
function ESHeroBox({T=TL, M=false, children, h=150, style}){
  return (
    <div style={{height:h,background:T.sunk,borderRadius:8,border:`1px solid ${T.hair}`,display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden',...style}}>
      {children}
    </div>);
}
function ESHelp({T=TL, M=false, children}){
  return (
    <div style={{display:'flex',gap:12,alignItems:'flex-start',borderTop:`1px solid ${T.hair}`,paddingTop:16}}>
      <div style={{width:26,height:26,borderRadius:8,background:T.sunk,border:`1px solid ${T.hair}`,display:'flex',alignItems:'center',justifyContent:'center',
        fontFamily:SERIF,fontStyle:'italic',fontSize:14,color:T.ink3,flex:'0 0 auto'}}>?</div>
      <div style={{fontSize:12,lineHeight:1.55,color:T.ink3}}>{children}</div>
    </div>);
}
const ES_FOOT_NOTES = {
  ess:'Security and account emails are sent whenever this activity happens — they keep your account safe and can\u2019t be unsubscribed.',
  pref:'Unsubscribing stops this notification type only — security and account emails still arrive.',
  ext:'', int:'',
};
function ESFooter({T=TL, M=false, kind='pref', reason, links}){
  const A = ({children})=><a href="#" style={{color:T.ink2,textDecoration:'underline',textUnderlineOffset:2}}>{children}</a>;
  const defLinks = {
    ess:[['Support'],['Privacy'],['Terms']],
    pref:[['Manage email preferences'],['Unsubscribe'],['Support']],
    ext:[['Contact the sender'],['Support'],['Privacy']],
    int:[['Open support console'],['Routing rules']],
  }[kind];
  return (
    <div style={{padding:M?'16px 24px':'18px 36px',borderTop:`1px solid ${T.hair}`,background:T.sunk}}>
      {kind==='int' && (
        <div style={{display:'inline-block',marginBottom:10,padding:'3px 8px',border:`1px solid ${T.hair2}`,borderRadius:4,
          fontFamily:MONO,fontSize:8.5,letterSpacing:'0.2em',textTransform:'uppercase',color:T.ink3,fontWeight:600}}>Internal support notification</div>)}
      <div style={{fontSize:11,color:T.ink4,lineHeight:1.6}}>{reason} {ES_FOOT_NOTES[kind] && <span>{ES_FOOT_NOTES[kind]}</span>}</div>
      <div style={{marginTop:8,display:'flex',gap:14,flexWrap:'wrap',fontSize:11}}>
        {(links||defLinks).map((l,i)=><A key={i}>{l[0]}</A>)}
      </div>
      <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${T.hair}`,display:'flex',justifyContent:'space-between',gap:8,
        fontFamily:MONO,fontSize:M?8.5:9.5,letterSpacing:'0.18em',textTransform:'uppercase',color:T.ink4}}>
        <span>StockPilot · Inventory + Order Mgmt</span><span>stockpilotusa.com</span>
      </div>
    </div>);
}
// one-time keyframes for live previews (mockups only — production uses GIF/APNG)
if (!document.getElementById('es-anim-css')){
  const s = document.createElement('style'); s.id='es-anim-css';
  s.textContent = `
  .es-nowdot{animation:es-now 2.4s ease-in-out infinite}
  @keyframes es-now{0%,100%{transform:scale(1)}50%{transform:scale(1.25)}}
  @keyframes es-ring{0%{transform:scale(0.55);opacity:0.9}80%{transform:scale(1.5);opacity:0}100%{transform:scale(1.5);opacity:0}}
  @keyframes es-drop{0%{transform:translateY(-14px);opacity:0}60%{transform:translateY(2px);opacity:1}100%{transform:translateY(0);opacity:1}}
  @keyframes es-fadein{from{opacity:0}to{opacity:1}}
  @keyframes es-draw{to{stroke-dashoffset:0}}
  @keyframes es-travel{0%{transform:translateX(0)}45%,55%{transform:translateX(var(--es-tx,240px))}100%{transform:translateX(var(--es-tx2,480px))}}
  @keyframes es-march{to{stroke-dashoffset:-24px}}
  @keyframes es-scan{0%,100%{transform:translateX(-46px)}50%{transform:translateX(46px)}}
  @keyframes es-swing{0%,100%{transform:rotate(5deg)}50%{transform:rotate(-5deg)}}
  @keyframes es-rise{from{transform:scaleY(0.06)}to{transform:scaleY(1)}}
  @keyframes es-hand{0%{transform:rotate(0deg)}45%,100%{transform:rotate(80deg)}}
  @keyframes es-pop{0%{transform:scale(0.6);opacity:0}70%{transform:scale(1.06);opacity:1}100%{transform:scale(1)}}
  @keyframes es-blinkonce{0%,40%{opacity:0}60%,100%{opacity:1}}
  @media (prefers-reduced-motion: reduce){.es-anim *{animation:none !important}}
  `;
  document.head.appendChild(s);
}
Object.assign(window, {ESMark, ESWordmark, ESEyebrow, ESPill, ESFrame, ESPad, ESH1, ESBody, ESBtn, ESCTARow,
  ESLinkFallback, ESCard, ESDetailGrid, ESRow, ESItemTable, ESTimeline, ESBanner, ESAvatar, ESHeroBox, ESHelp, ESFooter});
