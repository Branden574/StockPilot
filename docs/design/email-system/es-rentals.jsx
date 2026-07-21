// Rentals family: checked out, returned, overdue. Purpose-built asset card — not a reskinned order template.
const RW = ES.W, RR = RW.rental;
function RentalCard({T, M, returned=false}){
  return (
    <ESCard T={T}>
      <div style={{display:'flex',alignItems:'center',gap:12,paddingBottom:12,borderBottom:`1px dashed ${T.hair2}`}}>
        <div style={{width:40,height:40,borderRadius:9,background:T.sunk,border:`1px solid ${T.hair}`,display:'flex',alignItems:'center',justifyContent:'center',flex:'0 0 auto'}}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke={T.ink} strokeOpacity="0.75" strokeWidth="1.8">
            <rect x="7" y="5" width="10" height="15" rx="2.5"></rect><circle cx="12" cy="9" r="1.6"></circle><path d="M 12 2 q 3 1 0 3" strokeOpacity="0.45"></path>
          </svg>
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:14.5,fontWeight:600,color:T.ink}}>{RR.name} <span style={{color:T.ink4,fontWeight:400}}>×{RR.qty}</span></div>
          <div style={{fontFamily:ES.MONO,fontSize:10,color:T.ink4,marginTop:2}}>Asset {RR.tag}</div>
        </div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'14px 20px',paddingTop:14}}>
        {[['Checked out',RR.out],[returned?'Returned':'Due back',returned?RR.returned:RR.due],['Borrower',RR.borrower],['Return to',RR.loc]].map((r,i)=>(
          <div key={i}><ESEyebrow T={T} mb={4}>{r[0]}</ESEyebrow>
          <div style={{fontSize:12.5,fontWeight:i===1?600:400,color:T.ink,lineHeight:1.4}}>{r[1]}</div></div>))}
      </div>
    </ESCard>);
}
function RentalOutEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Rental">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="info">Checked out</ESPill>
        <ESH1 T={T} M={M} sub={`Due back ${RR.due.replace(', 2026','')}.`}>{RR.name} is yours.</ESH1>
        <ESBody T={T} M={M}>Hi {RW.invitee.name} — both units are checked out to you. Bring them back to the <strong style={{fontWeight:600,color:T.ink}}>equipment cage at {RW.wh.replace(' — Fresno','')} — Fresno</strong> by the due date and you’re square.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}><ESHeroBox T={T} M={M} h={140}><HeroTag T={T}></HeroTag></ESHeroBox></ESPad>
      <ESPad T={T} M={M}><RentalCard T={T} M={M}></RentalCard></ESPad>
      <ESPad T={T} M={M} bottom={20}>
        <ESBanner T={T} s="neutral" title="Condition at checkout">{RR.cond}</ESBanner>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="View rental" note="Need it longer? Extend from the rental page before the due date — no email required."></ESCTARow>
      </ESPad>
      <ESFooter T={T} M={M} kind="pref" reason={<span>Rental notices for equipment checked out to {RW.invitee.email}.</span>}></ESFooter>
    </ESFrame>);
}
function RentalReturnedEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Rental">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="ok">Returned</ESPill>
        <ESH1 T={T} M={M} sub="All checked in.">Returned — thanks.</ESH1>
        <ESBody T={T} M={M}>Hi {RW.invitee.name} — the equipment desk checked both scanners in on <strong style={{fontWeight:600,color:T.ink}}>{RR.returned}</strong>, a day ahead of schedule. This closes out the rental.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}><ESHeroBox T={T} M={M} h={136}><HeroCheck T={T}></HeroCheck></ESHeroBox></ESPad>
      <ESPad T={T} M={M}><RentalCard T={T} M={M} returned></RentalCard></ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="View record" note="Spotted damage after check-in? The equipment desk keeps the record open for 48 hours."></ESCTARow>
      </ESPad>
      <ESFooter T={T} M={M} kind="pref" reason={<span>Rental notices for equipment checked out to {RW.invitee.email}.</span>}></ESFooter>
    </ESFrame>);
}
function RentalOverdueEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Rental">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="err">Overdue · {RR.overdueDays} days</ESPill>
        <ESH1 T={T} M={M} sub={`That was ${RR.overdueDays} days ago.`}>{RR.name} was due {RR.due.replace(', 2026','')}.</ESH1>
        <ESBody T={T} M={M}>Hi {RW.invitee.name} — both units are still checked out to you. Others book against this equipment, so please return it to the <strong style={{fontWeight:600,color:T.ink}}>equipment cage</strong> or extend the rental if you still need it.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}><ESHeroBox T={T} M={M} h={140}><HeroClock T={T} tone="err" arc></HeroClock></ESHeroBox></ESPad>
      <ESPad T={T} M={M}>
        <ESDetailGrid T={T} M={M} rows={[
          ['Was due', RR.due, `Today is ${RR.today}`],
          ['Days overdue', `${RR.overdueDays}`, 'Counted in workdays'],
          ['Equipment', `${RR.name} ×${RR.qty}`, `Asset ${RR.tag}`],
          ['Return to', RR.loc],
        ]}></ESDetailGrid>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="Review rental" secondary="Contact equipment desk"
          note="Already returned it? The desk may not have checked it in yet — this notice stops automatically once they do."></ESCTARow>
      </ESPad>
      <ESFooter T={T} M={M} kind="pref" reason={<span>Rental notices for equipment checked out to {RW.invitee.email}.</span>}></ESFooter>
    </ESFrame>);
}
Object.assign(window, {RentalOutEmail, RentalReturnedEmail, RentalOverdueEmail, RentalCard});

if (window.ES_MOUNT === 'rentals'){
  const E = ES.byId;
  const MB = (eid) => <DCArtboard id={`${eid}-meta`} label="Routing · subject · preheader" width={380} height={580} style={esA()}><ESMetaCard e={E(eid)}></ESMetaCard></DCArtboard>;
  function App(){
    return (
      <DesignCanvas>
        <DCSection id="ro" title="Rental Checked Out" subtitle="Purpose-built asset card (tag glyph, perforation, asset ID) — no longer a copied order template">
          {MB('rental-out')}
          <DCArtboard id="ro-email" label="Checked out · desktop light" width={600} height={1220} style={esA()}><RentalOutEmail></RentalOutEmail></DCArtboard>
          <DCArtboard id="ro-flag" label="Classification required" width={380} height={260} style={esA('transparent')}>
            <ESFlag>Rental emails currently ship with <strong>no unsubscribe or preference mechanism</strong>. Product must classify each one — essential transactional vs. optional reminder vs. preference-controlled — before these footers go live. Shown here with the preference footer as the recommended default; checked-out and returned could be argued essential (receipt-like).</ESFlag>
          </DCArtboard>
        </DCSection>
        <DCSection id="rr" title="Rental Returned" subtitle="Restrained completion — check draw, closes the loop, 48h damage note">
          {MB('rental-returned')}
          <DCArtboard id="rr-email" label="Returned · desktop light" width={600} height={1090} style={esA()}><RentalReturnedEmail></RentalReturnedEmail></DCArtboard>
        </DCSection>
        <DCSection id="rv" title="Rental Overdue" subtitle="Clear attention state — real dates, real day count, no manufactured urgency">
          {MB('rental-overdue')}
          <DCArtboard id="rv-email" label="Overdue · desktop light" width={600} height={1200} style={esA()}><RentalOverdueEmail></RentalOverdueEmail></DCArtboard>
        </DCSection>
      </DesignCanvas>);
  }
  ReactDOM.createRoot(document.getElementById('root')).render(<App></App>);
}
