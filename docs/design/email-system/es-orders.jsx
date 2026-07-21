// Order lifecycle family: confirm → received → approved / denied → (packing → staged) → transit → delivered · cancelled.
const OW = ES.W, OD = OW.dates;
function OrderGrid({T, M, extra=[]}){
  return (
    <ESDetailGrid T={T} M={M} rows={[
      ['Order', OW.wo, OW.woRef, 'mono'],
      ['Contents', <span>{OW.units} units <span style={{color:T.ink4,fontWeight:400}}>· {OW.lines} lines</span></span>, `Ships from ${OW.wh}`],
      ['From', OW.wh], ['To', OW.dest], ...extra,
    ]}></ESDetailGrid>);
}
const OSTAGES = ['Received','Approved','Packing','Ready','In transit','Delivered'];
function otl(current){ return OSTAGES.map((s,i)=>[s, i<current?'done':i===current?'now':'todo']); }
function ConfirmRequestEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Order Update">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="warn">Awaiting your confirmation</ESPill>
        <ESH1 T={T} M={M} sub="The warehouse hasn’t seen it yet.">One tap sends {OW.wo}.</ESH1>
        <ESBody T={T} M={M}>Hi {OW.user.name} — you drafted this request for <strong style={{fontWeight:600,color:T.ink}}>{OW.dest}</strong>. Confirm it and {OW.wh} gets to work. Until then, nothing is reserved and nothing ships.</ESBody>
      </ESPad>
      <ESPad T={T} M={M} bottom={24}>
        <ESTimeline T={T} M={M} tone="warn" steps={[['Confirm','now'],['Received','todo'],['Approved','todo'],['In transit','todo'],['Delivered','todo']]}></ESTimeline>
      </ESPad>
      <ESPad T={T} M={M}><OrderGrid T={T} M={M}></OrderGrid></ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="Confirm request"
          note={<span>Unconfirmed requests expire after <strong style={{fontWeight:600,color:T.ink2}}>{OW.expiry.confirm}</strong> and nothing is sent to the warehouse.</span>}></ESCTARow>
        <ESLinkFallback T={T} url={OW.urls.track}></ESLinkFallback>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCard T={T}>
          <div style={{fontSize:13,fontWeight:600,color:T.ink,marginBottom:5}}>Didn’t create this request?</div>
          <div style={{fontSize:12,lineHeight:1.6,color:T.ink3}}>Ignore this email and the draft expires on its own. If requests you didn’t draft keep appearing, <a href="#" style={{color:T.ink2,textDecoration:'underline',textUnderlineOffset:2}}>tell support</a>.</div>
        </ESCard>
      </ESPad>
      <ESFooter T={T} M={M} kind="ess" reason={<span>Confirmation requests are part of placing an order and are sent to the requester, {OW.user.email}.</span>}></ESFooter>
    </ESFrame>);
}
function ReceivedEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Order Update">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="info">Received</ESPill>
        <ESH1 T={T} M={M} sub="We’re on it.">{OW.wo} received.</ESH1>
        <ESBody T={T} M={M}>Hi {OW.user.name} — your request landed at <strong style={{fontWeight:600,color:T.ink}}>{OW.wh}</strong> on {OD.submitted}. Next step: a quick approval, usually within one business day.</ESBody>
      </ESPad>
      <ESPad T={T} M={M} bottom={24}><ESTimeline T={T} M={M} tone="info" steps={otl(0)}></ESTimeline></ESPad>
      <ESPad T={T} M={M}><OrderGrid T={T} M={M}></OrderGrid></ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="View request" note="You’ll get one email per meaningful step — approval, dispatch, delivery. No noise in between."></ESCTARow>
      </ESPad>
      <ESFooter T={T} M={M} kind="pref" reason={<span>Order-status updates for requests placed by {OW.user.email}.</span>}></ESFooter>
    </ESFrame>);
}
function ApprovedEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Order Update">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="ok">Approved</ESPill>
        <ESH1 T={T} M={M} sub="Packing starts now.">{OW.wo} is approved.</ESH1>
        <ESBody T={T} M={M}>Hi {OW.user.name} — we’ve reserved every unit on this request. You’ll get another note the moment it leaves the dock.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}><ESHeroBox T={T} M={M} h={136}><HeroSettle T={T}></HeroSettle></ESHeroBox></ESPad>
      <ESPad T={T} M={M} bottom={24}><ESTimeline T={T} M={M} tone="ok" steps={otl(1)}></ESTimeline></ESPad>
      <ESPad T={T} M={M}><OrderGrid T={T} M={M} extra={[['Approved', OD.approved, `by ${OW.approver}`]]}></OrderGrid></ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="Track this order"></ESCTARow>
        <ESLinkFallback T={T} url={OW.urls.track}></ESLinkFallback>
      </ESPad>
      <ESFooter T={T} M={M} kind="pref" reason={<span>Order-status updates for requests placed by {OW.user.email}.</span>}></ESFooter>
    </ESFrame>);
}
function DeniedEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Order Update">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="err">Not approved</ESPill>
        <ESH1 T={T} M={M} sub="Here’s exactly why.">{OW.wo} wasn’t approved.</ESH1>
        <ESBody T={T} M={M}>Hi {OW.user.name} — your request didn’t clear approval this time. Nothing was reserved or shipped. The reason is below, unedited, with two ways forward.</ESBody>
      </ESPad>
      <ESPad T={T} M={M} bottom={24}>
        <ESTimeline T={T} M={M} tone="err" steps={[['Received','done'],['Review','done'],['Not approved','stop']]}></ESTimeline>
      </ESPad>
      <ESPad T={T} M={M} bottom={20}>
        <ESBanner T={T} s="err" title={`Reason — from ${OW.approver}`}>{OW.denyReason}</ESBanner>
      </ESPad>
      <ESPad T={T} M={M}><OrderGrid T={T} M={M}></OrderGrid></ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="View request" secondary="Contact approver"
          note="Revising keeps your line items — adjust quantities and resubmit in about a minute."></ESCTARow>
      </ESPad>
      <ESFooter T={T} M={M} kind="pref" reason={<span>Order-status updates for requests placed by {OW.user.email}.</span>}></ESFooter>
    </ESFrame>);
}
function TransitEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Order Update">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="info">In transit</ESPill>
        <ESH1 T={T} M={M} sub={`Estimated ${OW.dates.eta}.`}>{OW.wo} is on the way.</ESH1>
        <ESBody T={T} M={M}>Hi {OW.user.name} — your order left <strong style={{fontWeight:600,color:T.ink}}>{OW.wh}</strong> at {OD.dispatched} and is headed to {OW.dest}.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}><ESHeroBox T={T} M={M} h={136}><HeroRoute T={T}></HeroRoute></ESHeroBox></ESPad>
      <ESPad T={T} M={M} bottom={24}><ESTimeline T={T} M={M} tone="info" steps={otl(4)}></ESTimeline></ESPad>
      <ESPad T={T} M={M}>
        <ESDetailGrid T={T} M={M} rows={[
          ['Dispatched', OD.dispatched, OW.wh],
          ['Method', 'Delivery · ground'],
          ['Destination', OW.dest],
          ['Estimated arrival', OW.dates.eta],
        ]}></ESDetailGrid>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="Track shipment"></ESCTARow>
        <ESLinkFallback T={T} url={OW.urls.track}></ESLinkFallback>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESHelp T={T}>Delivery question? Contact {OW.wh} dispatch from the order page — replies to this email aren’t monitored.</ESHelp>
      </ESPad>
      <ESFooter T={T} M={M} kind="pref" reason={<span>Order-status updates for requests placed by {OW.user.email}.</span>}></ESFooter>
    </ESFrame>);
}
function DeliveredEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Order Update">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="ok">Delivered</ESPill>
        <ESH1 T={T} M={M} sub="Signed, received, done.">{OW.wo} was delivered.</ESH1>
        <ESBody T={T} M={M}>Hi {OW.user.name} — the full order arrived at <strong style={{fontWeight:600,color:T.ink}}>{OW.dest}</strong> and was signed for by {OW.signer} at {OW.signTime}. Thanks for routing it through StockPilot.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}><ESHeroBox T={T} M={M} h={136}><HeroCheck T={T}></HeroCheck></ESHeroBox></ESPad>
      <ESPad T={T} M={M} bottom={24}><ESTimeline T={T} M={M} tone="ok" steps={otl(5).map(s=>s[1]==='now'?[s[0],'done']:s)}></ESTimeline></ESPad>
      <ESPad T={T} M={M}>
        <ESItemTable T={T} M={M} items={OW.items} totalLabel="Total units" totalValue={OW.units}></ESItemTable>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="View receipt" secondary="Report an issue"
          note={<span>Need to send something back? Returns for unused items are open through <strong style={{fontWeight:600,color:T.ink2}}>{OD.returnBy}</strong>.</span>}></ESCTARow>
      </ESPad>
      <ESFooter T={T} M={M} kind="pref" reason={<span>Order-status updates for requests placed by {OW.user.email}.</span>}></ESFooter>
    </ESFrame>);
}
function CancelledEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Order Update">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="neutral" >Cancelled</ESPill>
        <ESH1 T={T} M={M} sub="Nothing further to do.">{OW.wo} was cancelled.</ESH1>
        <ESBody T={T} M={M}>Hi {OW.user.name} — this request was cancelled on {OD.cancelled} by the requester. All {OW.units} reserved units went back to stock; nothing shipped and nothing partial is outstanding.</ESBody>
      </ESPad>
      <ESPad T={T} M={M} bottom={24}>
        <ESTimeline T={T} M={M} tone="neutral" steps={[['Received','done'],['Approved','done'],['Cancelled','stop']]}></ESTimeline>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESDetailGrid T={T} M={M} rows={[
          ['Cancelled', OD.cancelled, 'By the requester'],
          ['Inventory impact', 'Units released', 'Back to available stock'],
        ]}></ESDetailGrid>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="View request" secondary="Start a new request"></ESCTARow>
      </ESPad>
      <ESFooter T={T} M={M} kind="pref" reason={<span>Order-status updates for requests placed by {OW.user.email}.</span>}></ESFooter>
    </ESFrame>);
}
function PackingEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Order Update">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="info">Packing</ESPill>
        <ESH1 T={T} M={M} sub="Boxes, labels, tape.">{OW.wo} is being packaged.</ESH1>
        <ESBody T={T} M={M}>Hi {OW.user.name} — {OW.wh} is picking and packing your {OW.lines} lines now. Next you’ll hear from us when it’s staged for delivery.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}><ESHeroBox T={T} M={M} h={136}><HeroScanner T={T}></HeroScanner></ESHeroBox></ESPad>
      <ESPad T={T} M={M} bottom={24}><ESTimeline T={T} M={M} tone="info" steps={otl(2)}></ESTimeline></ESPad>
      <ESPad T={T} M={M}>
        <ESItemTable T={T} M={M} items={OW.items} totalLabel="Units being prepared" totalValue={OW.units}></ESItemTable>
      </ESPad>
      <ESPad T={T} M={M}><ESCTARow T={T} M={M} primary="View request"></ESCTARow></ESPad>
      <ESFooter T={T} M={M} kind="pref" reason={<span>Order-status updates for requests placed by {OW.user.email}.</span>}></ESFooter>
    </ESFrame>);
}
function StagedEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Order Update">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="ok">Ready</ESPill>
        <ESH1 T={T} M={M} sub="Staged at Dock 3.">{OW.wo} is ready.</ESH1>
        <ESBody T={T} M={M}>Hi {OW.user.name} — your order is packed, checked, and staged at <strong style={{fontWeight:600,color:T.ink}}>{OW.wh}</strong>. It’s ready for the pickup window below.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}><ESHeroBox T={T} M={M} h={136}><HeroPin T={T}></HeroPin></ESHeroBox></ESPad>
      <ESPad T={T} M={M} bottom={24}><ESTimeline T={T} M={M} tone="ok" steps={otl(3)}></ESTimeline></ESPad>
      <ESPad T={T} M={M}>
        <ESDetailGrid T={T} M={M} rows={[
          ['Location', `${OW.wh} · Dock 3`],
          ['Pickup window', 'Apr 28 · 6–9 AM PT'],
          ['Bring', 'Work-order ID', OW.wo],
          ['Contents', `${OW.units} units · ${OW.lines} lines`],
        ]}></ESDetailGrid>
      </ESPad>
      <ESPad T={T} M={M} bottom={20}>
        <ESBanner T={T} s="warn" title="Signature required at the dock office">Whoever picks up signs against the work-order ID — they don’t need a StockPilot account.</ESBanner>
      </ESPad>
      <ESPad T={T} M={M}><ESCTARow T={T} M={M} primary="View pickup details"></ESCTARow></ESPad>
      <ESFooter T={T} M={M} kind="pref" reason={<span>Order-status updates for requests placed by {OW.user.email}.</span>}></ESFooter>
    </ESFrame>);
}
Object.assign(window, {ConfirmRequestEmail, ReceivedEmail, ApprovedEmail, DeniedEmail, TransitEmail, DeliveredEmail, CancelledEmail, PackingEmail, StagedEmail, OrderGrid});

if (window.ES_MOUNT === 'orders'){
  const E = ES.byId;
  const MB = (eid, h=580) => <DCArtboard id={`${eid}-meta`} label="Routing · subject · preheader" width={380} height={h} style={esA()}><ESMetaCard e={E(eid)}></ESMetaCard></DCArtboard>;
  function App(){
    return (
      <DesignCanvas>
        <DCSection id="intake" title="Request Intake" subtitle="Confirm (double opt-in, essential) → received. One timeline component tracks every stage.">
          {MB('confirm')}
          <DCArtboard id="confirm-email" label="Confirm request · desktop light" width={600} height={1210} style={esA()}><ConfirmRequestEmail></ConfirmRequestEmail></DCArtboard>
          {MB('received')}
          <DCArtboard id="received-email" label="Received · desktop light" width={600} height={1000} style={esA()}><ReceivedEmail></ReceivedEmail></DCArtboard>
        </DCSection>
        <DCSection id="decision" title="Decision" subtitle="Approved (success + boxes-settle motion) · denied (respectful, reason verbatim, no aggressive red)">
          {MB('approved')}
          <DCArtboard id="approved-email" label="Approved · desktop light" width={600} height={1190} style={esA()}><ApprovedEmail></ApprovedEmail></DCArtboard>
          {MB('denied')}
          <DCArtboard id="denied-email" label="Denied · long reason state · desktop light" width={600} height={1180} style={esA()}><DeniedEmail></DeniedEmail></DCArtboard>
        </DCSection>
        <DCSection id="movement" title="Movement" subtitle="In transit (route motion) · delivered (check draw, items, return guidance)">
          {MB('transit')}
          <DCArtboard id="transit-email" label="In transit · desktop light" width={600} height={1230} style={esA()}><TransitEmail></TransitEmail></DCArtboard>
          {MB('delivered')}
          <DCArtboard id="delivered-email" label="Delivered · desktop light" width={600} height={1300} style={esA()}><DeliveredEmail></DeliveredEmail></DCArtboard>
        </DCSection>
        <DCSection id="cancel" title="Cancelled" subtitle="Neutral treatment — factual, not celebratory, inventory impact stated">
          {MB('cancelled')}
          <DCArtboard id="cancelled-email" label="Cancelled · desktop light" width={600} height={990} style={esA()}><CancelledEmail></CancelledEmail></DCArtboard>
        </DCSection>
        <DCSection id="latent" title="Latent — Designed, Not Dispatched" subtitle="Templates exist in code with no trigger. Labeled honestly; wiring them is an engineering decision.">
          {MB('packing')}
          <DCArtboard id="packing-email" label="Packing · latent" width={600} height={1240} style={esA('transparent')}><div><ESStrip></ESStrip><PackingEmail></PackingEmail></div></DCArtboard>
          {MB('staged')}
          <DCArtboard id="staged-email" label="Staged for delivery · latent" width={600} height={1320} style={esA('transparent')}><div><ESStrip></ESStrip><StagedEmail></StagedEmail></div></DCArtboard>
          <DCArtboard id="latent-flag" label="Dispatch decision" width={380} height={240} style={esA('transparent')}>
            <ESFlag>Both templates are complete in code but <strong>nothing dispatches them</strong>. They’re designed into the system so engineering can flip them on — until then they must not be represented as live production emails.</ESFlag>
          </DCArtboard>
        </DCSection>
      </DesignCanvas>);
  }
  ReactDOM.createRoot(document.getElementById('root')).render(<App></App>);
}
