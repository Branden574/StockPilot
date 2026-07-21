// Email system hub — entry point linking every canvas, board, and reference template.
const BT = ES.TH.light;
const FAM_PILLS = {
  security:[['sec','Security']], invites:[['warn','Pending'],['purple','Portal']],
  orders:[['ok','Approved'],['err','Denied'],['info','In transit']], fulfillment:[['warn','Partial'],['ok','Delivered']],
  rentals:[['info','Checked out'],['err','Overdue']], schedule:[['info','Tomorrow'],['warn','1 hour']],
  digest:[['info','Briefing'],['purple','Preview']], support:[['err','High'],['neutral','Internal']],
};
const FAM_EXTRA = {orders:'includes 2 latent', support:'includes 2 concepts'};
function FamCard({f}){
  return (
    <a href={f.file} style={{display:'block',textDecoration:'none',color:BT.ink,background:BT.paper,border:`1px solid ${BT.hair}`,borderRadius:10,padding:'20px 22px',
      boxShadow:'0 1px 0 rgba(255,255,255,0.4) inset, 0 6px 20px rgba(0,0,0,0.05)',transition:'transform .15s, box-shadow .15s'}}
      onMouseEnter={(e)=>{e.currentTarget.style.transform='translateY(-2px)';e.currentTarget.style.boxShadow='0 1px 0 rgba(255,255,255,0.4) inset, 0 12px 30px rgba(0,0,0,0.09)';}}
      onMouseLeave={(e)=>{e.currentTarget.style.transform='none';e.currentTarget.style.boxShadow='0 1px 0 rgba(255,255,255,0.4) inset, 0 6px 20px rgba(0,0,0,0.05)';}}>
      <div style={{display:'flex',alignItems:'baseline',gap:10}}>
        <span style={{fontSize:16.5,fontWeight:600,letterSpacing:'-0.01em'}}>{f.name}</span>
        <span style={{marginLeft:'auto',fontFamily:ES.MONO,fontSize:10,color:BT.ink4}}>{f.count} email{f.count>1?'s':''}{FAM_EXTRA[f.id]?` · ${FAM_EXTRA[f.id]}`:''}</span>
      </div>
      <div style={{fontSize:12,color:BT.ink3,lineHeight:1.55,margin:'6px 0 14px'}}>{f.desc}</div>
      <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
        {FAM_PILLS[f.id].map((p,i)=><ESPill key={i} T={BT} s={p[0]} dot={false}>{p[1]}</ESPill>)}
        <span style={{marginLeft:'auto',fontFamily:ES.MONO,fontSize:11,color:BT.ink3}}>Open →</span>
      </div>
    </a>);
}
function ResCard({href, kicker, title, desc}){
  return (
    <a href={href} style={{display:'block',textDecoration:'none',color:BT.ink,background:BT.ink,borderRadius:10,padding:'18px 20px'}}
      onMouseEnter={(e)=>e.currentTarget.style.background='#1c1c1f'} onMouseLeave={(e)=>e.currentTarget.style.background=BT.ink}>
      <div style={{fontFamily:ES.MONO,fontSize:8.5,letterSpacing:'0.2em',textTransform:'uppercase',color:'rgba(246,244,239,0.55)',marginBottom:8}}>{kicker}</div>
      <div style={{fontSize:15,fontWeight:600,color:BT.paper,letterSpacing:'-0.01em'}}>{title}</div>
      <div style={{fontSize:11.5,color:'rgba(246,244,239,0.65)',lineHeight:1.55,marginTop:5}}>{desc}</div>
    </a>);
}
if (window.ES_MOUNT === 'hub'){
  const stats = [['24','live emails'],['2','latent · labeled'],['2','concepts · proposed'],['8','families'],['4','footer policies'],['13','motion assets']];
  const changed = [
    ['7 → 1','Classic white-card, cream one-off, login-alert, bare no-logo HTML, one-line schedule text, copied rental template, unstructured support mail — all replaced by one component system with semantic variants.'],
    ['Specific, not swapped','Every email states what happened, what it means, what to do, and what’s next — with its own status, motion level, and data. No heading-swap templates.'],
    ['Honest by design','Misleading copy removed, missing preferences flagged, latent templates labeled. Product and engineering decisions are named, never papered over.'],
  ];
  function App(){
    return (
      <div style={{minHeight:'100vh',background:BT.desk,fontFamily:ES.F1,color:BT.ink,padding:'56px 0 90px'}}>
        <div style={{maxWidth:1080,margin:'0 auto',padding:'0 32px'}}>
          <header style={{marginBottom:44}}>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:26}}>
              <ESMark size={28} T={BT}></ESMark><ESWordmark size={18} T={BT}></ESWordmark>
              <span style={{marginLeft:'auto',fontFamily:ES.MONO,fontSize:9.5,letterSpacing:'0.2em',textTransform:'uppercase',color:BT.ink4}}>Email design system · v1.0</span>
            </div>
            <ESEyebrow T={BT}>Calm operational control, visible forward movement</ESEyebrow>
            <h1 style={{margin:'10px 0 12px',fontSize:46,lineHeight:1.04,letterSpacing:'-0.03em',fontWeight:500,maxWidth:720}}>
              The StockPilot email system.<br></br>
              <span style={{fontFamily:ES.SERIF,fontStyle:'italic',color:BT.ink3,fontWeight:400}}>One voice, twenty-eight moments.</span>
            </h1>
            <p style={{margin:'0 0 22px',fontSize:14.5,lineHeight:1.6,color:BT.ink2,maxWidth:620}}>
              Every live email redesigned on the cream-and-ink foundation — plus the two latent order emails, two proposed support emails, full responsive and dark coverage, a motion system with real fallbacks, and a handoff spec engineering can build from directly.
            </p>
            <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
              {stats.map((s,i)=>(
                <div key={i} style={{background:BT.paper,border:`1px solid ${BT.hair}`,borderRadius:999,padding:'7px 14px',display:'flex',gap:7,alignItems:'baseline'}}>
                  <span style={{fontSize:14,fontWeight:600}}>{s[0]}</span>
                  <span style={{fontFamily:ES.MONO,fontSize:9,letterSpacing:'0.12em',textTransform:'uppercase',color:BT.ink4}}>{s[1]}</span>
                </div>))}
            </div>
          </header>
          <ESEyebrow T={BT} mb={12}>Email families — open a canvas</ESEyebrow>
          <div style={{display:'grid',gridTemplateColumns:'repeat(2, 1fr)',gap:14,marginBottom:40}}>
            {ES.FAMILIES.map(f=><FamCard key={f.id} f={f}></FamCard>)}
          </div>
          <ESEyebrow T={BT} mb={12}>System resources</ESEyebrow>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3, 1fr)',gap:14,marginBottom:14}}>
            <ResCard href="Emails - Design System.html" kicker="Foundation" title="Design-system board" desc="Tokens, type, shape, the component kit, footer policies, dark-mode rules."></ResCard>
            <ResCard href="Emails - Responsive.html" kicker="Coverage" title="Responsive & dark" desc="10 key emails × desktop/mobile × light/dark — 40 frames, one component each."></ResCard>
            <ResCard href="Emails - Motion.html" kicker="Motion" title="Motion board" desc="13 assets: live demos plus GIF/APNG specs, loops, first frames, Outlook fallbacks."></ResCard>
            <ResCard href="Emails - Handoff.html" kicker="Engineering" title="Handoff & audit" desc="Build constants, component contract, 28-row content matrix, policy audit."></ResCard>
            <ResCard href="email-system/templates/archetype-order-status.html" kicker="Reference HTML" title="Order-status archetype" desc="Email-safe table HTML with merge tags — the approved email, production-ready."></ResCard>
            <ResCard href="email-system/templates/archetype-security.html" kicker="Reference HTML" title="Security archetype" desc="Password reset in production markup; digest archetype linked inside."></ResCard>
          </div>
          <div style={{background:BT.paper,border:`1px solid ${BT.hair}`,borderRadius:10,padding:'22px 24px',marginBottom:40}}>
            <ESEyebrow T={BT} mb={12}>What changed</ESEyebrow>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3, 1fr)',gap:20}}>
              {changed.map((c,i)=>(
                <div key={i}>
                  <div style={{fontSize:15,fontWeight:600,letterSpacing:'-0.01em',marginBottom:6}}>{c[0]}</div>
                  <div style={{fontSize:12,lineHeight:1.6,color:BT.ink3}}>{c[1]}</div>
                </div>))}
            </div>
          </div>
          <footer style={{paddingTop:20,borderTop:`1px solid ${BT.hair}`,display:'flex',justifyContent:'space-between',
            fontFamily:ES.MONO,fontSize:9.5,letterSpacing:'0.18em',textTransform:'uppercase',color:BT.ink4}}>
            <span>StockPilot · Inventory + Order Mgmt</span><span>stockpilotusa.com</span>
          </footer>
        </div>
      </div>);
  }
  ReactDOM.createRoot(document.getElementById('root')).render(<App></App>);
}
