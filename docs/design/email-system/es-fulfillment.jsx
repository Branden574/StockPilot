// Fulfillment & returns family: partial fulfillment, backorder shipped, signer receipt, return prompt.
const FW = ES.W, FP = FW.partial, FD = FW.dates;
const fulfilledItems = FW.items.map(it => it.sku===FP.backItem.sku ? {...it, qty:it.qty-FP.back, back:FP.back} : it);
function PartialEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Order Update">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="warn">Partially fulfilled</ESPill>
        <ESH1 T={T} M={M} sub="The rest is on backorder.">Most of {FW.po} has arrived.</ESH1>
        <ESBody T={T} M={M}>Hi {FW.user.name} — <strong style={{fontWeight:600,color:T.ink}}>{FP.delivered} of {FW.units} units</strong> were delivered to {FW.dest} and signed for by {FW.signer}. The remaining {FP.back} units are backordered — expected {FP.eta}.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <ESCard T={T} tone="ok" pad="14px 16px">
            <ESEyebrow T={T} color={T.status.ok.fg} mb={4}>Delivered</ESEyebrow>
            <div style={{fontSize:28,fontWeight:600,letterSpacing:'-0.02em',color:T.ink,lineHeight:1}}>{FP.delivered}</div>
            <div style={{fontSize:11.5,color:T.ink3,marginTop:4}}>units · signed {FD.delivered}</div>
          </ESCard>
          <ESCard T={T} tone="warn" pad="14px 16px">
            <ESEyebrow T={T} color={T.status.warn.fg} mb={4}>Backordered</ESEyebrow>
            <div style={{fontSize:28,fontWeight:600,letterSpacing:'-0.02em',color:T.ink,lineHeight:1}}>{FP.back}</div>
            <div style={{fontSize:11.5,color:T.ink3,marginTop:4}}>units · expected {FP.eta}</div>
          </ESCard>
        </div>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESItemTable T={T} M={M} items={fulfilledItems}
          tagOf={(it)=> it.back ? ['warn', `${it.back} backordered`] : ['ok','Delivered']}></ESItemTable>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="View order"
          note="No action needed — backordered units ship automatically and you’ll get a dispatch note with tracking."></ESCTARow>
      </ESPad>
      <ESFooter T={T} M={M} kind="pref" reason={<span>Order-status updates for orders placed by {FW.user.email}.</span>}></ESFooter>
    </ESFrame>);
}
function BackorderShippedEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Order Update">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="info">Backorder shipped</ESPill>
        <ESH1 T={T} M={M} sub="Order complete on arrival.">The last {FP.back} units are moving.</ESH1>
        <ESBody T={T} M={M}>Hi {FW.user.name} — the backordered units from <strong style={{fontWeight:600,color:T.ink}}>{FW.po}</strong> left {FW.wh} on {FP.shipDate}. When they land, this order is fully closed out.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}><ESHeroBox T={T} M={M} h={136}><HeroRoute T={T}></HeroRoute></ESHeroBox></ESPad>
      <ESPad T={T} M={M}>
        <ESDetailGrid T={T} M={M} rows={[
          ['Shipment', `${FP.backItem.name}`, `${FP.backItem.sku} · ×${FP.back}`],
          ['Shipped', FP.shipDate, 'Delivery · ground'],
          ['From', FW.wh], ['To', FW.dest],
        ]}></ESDetailGrid>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="Track shipment"></ESCTARow>
        <ESLinkFallback T={T} url={FW.urls.track}></ESLinkFallback>
      </ESPad>
      <ESFooter T={T} M={M} kind="pref" reason={<span>Order-status updates for orders placed by {FW.user.email}.</span>}></ESFooter>
    </ESFrame>);
}
function PartialReceiptEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Delivery Receipt">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="neutral">Receipt · partial delivery</ESPill>
        <ESH1 T={T} M={M} sub="Keep it for your records.">Delivery receipt for {FW.po}.</ESH1>
        <ESBody T={T} M={M}>You signed for a delivery at <strong style={{fontWeight:600,color:T.ink}}>{FW.dest}</strong> on {FW.signTime}. This receipt lists what was received and what the supplier still owes — no account or app needed.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCard T={T} pad="8px 20px">
          <ESRow T={T} k="Signed by" v={FW.signer} strong></ESRow>
          <ESRow T={T} k="Signature time" v={FW.signTime}></ESRow>
          <ESRow T={T} k="Delivery location" v={FW.dest}></ESRow>
          <ESRow T={T} k="Supplier" v={`${FW.org} · via StockPilot`}></ESRow>
          <ESRow T={T} k="Units received" v={`${FP.delivered} of ${FW.units}`} strong></ESRow>
          <ESRow T={T} k="Still pending" v={`${FP.back} units · expected ${FP.eta}`} last></ESRow>
        </ESCard>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESItemTable T={T} M={M} items={fulfilledItems}
          tagOf={(it)=> it.back ? ['warn', `${it.back} pending`] : ['ok','Received']}></ESItemTable>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="View receipt" note="The pending units ship separately — the supplier will notify the original requester."></ESCTARow>
      </ESPad>
      <ESFooter T={T} M={M} kind="ext" reason={<span>You’re receiving this one-time receipt because you signed for a delivery managed by {FW.org} through StockPilot.</span>}></ESFooter>
    </ESFrame>);
}
function ReturnPromptEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Order Update">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="neutral">Delivered {FD.delivered.split(',')[0]}</ESPill>
        <ESH1 T={T} M={M} sub="It takes about a minute.">Need to return anything?</ESH1>
        <ESBody T={T} M={M}>Hi {FW.user.name} — everything from <strong style={{fontWeight:600,color:T.ink}}>{FW.po}</strong> landed {FD.delivered.split(',')[0]}. If anything arrived wrong or surplus, unused items can go back through <strong style={{fontWeight:600,color:T.ink}}>{FD.returnBy}</strong>.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}><ESHeroBox T={T} M={M} h={136}><HeroRoute T={T} reverse></HeroRoute></ESHeroBox></ESPad>
      <ESPad T={T} M={M}>
        <ESDetailGrid T={T} M={M} rows={[
          ['Order', FW.po, `Delivered to ${FW.dest}`],
          ['Return window', FD.returnBy, 'Unused items only'],
        ]}></ESDetailGrid>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="Start a return" secondary="Return policy"
          note="All good? Then you’re done — this is the only nudge we’ll send about returns for this order."></ESCTARow>
      </ESPad>
      <ESFooter T={T} M={M} kind="pref" reason={<span>A single post-delivery notice for orders placed by {FW.user.email}.</span>}></ESFooter>
    </ESFrame>);
}
Object.assign(window, {PartialEmail, BackorderShippedEmail, PartialReceiptEmail, ReturnPromptEmail});

if (window.ES_MOUNT === 'fulfillment'){
  const E = ES.byId;
  const MB = (eid) => <DCArtboard id={`${eid}-meta`} label="Routing · subject · preheader" width={380} height={580} style={esA()}><ESMetaCard e={E(eid)}></ESMetaCard></DCArtboard>;
  function App(){
    return (
      <DesignCanvas>
        <DCSection id="pf" title="Partially Fulfilled" subtitle="Replaces bare HTML · split visual: delivered vs backordered, per-line status">
          {MB('partial')}
          <DCArtboard id="pf-email" label="Partially fulfilled · desktop light" width={600} height={1230} style={esA()}><PartialEmail></PartialEmail></DCArtboard>
          <DCArtboard id="pf-flag" label="Suppression behavior" width={380} height={230} style={esA('transparent')}>
            <ESFlag>Catalog: public order emails (this family) follow <strong>different suppression rules</strong> than account-holder emails. Unify the policy or document the difference before rollout — the footer here assumes standard preference control.</ESFlag>
          </DCArtboard>
        </DCSection>
        <DCSection id="bs" title="Backordered Items Shipped" subtitle="Closes the loop the partial email opened — same order, same language">
          {MB('back-shipped')}
          <DCArtboard id="bs-email" label="Backorder shipped · desktop light" width={600} height={1140} style={esA()}><BackorderShippedEmail></BackorderShippedEmail></DCArtboard>
        </DCSection>
        <DCSection id="pr" title="Partial Delivery Receipt" subtitle="Sent to the signer — a receipt, not an account notification · zero StockPilot jargon">
          {MB('partial-receipt')}
          <DCArtboard id="pr-email" label="Signer receipt · desktop light" width={600} height={1310} style={esA()}><PartialReceiptEmail></PartialReceiptEmail></DCArtboard>
        </DCSection>
        <DCSection id="rp" title="Return Prompt" subtitle="Helpful post-delivery service note — reverse-route motion, explicitly not a promotion">
          {MB('return-prompt')}
          <DCArtboard id="rp-email" label="Return prompt · desktop light" width={600} height={1120} style={esA()}><ReturnPromptEmail></ReturnPromptEmail></DCArtboard>
        </DCSection>
      </DesignCanvas>);
  }
  ReactDOM.createRoot(document.getElementById('root')).render(<App></App>);
}
