// Design-system board: palette, type, shape, components, footers, dark-mode rules.
const ST = ES.TH.light, SD = ES.TH.dark;
function Board({children, pad=24, bg=ST.paper, w}){
  return <div style={{width:w,boxSizing:'border-box',background:bg,padding:pad,fontFamily:ES.F1,color:ST.ink}}>{children}</div>;
}
function BoardTitle({children, sub, T=ST}){
  return <div style={{marginBottom:18}}><ESEyebrow T={T} mb={4}>{children}</ESEyebrow>{sub && <div style={{fontSize:12,color:T.ink3,lineHeight:1.5}}>{sub}</div>}</div>;
}
function Swatch({name, val, fg, T=ST}){
  return (
    <div style={{display:'flex',alignItems:'center',gap:10}}>
      <span style={{width:34,height:34,borderRadius:8,background:val,border:`1px solid ${T.hair}`,flex:'0 0 auto',
        display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,fontWeight:600,color:fg||'transparent'}}>{fg?'Aa':''}</span>
      <div style={{minWidth:0}}>
        <div style={{fontSize:11.5,fontWeight:600,color:T.ink}}>{name}</div>
        <div style={{fontFamily:ES.MONO,fontSize:9,color:T.ink4,marginTop:1}}>{val}</div>
      </div>
    </div>);
}
function PaletteBoard(){
  const surf = (T)=>[['desk',T.desk],['paper / card',T.paper],['sunk / elevated',T.sunk],['ink — text',T.ink],['ink-2 body',T.ink2],['ink-3 support',T.ink3],['ink-4 muted',T.ink4]];
  const stat = (T)=>['ok','info','warn','err','neutral','purple'].map(k=>({k,...T.status[k]}));
  const col = (T,label)=>(
    <div style={{flex:1,background:T.paper,border:`1px solid ${ST.hair}`,borderRadius:8,padding:18}}>
      <ESEyebrow T={T} mb={12} color={T.ink3}>{label}</ESEyebrow>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px 14px'}}>
        {surf(T).map(s=><Swatch key={s[0]} name={s[0]} val={s[1]} T={T}></Swatch>)}
      </div>
      <div style={{margin:'16px 0 10px',borderTop:`1px solid ${T.hair}`}}></div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'10px 14px'}}>
        {stat(T).map(s=>(
          <div key={s.k} style={{display:'flex',alignItems:'center',gap:8}}>
            <ESPill T={T} s={s.k} dot>{s.k}</ESPill>
            <span style={{fontFamily:ES.MONO,fontSize:8.5,color:T.ink4}}>{s.fg}</span>
          </div>))}
        <div style={{display:'flex',alignItems:'center',gap:8}}><ESPill T={T} s="sec">security</ESPill><span style={{fontFamily:ES.MONO,fontSize:8.5,color:T.ink4}}>outlined ink</span></div>
      </div>
    </div>);
  return (
    <Board w={880}>
      <BoardTitle sub="Warm paper + carved ink, one hue per meaning. Status colors are muted and paper-tinted — the fg/bg pairs hold ≥4.5:1 on both modes.">Color tokens · light & dark</BoardTitle>
      <div style={{display:'flex',gap:16}}>{col(ST,'Light')}{col(SD,'Dark')}</div>
    </Board>);
}
function TypeBoard(){
  const demo = {
    'Eyebrow': <ESEyebrow T={ST} mb={0}>Order update</ESEyebrow>,
    'Hero headline': <span style={{fontSize:32,fontWeight:500,letterSpacing:'-0.03em',lineHeight:1.1}}>WO-04292026 is approved.</span>,
    'Headline serif turn': <span style={{fontSize:32,fontFamily:ES.SERIF,fontStyle:'italic',color:ST.ink3}}>Packing starts now.</span>,
    'Section heading': <span style={{fontSize:16,fontWeight:600,letterSpacing:'-0.01em'}}>Needs action</span>,
    'Body': <span style={{fontSize:14.5,lineHeight:1.55,color:ST.ink2}}>We’ve reserved every unit on this request.</span>,
    'Supporting': <span style={{fontSize:12.5,color:ST.ink3}}>Approval usually lands within one business day.</span>,
    'Status pill': <ESPill T={ST} s="ok">Approved</ESPill>,
    'Button': <span style={{fontSize:13.5,fontWeight:500}}>Track this order →</span>,
    'Big operational number': <span style={{fontSize:30,fontWeight:600,letterSpacing:'-0.02em'}}>46</span>,
    'Order number': <span style={{fontFamily:ES.MONO,fontSize:10.5}}>ISR-CVW-MANCHESTER-04292026</span>,
    'Date / time': <span style={{fontSize:12.5,color:ST.ink3}}>Apr 29, 2:12 PM PT</span>,
    'Table heading': <span style={{fontFamily:ES.MONO,fontSize:9,letterSpacing:'0.18em',textTransform:'uppercase',color:ST.ink3}}>Item · SKU · Qty</span>,
    'Table value': <span style={{fontSize:12.5}}>Insulated Bottle 24 oz</span>,
    'Caption / legal': <span style={{fontSize:11,color:ST.ink4}}>You’re getting this because…</span>,
  };
  return (
    <Board w={760}>
      <BoardTitle sub="Space Grotesk carries the system; JetBrains Mono is the operational voice (IDs, eyebrows, tables); Tinos italic turns the headline. Stacks degrade to Helvetica/Arial · Courier New · Georgia when webfonts fail.">Typography</BoardTitle>
      <div style={{border:`1px solid ${ST.hair}`,borderRadius:8,overflow:'hidden'}}>
        {ES.SPEC.type.map((t,i)=>(
          <div key={t[0]} style={{display:'grid',gridTemplateColumns:'320px 1fr 1fr 90px',gap:14,alignItems:'center',padding:'11px 16px',
            borderBottom:i<ES.SPEC.type.length-1?`1px solid ${ST.hair}`:'none',background:i%2?ST.raise:'transparent'}}>
            <div style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{demo[t[0]]||<span style={{fontSize:12}}>{t[0]}</span>}</div>
            <span style={{fontFamily:ES.MONO,fontSize:9.5,color:ST.ink3}}>{t[1]}</span>
            <span style={{fontFamily:ES.MONO,fontSize:9.5,color:ST.ink3}}>{t[2]}</span>
            <span style={{fontFamily:ES.MONO,fontSize:9.5,color:ST.ink4}}>{t[3]}</span>
          </div>))}
      </div>
    </Board>);
}
function ShapeBoard(){
  const P = ES.SPEC.pad, R = ES.SPEC.radius;
  const chip = (label,val)=>(
    <div key={label} style={{display:'flex',justifyContent:'space-between',gap:10,padding:'8px 0',borderBottom:`1px solid ${ST.hair}`,fontSize:12}}>
      <span style={{color:ST.ink3}}>{label}</span><span style={{fontFamily:ES.MONO,fontSize:10.5,color:ST.ink}}>{val}</span>
    </div>);
  return (
    <Board w={560}>
      <BoardTitle sub="One card radius, one button radius, hairline borders everywhere. No shadows inside the email body — borders carry elevation (shadow fails or muddies in most clients).">Spacing · shape · layout</BoardTitle>
      <div style={{display:'flex',gap:20,marginBottom:16}}>
        {[['Button',R.btn],['Card',R.card],['Hero',R.hero],['Pill',R.pill]].map(r=>(
          <div key={r[0]} style={{textAlign:'center'}}>
            <div style={{width:64,height:44,borderRadius:Math.min(r[1],22),border:`1.5px solid ${ST.ink2}`,background:ST.sunk}}></div>
            <div style={{fontFamily:ES.MONO,fontSize:9,color:ST.ink4,marginTop:6}}>{r[0]} · {r[1]}px</div>
          </div>))}
      </div>
      {chip('Email width — desktop', `${ES.SPEC.width}px (max 640)`)}
      {chip('Mobile breakpoint / mockup width', `${ES.SPEC.mobileBp}px / ${ES.SPEC.mobileWidth}px`)}
      {chip('Outer padding — desktop / mobile', `${P.desktopX}px / ${P.mobileX}px`)}
      {chip('Header · hero top · section gap', `${P.headerY} · ${P.heroTop} · ${P.section}px`)}
      {chip('Card padding · row gap', `${P.card}px · ${P.rowGap}px`)}
      {chip('Button height (tap target)', `${ES.SPEC.btnH}px min`)}
      {chip('Border', '1px solid hair (12% ink / 13% paper)')}
    </Board>);
}
function ComponentsBoard(){
  const G = ({label, children})=>(
    <div style={{marginBottom:18}}>
      <ESEyebrow T={ST} mb={8}>{label}</ESEyebrow>{children}
    </div>);
  return (
    <Board w={640}>
      <BoardTitle sub="Every email composes from this kit — no template owns private UI.">Core components</BoardTitle>
      <G label="Status pills — semantic variants">
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          <ESPill T={ST} s="ok">Approved</ESPill><ESPill T={ST} s="info">In transit</ESPill><ESPill T={ST} s="warn">Partially fulfilled</ESPill>
          <ESPill T={ST} s="err">Overdue · 4 days</ESPill><ESPill T={ST} s="neutral">Cancelled</ESPill><ESPill T={ST} s="purple">Preview</ESPill><ESPill T={ST} s="sec">Security</ESPill>
        </div>
      </G>
      <G label="Buttons & links">
        <div style={{display:'flex',gap:14,alignItems:'center',flexWrap:'wrap'}}>
          <ESBtn T={ST}>Primary action →</ESBtn><ESBtn T={ST} ghost>Secondary</ESBtn>
          <a href="#" style={{fontSize:13,color:ST.ink2,textDecoration:'underline',textUnderlineOffset:3}}>Text link</a>
        </div>
        <div style={{fontSize:11,color:ST.ink4,marginTop:8}}>One primary CTA per email. Buttons go full-width under 620px. 44px min height.</div>
      </G>
      <G label="Banners">
        <div style={{display:'grid',gap:8}}>
          <ESBanner T={ST} s="ok" title="All clear.">Nothing needs your attention this week.</ESBanner>
          <ESBanner T={ST} s="warn" title="Signature required at the dock office">Whoever picks up signs against the work-order ID.</ESBanner>
          <ESBanner T={ST} s="err" title="Reason — from D. Reyes · Regional ops">Quarterly budget cap reached for CVW — Manchester.</ESBanner>
        </div>
      </G>
      <G label="Detail grid · rows">
        <ESDetailGrid T={ST} rows={[['Order','WO-04292026','ISR-CVW-MANCHESTER-04292026','mono'],['Contents','46 units · 5 lines','Ships from DCIV — Fresno']]}></ESDetailGrid>
      </G>
      <G label="Item table — with per-line status">
        <ESItemTable T={ST} items={ES.W.items.slice(0,3)} tagOf={(it)=>it.sku==='DRK-BTL-024'?['warn','8 backordered']:['ok','Delivered']}></ESItemTable>
      </G>
      <G label="Order timeline — done · current (pulsing) · upcoming · terminal">
        <div style={{display:'grid',gap:16}}>
          <ESTimeline T={ST} tone="ok" steps={[['Received','done'],['Approved','now'],['Packing','todo'],['Ready','todo'],['In transit','todo'],['Delivered','todo']]}></ESTimeline>
          <ESTimeline T={ST} tone="err" steps={[['Received','done'],['Review','done'],['Not approved','stop']]}></ESTimeline>
        </div>
        <div style={{fontSize:11,color:ST.ink4,marginTop:8}}>Only stages that apply to the actual workflow render — completed stages are never faked.</div>
      </G>
      <G label="Hero slot — sunk panel, motion asset or static frame">
        <ESHeroBox T={ST} h={110}><HeroRoute T={ST}></HeroRoute></ESHeroBox>
      </G>
    </Board>);
}
function FootersBoard(){
  const F = ({label, kind, reason})=>(
    <div style={{marginBottom:16}}>
      <ESEyebrow T={ST} mb={6}>{label}</ESEyebrow>
      <div style={{border:`1px solid ${ST.hair}`,borderRadius:6,overflow:'hidden'}}>
        <ESFooter T={ST} kind={kind} reason={reason}></ESFooter>
      </div>
    </div>);
  return (
    <Board w={640}>
      <BoardTitle sub="Four footers, matched to the catalog’s real preference behavior — no fake unsubscribe on essential mail, no jargon for external recipients.">Footer variants</BoardTitle>
      <F label="Essential transactional — security, invites, confirmations, receipts" kind="ess" reason="Sent to branden574@gmail.com because a password reset was requested for this account."></F>
      <F label="Preference-controlled — order status, schedule, digest" kind="pref" reason="Order-status updates for requests placed by branden574@gmail.com."></F>
      <F label="External recipient — portal invite, signer receipt" kind="ext" reason="You’re receiving this because L4L North Region uses StockPilot to run their supplier portal. No StockPilot account is required."></F>
      <F label="Internal — support tickets" kind="int" reason="Routed to the support queue by ticket rules (High → immediate)."></F>
    </Board>);
}
function DarkBoard(){
  const rules = [
    ['Logo','The carved-S mark is a single ink shape — it flips to paper on dark. Both PNGs shipped; never rely on client inversion.'],
    ['Cream surfaces','Paper #f6f4ef never inverts to muddy brown: dark tokens repaint surfaces (#161617 card on #060607 desk) instead of filtering.'],
    ['Status meaning','Each status keeps its hue family — fg lightens, bg deepens. Approved stays green in both modes.'],
    ['Buttons','Primary flips ink↔paper. Ghost keeps a 26% hairline. Both hold ≥4.5:1.'],
    ['Gmail/Outlook auto-invert','Critical text sits on solid token backgrounds (not transparent) so partial inversion can’t strand it. Hero assets get 2px safe transparent edges.'],
    ['Images','Motion assets are ink-line on transparent; the sunk panel behind them repaints per mode, so one asset serves both when weight matters.'],
  ];
  const sample = (T)=>(
    <div style={{flex:1,background:T.desk,borderRadius:8,padding:16}}>
      <div style={{background:T.paper,borderRadius:6,padding:16,border:`1px solid ${T.hair}`}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10}}><ESMark size={18} T={T}></ESMark><ESWordmark size={13} T={T}></ESWordmark></div>
        <ESPill T={T} s="ok">Approved</ESPill>
        <div style={{fontSize:19,fontWeight:500,letterSpacing:'-0.02em',color:T.ink,margin:'10px 0 4px'}}>WO-04292026 is approved.</div>
        <div style={{fontSize:15,fontFamily:ES.SERIF,fontStyle:'italic',color:T.ink3,marginBottom:10}}>Packing starts now.</div>
        <ESBtn T={T}>Track this order →</ESBtn>
      </div>
    </div>);
  return (
    <Board w={880}>
      <BoardTitle sub="Strategy for clients that respect dark CSS, auto-invert, partially invert, or ignore dark mode entirely.">Dark mode</BoardTitle>
      <div style={{display:'flex',gap:14,marginBottom:18}}>{sample(ST)}{sample(SD)}</div>
      <div style={{border:`1px solid ${ST.hair}`,borderRadius:8,overflow:'hidden'}}>
        {rules.map((r,i)=>(
          <div key={i} style={{display:'grid',gridTemplateColumns:'170px 1fr',gap:14,padding:'11px 16px',borderBottom:i<rules.length-1?`1px solid ${ST.hair}`:'none',background:i%2?ST.raise:'transparent'}}>
            <span style={{fontSize:12,fontWeight:600,color:ST.ink}}>{r[0]}</span>
            <span style={{fontSize:12,lineHeight:1.55,color:ST.ink3}}>{r[1]}</span>
          </div>))}
      </div>
    </Board>);
}
function BrandStripBoard(){
  return (
    <Board w={640}>
      <BoardTitle sub="Every email opens with the same 60px strip: mark + wordmark left, mono category tag right. The tag is the recipient’s instant answer to “what is this about?”">Email shell · brand strip</BoardTitle>
      <div style={{display:'grid',gap:10}}>
        {['Security','Order Update','Rental','Weekly Digest','Supplier Portal','Internal'].map(tag=>(
          <div key={tag} style={{border:`1px solid ${ST.hair}`,borderRadius:6,overflow:'hidden'}}>
            <div style={{padding:'14px 20px',display:'flex',alignItems:'center',gap:10,background:ST.paper}}>
              <ESMark size={20} T={ST}></ESMark><ESWordmark size={14} T={ST}></ESWordmark>
              <span style={{marginLeft:'auto',fontFamily:ES.MONO,fontSize:9,letterSpacing:'0.22em',textTransform:'uppercase',color:ST.ink4}}>{tag}</span>
            </div>
          </div>))}
      </div>
    </Board>);
}
if (window.ES_MOUNT === 'system'){
  function App(){
    return (
      <DesignCanvas>
        <DCSection id="tokens" title="Tokens" subtitle="Color · typography · spacing & shape — the email-specific StockPilot token set">
          <DCArtboard id="palette" label="Color — light & dark" width={880} height={560} style={esA()}><PaletteBoard></PaletteBoard></DCArtboard>
          <DCArtboard id="type" label="Typography" width={760} height={760} style={esA()}><TypeBoard></TypeBoard></DCArtboard>
          <DCArtboard id="shape" label="Spacing · shape" width={560} height={520} style={esA()}><ShapeBoard></ShapeBoard></DCArtboard>
        </DCSection>
        <DCSection id="kit" title="Component Kit" subtitle="Shared parts every template composes from · semantic variants, not per-email layouts">
          <DCArtboard id="components" label="Pills · buttons · banners · tables · timeline" width={640} height={1330} style={esA()}><ComponentsBoard></ComponentsBoard></DCArtboard>
          <DCArtboard id="footers" label="Footer variants ×4" width={640} height={1010} style={esA()}><FootersBoard></FootersBoard></DCArtboard>
          <DCArtboard id="strip" label="Brand strip + category tags" width={640} height={560} style={esA()}><BrandStripBoard></BrandStripBoard></DCArtboard>
        </DCSection>
        <DCSection id="dark" title="Dark Mode" subtitle="Token repaint, not inversion — with client-quirk rules">
          <DCArtboard id="darkboard" label="Side-by-side + rules" width={880} height={780} style={esA()}><DarkBoard></DarkBoard></DCArtboard>
        </DCSection>
      </DesignCanvas>);
  }
  ReactDOM.createRoot(document.getElementById('root')).render(<App></App>);
}
