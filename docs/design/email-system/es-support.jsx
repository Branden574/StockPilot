// Internal support ticket + two recommended (not live) submitter-facing concepts.
const UW = ES.W, TK = UW.ticket;
function SupportTicketEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Internal">
      <div style={{padding:M?'8px 24px':'8px 36px',background:T.sunk,borderBottom:`1px solid ${T.hair}`,
        fontFamily:ES.MONO,fontSize:8.5,letterSpacing:'0.2em',textTransform:'uppercase',color:T.ink3,fontWeight:600}}>
        Internal support notification — not customer-facing
      </div>
      <ESPad T={T} M={M} top={M?24:28} bottom={20}>
        <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
          <ESPill T={T} s="err">{TK.priority} priority</ESPill>
          <ESPill T={T} s="neutral" dot={false}>{TK.type}</ESPill>
          <span style={{fontFamily:ES.MONO,fontSize:10,color:T.ink4}}>{TK.id}</span>
        </div>
        <h1 style={{margin:'14px 0 6px',fontSize:M?19:23,lineHeight:1.25,letterSpacing:'-0.02em',fontWeight:600,color:T.ink}}>{TK.subject}</h1>
        <div style={{fontSize:12.5,color:T.ink3}}>{TK.org} · {TK.plan} · via {TK.source}</div>
      </ESPad>
      <ESPad T={T} M={M} bottom={20}>
        <ESCard T={T} pad="8px 20px">
          <ESRow T={T} k="Submitter" v={`${TK.from}`} strong></ESRow>
          <ESRow T={T} k="Email" v={TK.email}></ESRow>
          <ESRow T={T} k="Submitted" v={TK.time}></ESRow>
          <ESRow T={T} k="Environment" v={TK.env} last></ESRow>
        </ESCard>
      </ESPad>
      <ESPad T={T} M={M} bottom={20}>
        <ESEyebrow T={T} mb={8}>Message — verbatim</ESEyebrow>
        <div style={{border:`1px solid ${T.hair}`,borderRadius:6,padding:'14px 16px',background:T.raise,fontSize:13,lineHeight:1.6,color:T.ink2}}>{TK.msg}</div>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="Open ticket" secondary="Reply to customer"
          note="Reply-to on this email is set to the customer — a direct reply starts the thread and logs to the ticket."></ESCTARow>
      </ESPad>
      <ESFooter T={T} M={M} kind="int" reason={<span>Routed to the support queue by ticket rules ({TK.priority} → immediate). Sent to on-shift support staff.</span>}></ESFooter>
    </ESFrame>);
}
function SupportReceivedEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Support">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="info">In the queue</ESPill>
        <ESH1 T={T} M={M} sub="A human will read it.">We got your request.</ESH1>
        <ESBody T={T} M={M}>Hi {TK.from.split(' ')[0]} — your message about <strong style={{fontWeight:600,color:T.ink}}>“{TK.subject}”</strong> is logged as {TK.id}. Typical first response for {TK.priority.toLowerCase()}-priority reports: within 4 business hours.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCard T={T} pad="8px 20px">
          <ESRow T={T} k="Ticket" v={TK.id} strong></ESRow>
          <ESRow T={T} k="Submitted" v={TK.time}></ESRow>
          <ESRow T={T} k="Priority" v={TK.priority} last></ESRow>
        </ESCard>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="View ticket" note="Add screenshots or details any time by replying to this email — replies append to the ticket."></ESCTARow>
      </ESPad>
      <ESFooter T={T} M={M} kind="ess" reason={<span>A one-time acknowledgment for the support request submitted from {TK.email}.</span>}></ESFooter>
    </ESFrame>);
}
function SupportResolvedEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Support">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="ok">Resolved</ESPill>
        <ESH1 T={T} M={M} sub="Closed Jun 13.">Fixed: label printing.</ESH1>
        <ESBody T={T} M={M}>Hi {TK.from.split(' ')[0]} — the misalignment on bulk exports past 200 labels is fixed in today’s build. No settings to change; your Friday receiving day should print clean.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCard T={T} pad="8px 20px">
          <ESRow T={T} k="Ticket" v={`${TK.id} — ${TK.subject}`} strong></ESRow>
          <ESRow T={T} k="Resolved" v="Jun 13, 2026 · build 2026.6.13"></ESRow>
          <ESRow T={T} k="Reopen window" v="Reply within 7 days" last></ESRow>
        </ESCard>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="View resolution" note="Still seeing it? Reply to this email within 7 days and the ticket reopens with full history."></ESCTARow>
      </ESPad>
      <ESFooter T={T} M={M} kind="ess" reason={<span>A one-time resolution notice for the support request submitted from {TK.email}.</span>}></ESFooter>
    </ESFrame>);
}
Object.assign(window, {SupportTicketEmail, SupportReceivedEmail, SupportResolvedEmail});

if (window.ES_MOUNT === 'support'){
  const E = ES.byId;
  function App(){
    return (
      <DesignCanvas>
        <DCSection id="tk" title="Support Ticket Notification" subtitle="Internal triage — priority, environment, and verbatim message scannable in seconds">
          <DCArtboard id="tk-meta" label="Routing · subject · preheader" width={380} height={580} style={esA()}><ESMetaCard e={E('support-ticket')}></ESMetaCard></DCArtboard>
          <DCArtboard id="tk-email" label="Ticket notification · internal" width={600} height={1120} style={esA()}><SupportTicketEmail></SupportTicketEmail></DCArtboard>
        </DCSection>
        <DCSection id="cc" title="Recommended Concepts — Not Live" subtitle="The catalog shows submitters get no acknowledgment and no resolution email. Two proposed additions, clearly labeled.">
          <DCArtboard id="cr-email" label="Concept · request received" width={600} height={1010} style={esA('transparent')}><div><ESStrip kind="concept"></ESStrip><SupportReceivedEmail></SupportReceivedEmail></div></DCArtboard>
          <DCArtboard id="cd-email" label="Concept · request resolved" width={600} height={1010} style={esA('transparent')}><div><ESStrip kind="concept"></ESStrip><SupportResolvedEmail></SupportResolvedEmail></div></DCArtboard>
          <DCArtboard id="cc-flag" label="Why they matter" width={380} height={240} style={esA('transparent')}>
            <ESFlag title="Recommended new emails">Submitters currently hear nothing until a human replies. An acknowledgment sets response expectations; a resolution note closes the loop and cuts “any update?” follow-ups. Both are drawn in the system and ready — <strong>they are not live production emails</strong> until product signs off.</ESFlag>
          </DCArtboard>
        </DCSection>
      </DesignCanvas>);
  }
  ReactDOM.createRoot(document.getElementById('root')).render(<App></App>);
}
