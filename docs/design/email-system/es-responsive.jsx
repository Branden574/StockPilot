// Responsive & dark canvas: 10 families × desktop/mobile × light/dark.
if (window.ES_MOUNT === 'responsive'){
  const CASES = [
    ['pw-reset','Password Reset', (p)=><PasswordResetEmail {...p}></PasswordResetEmail>, 935],
    ['team-invite','Team Invite', (p)=><TeamInviteEmail {...p}></TeamInviteEmail>, 1040],
    ['approved','Order Approved', (p)=><ApprovedEmail {...p}></ApprovedEmail>, 1190],
    ['denied','Order Denied', (p)=><DeniedEmail {...p}></DeniedEmail>, 1180],
    ['transit','Order In Transit', (p)=><TransitEmail {...p}></TransitEmail>, 1230],
    ['delivered','Order Delivered', (p)=><DeliveredEmail {...p}></DeliveredEmail>, 1300],
    ['partial','Partially Fulfilled', (p)=><PartialEmail {...p}></PartialEmail>, 1230],
    ['rental-overdue','Rental Overdue', (p)=><RentalOverdueEmail {...p}></RentalOverdueEmail>, 1200],
    ['sched-tmrw','Schedule Reminder', (p)=><SchedTomorrowEmail {...p}></SchedTomorrowEmail>, 1080],
    ['digest','Weekly Digest', (p)=><DigestEmail {...p}></DigestEmail>, 1560],
  ];
  const TD = ES.TH.dark, TLt = ES.TH.light;
  function App(){
    return (
      <DesignCanvas>
        {CASES.map(([id,name,render,h])=>(
          <DCSection key={id} id={`r-${id}`} title={name} subtitle="Desktop 600 · mobile 375 · light & dark — same component, token repaint only">
            <DCArtboard id={`${id}-dl`} label="Desktop · light" width={600} height={h} style={esA()}>{render({T:TLt})}</DCArtboard>
            <DCArtboard id={`${id}-dd`} label="Desktop · dark" width={600} height={h} style={esA('#060607')}>{render({T:TD})}</DCArtboard>
            <DCArtboard id={`${id}-ml`} label="Mobile · light" width={375} height={h*1.04} style={esA()}>{render({T:TLt, M:true})}</DCArtboard>
            <DCArtboard id={`${id}-md`} label="Mobile · dark" width={375} height={h*1.04} style={esA('#060607')}>{render({T:TD, M:true})}</DCArtboard>
          </DCSection>))}
      </DesignCanvas>);
  }
  ReactDOM.createRoot(document.getElementById('root')).render(<App></App>);
}
