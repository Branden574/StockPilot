// Schedule reminders (tomorrow · 1 hour) + weekly digest + digest preview.
const DW = ES.W, EV = DW.event, DG = DW.digest;
function EventCard({T, M, compact=false}){
  return (
    <ESCard T={T} pad="0" style={{overflow:'hidden'}}>
      <div style={{display:'flex'}}>
        <div style={{width:72,background:T.sunk,borderRight:`1px solid ${T.hair}`,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'16px 0',flex:'0 0 auto'}}>
          <span style={{fontFamily:ES.MONO,fontSize:9,letterSpacing:'0.2em',textTransform:'uppercase',color:T.ink4}}>Jun</span>
          <span style={{fontSize:26,fontWeight:600,letterSpacing:'-0.02em',color:T.ink,lineHeight:1.1}}>11</span>
          <span style={{fontFamily:ES.MONO,fontSize:9,letterSpacing:'0.14em',textTransform:'uppercase',color:T.ink4}}>Thu</span>
        </div>
        <div style={{padding:'14px 18px',minWidth:0,flex:1}}>
          <div style={{fontSize:14.5,fontWeight:600,color:T.ink,lineHeight:1.3}}>{EV.title}</div>
          <div style={{fontSize:12,color:T.ink2,marginTop:4}}>{EV.start} – {EV.end} <span style={{color:T.ink4}}>{EV.tz}</span></div>
          <div style={{fontSize:11.5,color:T.ink3,marginTop:2}}>{EV.loc} · Assigned to {EV.assignee}</div>
        </div>
      </div>
      {!compact && <div style={{padding:'12px 18px',borderTop:`1px solid ${T.hair}`,fontSize:12,lineHeight:1.55,color:T.ink3}}>{EV.desc}</div>}
    </ESCard>);
}
function SchedTomorrowEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Schedule">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="info">Tomorrow</ESPill>
        <ESH1 T={T} M={M} sub="Tomorrow morning, 9 AM.">{EV.title}</ESH1>
        <ESBody T={T} M={M}>Hi {DW.invitee.name} — a day-ahead heads-up for your assigned event at <strong style={{fontWeight:600,color:T.ink}}>{EV.loc}</strong>. Details below; nothing to confirm.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}><ESHeroBox T={T} M={M} h={132}><HeroCalendar T={T}></HeroCalendar></ESHeroBox></ESPad>
      <ESPad T={T} M={M}><EventCard T={T} M={M}></EventCard></ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="Open schedule" note="Can’t make it? Reassign or decline from the schedule so coverage is visible to the team."></ESCTARow>
      </ESPad>
      <ESFooter T={T} M={M} kind="pref" reason={<span>Schedule reminders are on for {DW.invitee.email} — they’re preference-controlled.</span>}></ESFooter>
    </ESFrame>);
}
function SchedHourEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Schedule">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="warn">Starts in 1 hour</ESPill>
        <ESH1 T={T} M={M} sub="9:00 AM · Aisle 4.">Starting soon.</ESH1>
        <ESBody T={T} M={M}>Hi {DW.invitee.name} — <strong style={{fontWeight:600,color:T.ink}}>{EV.title}</strong> starts in an hour. Scanners are staged at the equipment cage.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}><ESHeroBox T={T} M={M} h={132}><HeroClock T={T} tone="warn"></HeroClock></ESHeroBox></ESPad>
      <ESPad T={T} M={M}><EventCard T={T} M={M} compact></EventCard></ESPad>
      <ESPad T={T} M={M}><ESCTARow T={T} M={M} primary="Open schedule"></ESCTARow></ESPad>
      <ESFooter T={T} M={M} kind="pref" reason={<span>Schedule reminders are on for {DW.invitee.email} — they’re preference-controlled.</span>}></ESFooter>
    </ESFrame>);
}
function DigestEmail({T=ES.TH.light, M=false, preview=false, allClear=false}){
  return (
    <ESFrame T={T} M={M} tag="Weekly Digest">
      {preview && (
        <div style={{padding:M?'10px 24px':'10px 36px',background:T.status.purple.bg,borderBottom:`1px solid ${T.hair}`,display:'flex',gap:10,alignItems:'center'}}>
          <span style={{width:7,height:7,borderRadius:'50%',background:T.status.purple.fg,flex:'0 0 auto'}}></span>
          <span style={{fontSize:11.5,lineHeight:1.5,color:T.ink2}}><strong style={{fontWeight:600,color:T.status.purple.fg}}>Preview.</strong> Sent only to you — not the scheduled Monday digest.</span>
        </div>)}
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="info" dot={false}>{DG.range}</ESPill>
        <ESH1 T={T} M={M} sub="Monday briefing · two minutes.">Your week, in order.</ESH1>
        <ESBody T={T} M={M}>Hi {DW.user.name} — here’s what moved across <strong style={{fontWeight:600,color:T.ink}}>{DW.org}</strong> last week{allClear?'. It was a clean one.':', and the three things that need a hand.'}</ESBody>
      </ESPad>
      <ESPad T={T} M={M}><ESHeroBox T={T} M={M} h={120}><HeroBars T={T}></HeroBars></ESHeroBox></ESPad>
      <ESPad T={T} M={M}>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          {DG.kpis.map((k,i)=>(
            <ESCard key={i} T={T} pad="14px 16px">
              <ESEyebrow T={T} mb={5}>{k.k}</ESEyebrow>
              <div style={{fontSize:28,fontWeight:600,letterSpacing:'-0.02em',color:T.ink,lineHeight:1}}>{k.v}</div>
              <div style={{fontSize:11,color:T.ink3,marginTop:4}}>{k.d}</div>
            </ESCard>))}
        </div>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESEyebrow T={T} mb={10}>{allClear?'Exceptions':'Needs action'}</ESEyebrow>
        {allClear
          ? <ESBanner T={T} s="ok" title="All clear.">Nothing needs your attention this week — no stuck approvals, no low stock, no overdue rentals. See you next Monday.</ESBanner>
          : <ESCard T={T} pad="4px 18px">
              {DG.actions.map((a,i)=>(
                <div key={i} style={{display:'flex',gap:12,alignItems:'flex-start',padding:'12px 0',borderBottom:i<DG.actions.length-1?`1px solid ${T.hair}`:'none'}}>
                  <span style={{width:7,height:7,borderRadius:'50%',background:T.status[a.s].fg,marginTop:5,flex:'0 0 auto'}}></span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:600,color:T.ink,lineHeight:1.35}}>{a.t}</div>
                    <div style={{fontSize:11.5,color:T.ink3,marginTop:2}}>{a.d}</div>
                  </div>
                  <span style={{fontFamily:ES.MONO,fontSize:11,color:T.ink4,marginTop:2}}>→</span>
                </div>))}
            </ESCard>}
      </ESPad>
      <ESPad T={T} M={M}>
        <ESEyebrow T={T} mb={10}>This week</ESEyebrow>
        <ESCard T={T} pad="4px 18px">
          {DG.schedule.map((s,i)=>(
            <div key={i} style={{display:'flex',justifyContent:'space-between',gap:12,padding:'11px 0',borderBottom:i<DG.schedule.length-1?`1px solid ${T.hair}`:'none'}}>
              <span style={{fontSize:12.5,fontWeight:500,color:T.ink}}>{s.t}</span>
              <span style={{fontSize:11.5,color:T.ink3,textAlign:'right',flex:'0 0 auto'}}>{s.d}</span>
            </div>))}
        </ESCard>
      </ESPad>
      <ESPad T={T} M={M}><ESCTARow T={T} M={M} primary="Open dashboard"></ESCTARow></ESPad>
      <ESFooter T={T} M={M} kind="pref" reason={<span>The weekly digest goes to workspace members who opted in — Mondays at 7:00 AM workspace time.</span>}></ESFooter>
    </ESFrame>);
}
Object.assign(window, {SchedTomorrowEmail, SchedHourEmail, DigestEmail, EventCard});

if (window.ES_MOUNT === 'schedule'){
  const E = ES.byId;
  function App(){
    return (
      <DesignCanvas>
        <DCSection id="st" title="Reminder — Tomorrow" subtitle="Replaces the raw one-line HTML message · calendar card with date rail, full detail">
          <DCArtboard id="st-meta" label="Routing · subject · preheader" width={380} height={580} style={esA()}><ESMetaCard e={E('sched-tmrw')}></ESMetaCard></DCArtboard>
          <DCArtboard id="st-email" label="Tomorrow · desktop light" width={600} height={1080} style={esA()}><SchedTomorrowEmail></SchedTomorrowEmail></DCArtboard>
        </DCSection>
        <DCSection id="sh" title="Reminder — In 1 Hour" subtitle="More immediate, not alarming — amber state, compact event card, clock-hand motion">
          <DCArtboard id="sh-meta" label="Routing · subject · preheader" width={380} height={580} style={esA()}><ESMetaCard e={E('sched-hour')}></ESMetaCard></DCArtboard>
          <DCArtboard id="sh-email" label="One hour · desktop light" width={600} height={950} style={esA()}><SchedHourEmail></SchedHourEmail></DCArtboard>
        </DCSection>
      </DesignCanvas>);
  }
  ReactDOM.createRoot(document.getElementById('root')).render(<App></App>);
}
if (window.ES_MOUNT === 'digest'){
  const E = ES.byId;
  function App(){
    return (
      <DesignCanvas>
        <DCSection id="dg" title="Weekly Digest" subtitle="Executive Monday briefing — KPI cards, exceptions first, no dense tables">
          <DCArtboard id="dg-meta" label="Routing · subject · preheader" width={380} height={580} style={esA()}><ESMetaCard e={E('digest')}></ESMetaCard></DCArtboard>
          <DCArtboard id="dg-email" label="Weekly digest · desktop light" width={600} height={1560} style={esA()}><DigestEmail></DigestEmail></DCArtboard>
        </DCSection>
        <DCSection id="dp" title="Digest Preview" subtitle="Same template + explicit preview banner · shown in the all-clear state so an empty week doesn’t look broken">
          <DCArtboard id="dp-meta" label="Routing · subject · preheader" width={380} height={580} style={esA()}><ESMetaCard e={E('digest-preview')}></ESMetaCard></DCArtboard>
          <DCArtboard id="dp-email" label="Preview · all-clear state" width={600} height={1440} style={esA()}><DigestEmail preview allClear></DigestEmail></DCArtboard>
        </DCSection>
      </DesignCanvas>);
  }
  ReactDOM.createRoot(document.getElementById('root')).render(<App></App>);
}
