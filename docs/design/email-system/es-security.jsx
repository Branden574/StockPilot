// Security family: Password Reset + New Sign-In Alert.
const SW = ES.W;
function PasswordResetEmail({T=ES.TH.light, M=false, noName=false}){
  return (
    <ESFrame T={T} M={M} tag="Security">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="sec">Security · Password reset</ESPill>
        <ESH1 T={T} M={M} sub="Takes about a minute.">Reset your password.</ESH1>
        <ESBody T={T} M={M}>{noName?'Hi —':`Hi ${SW.user.name} —`} we received a request to reset the password for <strong style={{fontWeight:600,color:T.ink}}>{SW.user.email}</strong>. If that was you, set a new one below.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}><ESHeroBox T={T} M={M}><HeroLock T={T}></HeroLock></ESHeroBox></ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="Reset password"
          note={<span>This link works for <strong style={{fontWeight:600,color:T.ink2}}>60 minutes</strong> and can be used once. Requested {SW.signin.time}, from {SW.signin.browser}.</span>}></ESCTARow>
        <ESLinkFallback T={T} url={SW.urls.reset}></ESLinkFallback>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCard T={T}>
          <div style={{fontSize:13,fontWeight:600,color:T.ink,marginBottom:5}}>Didn’t request this?</div>
          <div style={{fontSize:12,lineHeight:1.6,color:T.ink3}}>Your password hasn’t changed and no one has accessed your account. You can safely ignore this email — or <a href="#" style={{color:T.ink2,textDecoration:'underline',textUnderlineOffset:2}}>tell support</a> if resets keep arriving that you didn’t ask for.</div>
        </ESCard>
      </ESPad>
      <ESFooter T={T} M={M} kind="ess" reason={<span>Sent to {SW.user.email} because a password reset was requested for this StockPilot account.</span>}></ESFooter>
    </ESFrame>);
}
function SigninAlertEmail({T=ES.TH.light, M=false}){
  return (
    <ESFrame T={T} M={M} tag="Security">
      <ESPad T={T} M={M} top={M?28:36} bottom={24}>
        <ESPill T={T} s="sec">Security · New sign-in</ESPill>
        <ESH1 T={T} M={M} sub="Was this you?">New sign-in to your account.</ESH1>
        <ESBody T={T} M={M}>Hi {SW.user.name} — <strong style={{fontWeight:600,color:T.ink}}>{SW.user.email}</strong> was just signed in from a device we haven’t seen before. If this was you, there’s nothing to do.</ESBody>
      </ESPad>
      <ESPad T={T} M={M}><ESHeroBox T={T} M={M} h={140}><HeroDevice T={T}></HeroDevice></ESHeroBox></ESPad>
      <ESPad T={T} M={M}>
        <ESDetailGrid T={T} M={M} rows={[
          ['Device', SW.signin.device],
          ['Browser', SW.signin.browser],
          ['Location', 'Near Fresno, CA', 'Approximate, based on network'],
          ['Date & time', SW.signin.time],
        ]}></ESDetailGrid>
      </ESPad>
      <ESPad T={T} M={M} bottom={20}>
        <ESBanner T={T} s="err" title="Don’t recognize this?">Secure your account right away — we’ll sign out all devices and walk you through a password reset.</ESBanner>
      </ESPad>
      <ESPad T={T} M={M}>
        <ESCTARow T={T} M={M} primary="Secure my account" secondary="Reset password instead"></ESCTARow>
      </ESPad>
      <ESFooter T={T} M={M} kind="ess" reason={<span>Sent to {SW.user.email} whenever a new device signs in — a core account-safety notice.</span>}></ESFooter>
    </ESFrame>);
}
Object.assign(window, {PasswordResetEmail, SigninAlertEmail});

if (window.ES_MOUNT === 'security'){
  const E = ES.byId;
  function App(){
    return (
      <DesignCanvas>
        <DCSection id="pw" title="Password Reset" subtitle="Essential · triggered by a reset request · calm, trustworthy, zero marketing">
          <DCArtboard id="pw-meta" label="Routing · subject · preheader" width={380} height={560} style={esA()}><ESMetaCard e={E('pw-reset')}></ESMetaCard></DCArtboard>
          <DCArtboard id="pw-email" label="Password reset · desktop light" width={600} height={935} style={esA()}><PasswordResetEmail></PasswordResetEmail></DCArtboard>
          <DCArtboard id="pw-noname" label="State · no first name on file" width={600} height={935} style={esA()}><PasswordResetEmail noName></PasswordResetEmail></DCArtboard>
        </DCSection>
        <DCSection id="si" title="New Sign-In Alert" subtitle="Essential · unrecognized device sign-in · device card + verification pulse">
          <DCArtboard id="si-meta" label="Routing · subject · preheader" width={380} height={560} style={esA()}><ESMetaCard e={E('signin')}></ESMetaCard></DCArtboard>
          <DCArtboard id="si-email" label="Sign-in alert · desktop light" width={600} height={1010} style={esA()}><SigninAlertEmail></SigninAlertEmail></DCArtboard>
          <DCArtboard id="si-flag" label="Copy fix" width={380} height={230} style={esA('transparent')}>
            <ESFlag>The current production copy says alerts can be managed in notification preferences — <strong>no such preference exists</strong>. This design drops the misleading sentence and states the truth: sign-in alerts always send. Adding a real security-alert preference is a product + security-policy call; critical alerts should generally stay mandatory.</ESFlag>
          </DCArtboard>
        </DCSection>
      </DesignCanvas>);
  }
  ReactDOM.createRoot(document.getElementById('root')).render(<App></App>);
}
