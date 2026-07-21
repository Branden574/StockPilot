// Invitations family: team invite, invite reminder, workspace ready, portal magic link.
const IW = ES.W;
const LONG_ORG = 'Pacific Intermountain Distribution & Logistics Cooperative — West';
function WorkspaceCard({T, M, org=IW.org, kind=IW.orgKind}){
  return (
    <ESCard T={T}>
      <div style={{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap'}}>
        <ESAvatar T={T} initials={IW.inviter.initials}></ESAvatar>
        <span style={{fontFamily:ES.MONO,fontSize:12,color:T.ink4}}>→</span>
        <div style={{width:44,height:44,borderRadius:10,background:T.sunk,border:`1px solid ${T.hair}`,display:'flex',alignItems:'center',justifyContent:'center',flex:'0 0 auto'}}>
          <ESMark size={26} T={T}></ESMark>
        </div>
        <div style={{minWidth:0,flex:1}}>
          <div style={{fontSize:14.5,fontWeight:600,color:T.ink,lineHeight:1.3}}>{org}</div>
          <div style={{fontSize:11.5,color:T.ink3,marginTop:2}}>{kind} · {IW.members} members · {IW.seats} seats open</div>
        </div>
      </div>
      <div style={{marginTop:14,paddingTop:12,borderTop:`1px solid ${T.hair}`,fontSize:12,lineHeight:1.55,color:T.ink3}}>
        <span style={{fontFamily:ES.MONO,fontSize:9,letterSpacing:'0.18em',textTransform:'uppercase',color:T.ink4,fontWeight:500}}>Your role · </span>
        <strong style={{fontWeight:600,color:T.ink}}>{IW.role}</strong> — {IW.roleBlurb}.
      </div>
    </ESCard>);
}
function TeamInviteEmail({T=ES.TH.light, M=false, reminder=false, longOrg=false}){
  const org = longOrg ? LONG_ORG : IW.org;
  return (
    <ESFrame T={T} M={M} tag="Workspace Invite">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="warn">{reminder ? 'Reminder · still pending' : `Pending · expires in ${IW.expiry.invite}`}</ESPill>
        {reminder
          ? <ESH1 T={T} M={M} sub="Your invitation is waiting.">Still thinking it over?</ESH1>
          : <ESH1 T={T} M={M} sub={`Join ${org}.`}>{IW.inviter.first} invited you.</ESH1>}
        <ESBody T={T} M={M}>{reminder
          ? <span>Hi {IW.invitee.name} — a nudge, not a new invitation: {IW.inviter.first}’s invite to join <strong style={{fontWeight:600,color:T.ink}}>{org}</strong> is still open. It now expires <strong style={{fontWeight:600,color:T.ink}}>{IW.expiry.inviteOn}</strong>.</span>
          : <span>Hi {IW.invitee.name} — {IW.inviter.name} ({IW.inviter.email}) added you to their StockPilot workspace as an <strong style={{fontWeight:600,color:T.ink}}>{IW.role}</strong>.</span>}</ESBody>
      </ESPad>
      <ESPad T={T} M={M}><WorkspaceCard T={T} M={M} org={org}></WorkspaceCard></ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="Accept invitation"
          note={<span>Expires {IW.expiry.inviteOn}. Wasn’t expecting this? Ignore it — nothing about you is shared until you accept.</span>}></ESCTARow>
        <ESLinkFallback T={T} url={IW.urls.accept}></ESLinkFallback>
      </ESPad>
      {!reminder && (
        <ESPad T={T} M={M}>
          <ESHelp T={T}>New to StockPilot? It’s where {org} runs inventory, orders, rentals, and schedules. Your account takes about two minutes to set up.</ESHelp>
        </ESPad>)}
      <ESFooter T={T} M={M} kind="ess" reason={<span>Sent to {IW.invitee.email} because {IW.inviter.email} invited this address to a StockPilot workspace.</span>}></ESFooter>
    </ESFrame>);
}
function WorkspaceReadyEmail({T=ES.TH.light, M=false}){
  const steps = [
    ['01','Invite your team', 'Operators can scan and count from day one.'],
    ['02','Configure inventory', 'Import items or start from the catalog templates.'],
    ['03','Place a first order', 'Run one request end-to-end to see the flow.'],
  ];
  return (
    <ESFrame T={T} M={M} tag="Workspace">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="ok">Ready</ESPill>
        <ESH1 T={T} M={M} sub="Let’s get it stocked.">Your workspace is ready.</ESH1>
        <ESBody T={T} M={M}>Hi {IW.user.name} — <strong style={{fontWeight:600,color:T.ink}}>{IW.org}</strong> is provisioned and live. Inventory, orders, rentals, and scheduling are all switched on.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}><ESHeroBox T={T} M={M}><HeroTiles T={T}></HeroTiles></ESHeroBox></ESPad>
      <ESPad T={T} M={M}>
        <ESCard T={T} pad="6px 20px">
          {steps.map((s,i)=>(
            <div key={i} style={{display:'flex',gap:14,alignItems:'baseline',padding:'12px 0',borderBottom:i<2?`1px solid ${T.hair}`:'none'}}>
              <span style={{fontFamily:ES.MONO,fontSize:10,color:T.ink4,flex:'0 0 auto'}}>{s[0]}</span>
              <div><div style={{fontSize:13.5,fontWeight:600,color:T.ink}}>{s[1]}</div>
              <div style={{fontSize:12,color:T.ink3,marginTop:2,lineHeight:1.5}}>{s[2]}</div></div>
            </div>))}
        </ESCard>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="Open workspace" secondary="Invite your team"></ESCTARow>
      </ESPad>
      <ESFooter T={T} M={M} kind="ess" reason={<span>Sent to {IW.user.email} — the owner of this new StockPilot workspace.</span>}></ESFooter>
    </ESFrame>);
}
function PortalInviteEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Supplier Portal">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="purple">Portal access</ESPill>
        <ESH1 T={T} M={M} sub="Their catalog, your account.">{IW.org} invited you to order online.</ESH1>
        <ESBody T={T} M={M}>Hi {IW.customer.name} — {IW.org} set up a private ordering portal for <strong style={{fontWeight:600,color:T.ink}}>{IW.customer.org}</strong>. Browse their live catalog, place orders, and track deliveries in one place.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCard T={T}>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <div style={{width:40,height:40,borderRadius:10,background:T.sunk,border:`1px solid ${T.hair}`,display:'flex',alignItems:'center',justifyContent:'center',flex:'0 0 auto'}}>
              <ESMark size={24} T={T}></ESMark>
            </div>
            <div><div style={{fontSize:14,fontWeight:600,color:T.ink}}>{IW.org} — supplier portal</div>
            <div style={{fontSize:11.5,color:T.ink3,marginTop:2}}>Access for {IW.customer.org} · {IW.customer.email}</div></div>
          </div>
          <div style={{marginTop:14,paddingTop:12,borderTop:`1px solid ${T.hair}`,display:'grid',gap:8}}>
            {['Browse the live catalog with current availability','Place orders and reorder past requests','See delivery records and receipts'].map((li,i)=>(
              <div key={i} style={{display:'flex',gap:10,fontSize:12.5,color:T.ink2,lineHeight:1.5}}>
                <span style={{color:T.status.ok.fg,fontWeight:600}}>✓</span>{li}
              </div>))}
          </div>
        </ESCard>
      </ESPad>
      <ESPad T={T} M={M} bottom={20}>
        <ESBanner T={T} s="info" title="How this link works">It signs you in securely — no password to create. It’s personal to {IW.customer.email} and works for {IW.expiry.portal}; after that, request a fresh one from {IW.org}.</ESBanner>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="Open the portal"></ESCTARow>
        <ESLinkFallback T={T} url={IW.urls.portal}></ESLinkFallback>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESHelp T={T}>Didn’t expect this? Someone at {IW.org} may have entered your address for ordering — check with them directly, or just ignore this email.</ESHelp>
      </ESPad>
      <ESFooter T={T} M={M} kind="ext" reason={<span>You’re receiving this because {IW.org} uses StockPilot to run their supplier portal and invited this address. No StockPilot account is required.</span>}></ESFooter>
    </ESFrame>);
}
Object.assign(window, {TeamInviteEmail, WorkspaceReadyEmail, PortalInviteEmail});

if (window.ES_MOUNT === 'invites'){
  const E = ES.byId;
  function App(){
    return (
      <DesignCanvas>
        <DCSection id="ti" title="Team Invite" subtitle="Essential · one premium invitation family — invite and reminder share it">
          <DCArtboard id="ti-meta" label="Routing · subject · preheader" width={380} height={580} style={esA()}><ESMetaCard e={E('team-invite')}></ESMetaCard></DCArtboard>
          <DCArtboard id="ti-email" label="Team invite · desktop light" width={600} height={1040} style={esA()}><TeamInviteEmail></TeamInviteEmail></DCArtboard>
          <DCArtboard id="ti-long" label="State · long organization name" width={600} height={1100} style={esA()}><TeamInviteEmail longOrg></TeamInviteEmail></DCArtboard>
        </DCSection>
        <DCSection id="ir" title="Invite Reminder" subtitle="Same family, clearly a reminder — original invite still pending, new expiry shown">
          <DCArtboard id="ir-meta" label="Routing · subject · preheader" width={380} height={580} style={esA()}><ESMetaCard e={E('invite-reminder')}></ESMetaCard></DCArtboard>
          <DCArtboard id="ir-email" label="Invite reminder · desktop light" width={600} height={920} style={esA()}><TeamInviteEmail reminder></TeamInviteEmail></DCArtboard>
        </DCSection>
        <DCSection id="wr" title="Workspace Ready" subtitle="Celebratory but professional · tiles-settle motion · first recommended actions">
          <DCArtboard id="wr-meta" label="Routing · subject · preheader" width={380} height={580} style={esA()}><ESMetaCard e={E('ws-ready')}></ESMetaCard></DCArtboard>
          <DCArtboard id="wr-email" label="Workspace ready · desktop light" width={600} height={1060} style={esA()}><WorkspaceReadyEmail></WorkspaceReadyEmail></DCArtboard>
        </DCSection>
        <DCSection id="pi" title="Portal Invite · Magic Link" subtitle="External B2B recipient · fully branded, assumes zero StockPilot knowledge · replaces the no-logo black-button email">
          <DCArtboard id="pi-meta" label="Routing · subject · preheader" width={380} height={580} style={esA()}><ESMetaCard e={E('portal-invite')}></ESMetaCard></DCArtboard>
          <DCArtboard id="pi-email" label="Portal invite · desktop light" width={600} height={1180} style={esA()}><PortalInviteEmail></PortalInviteEmail></DCArtboard>
        </DCSection>
      </DesignCanvas>);
  }
  ReactDOM.createRoot(document.getElementById('root')).render(<App></App>);
}
