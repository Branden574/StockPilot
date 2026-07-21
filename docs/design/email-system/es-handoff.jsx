// Developer handoff + content matrix + current-state audit. Scrollable doc page.
const HT = ES.TH.light;
function HSec({id, kicker, title, children, intro}){
  return (
    <section id={id} style={{margin:'0 auto 64px',maxWidth:1160,padding:'0 32px'}}>
      <ESEyebrow T={HT} mb={6}>{kicker}</ESEyebrow>
      <h2 style={{margin:'0 0 8px',fontSize:26,fontWeight:500,letterSpacing:'-0.02em'}}>{title}</h2>
      {intro && <p style={{margin:'0 0 22px',fontSize:13.5,lineHeight:1.6,color:HT.ink3,maxWidth:640}}>{intro}</p>}
      {children}
    </section>);
}
function HTable({cols, rows, widths}){
  return (
    <div style={{border:`1px solid ${HT.hair}`,borderRadius:8,overflow:'hidden'}}>
      <div style={{display:'grid',gridTemplateColumns:widths,gap:14,padding:'9px 16px',background:HT.sunk,borderBottom:`1px solid ${HT.hair}`}}>
        {cols.map(c=><span key={c} style={{fontFamily:ES.MONO,fontSize:8.5,letterSpacing:'0.16em',textTransform:'uppercase',color:HT.ink3,fontWeight:500}}>{c}</span>)}
      </div>
      {rows.map((r,i)=>(
        <div key={i} style={{display:'grid',gridTemplateColumns:widths,gap:14,padding:'11px 16px',alignItems:'start',
          borderBottom:i<rows.length-1?`1px solid ${HT.hair}`:'none',background:i%2?HT.raise:'transparent'}}>
          {r.map((c,j)=><div key={j} style={{fontSize:12,lineHeight:1.5,color:HT.ink2,minWidth:0,overflowWrap:'break-word'}}>{c}</div>)}
        </div>))}
    </div>);
}
const STATE_PILL = {live:['ok','Live'], latent:['warn','Latent'], concept:['purple','Concept']};
const CATL = {ess:'Essential', pref:'Preference', ext:'External', int:'Internal'};
function ConstantsSec(){
  const P = ES.SPEC.pad, R = ES.SPEC.radius;
  const consts = [
    ['Email width','600px table, max-width 640px, centered'],['Mobile breakpoint','@media (max-width: 620px)'],
    ['Mobile mockup width','375px'],['Outer padding','36px desktop → 24px mobile'],
    ['Header (brand strip)','20px vertical padding · ~60px total height'],['Hero spacing','36px top on first section'],
    ['Section spacing','28px bottom per block'],['Card padding','18–20px'],['Row spacing','14px grid gap'],
    ['Button','13px × 18px padding · ≥44px height · full-width <620px'],
    ['Radii',`button ${R.btn} · card ${R.card} · hero ${R.hero} · pill ${R.pill}`],
    ['Borders','1px solid rgba(12,12,14,.12) light / rgba(246,244,239,.13) dark'],
    ['Shadows','None inside email bodies — hairlines carry elevation'],
    ['Motion assets','600×220 CSS px · export @2x (1200×440) · GIF ≤300KB, APNG ≤600KB'],
    ['Logo','Carved-S mark 22px + wordmark 15px · light + dark PNG @2x shipped'],
    ['Weight budget','≤102KB HTML (Gmail clip) · ≤1MB total with images'],
  ];
  const swl = (T)=>['ok','info','warn','err','neutral','purple'].map(k=>[k, T.status[k].fg, T.status[k].bg]);
  return (
    <HSec id="constants" kicker="01" title="Build constants" intro="Exact values the templates are drawn to. Everything is also live in the mockup source — email-system/es-tokens.js is the canonical token file.">
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:24,alignItems:'start'}}>
        <HTable cols={['Spec','Value']} widths="180px 1fr" rows={consts.map(c=>[<strong style={{fontWeight:600,color:HT.ink}}>{c[0]}</strong>, c[1]])}></HTable>
        <div>
          <HTable cols={['Status','Light fg / bg','Dark fg / bg']} widths="110px 1fr 1fr"
            rows={['ok','info','warn','err','neutral','purple'].map(k=>[
              <ESPill T={HT} s={k} dot={false}>{k}</ESPill>,
              <span style={{fontFamily:ES.MONO,fontSize:10}}>{ES.TH.light.status[k].fg}<br></br>{ES.TH.light.status[k].bg}</span>,
              <span style={{fontFamily:ES.MONO,fontSize:10}}>{ES.TH.dark.status[k].fg}<br></br>{ES.TH.dark.status[k].bg}</span>,
            ])}></HTable>
          <div style={{marginTop:12,fontSize:11.5,color:HT.ink4,lineHeight:1.6}}>Security uses outlined ink (no fill). Surfaces — light: desk #e8e5dd · paper #f6f4ef · sunk #eeece5 · ink #0c0c0e. Dark: desk #060607 · paper #161617 · sunk #1e1e20 · ink #f6f4ef.</div>
        </div>
      </div>
    </HSec>);
}
function ComponentsSec(){
  const comps = [
    ['email-shell','ESFrame','600px table, paper bg, radius 6 — owns brand strip slot + footer slot'],
    ['brand-strip','ESFrame (head)','Mark 22 + wordmark 15 left, mono category tag right; the tag answers “what is this about?”'],
    ['status-pill','ESPill','7 semantic variants; mono caps, 10px, dot optional'],
    ['hero-slot','ESHeroBox','Sunk panel, radius 8, holds the motion asset or its static frame; height reserved in HTML attrs'],
    ['headline','ESH1','32→24px; optional second line in Tinos italic (the “serif turn”) — one per email max'],
    ['cta-row','ESCTARow','Bulletproof button + text-link secondary; stacks and goes full-width on mobile; supports a caption note'],
    ['link-fallback','ESLinkFallback','Copy-paste URL line under primary CTAs on auth/invite emails'],
    ['info-card','ESCard','Hairline card; tinted tone variants for stat blocks'],
    ['detail-grid','ESDetailGrid','2-col label/value grid — order, warehouse, dates; stacks to 1-col only if values run long'],
    ['detail-row','ESRow','Key/value receipt row with hairline dividers'],
    ['item-table','ESItemTable','Item/SKU/qty; optional per-line status pill column (partial fulfillment); SKU tucks under name on mobile'],
    ['order-timeline','ESTimeline','done / current (pulse in product, static in email) / upcoming / terminal-stop states; only real stages render'],
    ['banner','ESBanner','ok · info · warn · err · neutral — title + body, tinted bg, no left-border stripe'],
    ['event-card','EventCard','Date rail + title/time/location/assignee; compact variant for the 1-hour reminder'],
    ['rental-asset-card','RentalCard','Tag glyph, asset ID, perforated divider, checkout/due/borrower/return-to grid'],
    ['kpi-card','(digest)','Big number + label + delta; 2×2 grid'],
    ['action-list','(digest)','Status-dot rows, exceptions first'],
    ['workspace-card','WorkspaceCard','Inviter avatar → workspace tile, role line'],
    ['help-row','ESHelp','Serif “?” chip + guidance text'],
    ['footer','ESFooter','4 variants: essential · preference · external · internal — see Policy audit before wiring rentals'],
    ['preview-banner','(digest)','Purple strip pinned above the digest preview'],
    ['internal-strip','(support)','Mono caps “internal support notification” bar above the shell content'],
  ];
  return (
    <HSec id="components" kicker="02" title="Component inventory" intro="Production name → mockup source component → contract. Every one of the 28 templates composes exclusively from these.">
      <HTable cols={['Component','Source','Contract']} widths="170px 150px 1fr"
        rows={comps.map(c=>[<span style={{fontFamily:ES.MONO,fontSize:11,color:HT.ink}}>{c[0]}</span>,<span style={{fontFamily:ES.MONO,fontSize:10,color:HT.ink4}}>{c[1]}</span>,c[2]])}></HTable>
    </HSec>);
}
function RealismSec(){
  const rules = [
    ['Layout','Nested tables with role="presentation"; no flex/grid; single 600px column; two-up blocks are 50% td pairs that stack via the 620px query'],
    ['CSS','Everything inline; the <style> block carries only the mobile query, dark query, and client hacks — safe to strip'],
    ['Outlook desktop','MSO conditional font stack; bgcolor attr behind every button td; GIFs show frame 1 — first frame must read complete'],
    ['Buttons','Table-cell buttons (a + td bgcolor + padding), not padded anchors alone; VML wrapper optional for full-bleed'],
    ['Dark mode','@media (prefers-color-scheme: dark) + [data-ogsc] duplicates for Outlook.com; solid token backgrounds so partial inversion can’t strand text'],
    ['Gmail','Keep HTML ≤102KB or it clips (hides the unsubscribe link — a compliance risk); preheader as hidden div + &nbsp; padding'],
    ['Images','Explicit width/height attrs; alt text carries the message; no background-image dependencies for meaning'],
    ['Fonts','Google Fonts <link> where supported; every style declares the fallback stack inline; hierarchy must survive Helvetica'],
    ['Forbidden','JS · forms · hover-dependent UI · video · CSS animation for meaning · app-style sidebars · multi-column dashboards'],
  ];
  const a11y = [
    'Contrast ≥4.5:1 body, ≥3:1 large type — token pairs are pre-checked in both modes',
    'Real selectable text everywhere; the email is never one image',
    'Logical source order: what happened → details → action → help',
    'Semantic headings (h1 per email, h2 sections); layout tables role="presentation"',
    'Descriptive CTAs (“Track this order”, never “Click here”)',
    'Meaningful alt text on motion assets; empty alt="" on decoration',
    '≥44px tap targets; full-width buttons on mobile',
    'Status never rides on color alone — every state pairs label + color',
    'No flashing; ≤3 gentle loop cycles (WCAG 2.3.1); static fallback always shipped',
  ];
  return (
    <HSec id="realism" kicker="03" title="Client realism & accessibility" intro="The mockups are drawn to what table-based email HTML can actually do — nothing here needs a rendering miracle.">
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:24,alignItems:'start'}}>
        <HTable cols={['Concern','Rule']} widths="120px 1fr" rows={rules.map(r=>[<strong style={{fontWeight:600,color:HT.ink}}>{r[0]}</strong>,r[1]])}></HTable>
        <div style={{border:`1px solid ${HT.hair}`,borderRadius:8,padding:'6px 18px'}}>
          {a11y.map((a,i)=>(
            <div key={i} style={{display:'flex',gap:10,padding:'9px 0',borderBottom:i<a11y.length-1?`1px solid ${HT.hair}`:'none',fontSize:12,lineHeight:1.55,color:HT.ink2}}>
              <span style={{color:HT.status.ok.fg,fontWeight:600}}>✓</span>{a}
            </div>))}
        </div>
      </div>
    </HSec>);
}
function MatrixSec(){
  return (
    <HSec id="matrix" kicker="04" title="Content matrix — all 28 templates" intro="Trigger, recipient, inbox copy, action, and treatment for every email. Latent and concept rows are explicitly marked — they must not ship without their product/engineering decisions.">
      <HTable cols={['Email','State','Trigger → Recipient','Subject · Preheader','Primary CTA','Category · Footer','Motion']}
        widths="150px 74px 1.1fr 1.6fr 110px 110px 120px"
        rows={ES.EMAILS.map(e=>[
          <span><strong style={{fontWeight:600,color:HT.ink}}>{e.name}</strong><br></br><span style={{fontFamily:ES.MONO,fontSize:9,color:HT.ink4}}>{e.id}</span></span>,
          <ESPill T={HT} s={STATE_PILL[e.st][0]} dot={false}>{STATE_PILL[e.st][1]}</ESPill>,
          <span>{e.trig}<br></br><span style={{color:HT.ink4}}>→ {e.to}</span></span>,
          <span><strong style={{fontWeight:500,color:HT.ink}}>{e.subj}</strong>{e.rec && <span style={{color:HT.status.warn.fg}}><br></br>rec: {e.rec}</span>}<br></br><span style={{color:HT.ink4}}>{e.pre}</span></span>,
          <span>{e.cta}{e.cta2 && <span style={{color:HT.ink4}}><br></br>2nd: {e.cta2}</span>}</span>,
          <span>{CATL[e.cat]}<br></br><span style={{color:HT.ink4}}>{{ess:'No unsub',pref:'Prefs + unsub',ext:'Explainer',int:'Compact'}[e.foot]}</span></span>,
          <span style={{color:HT.ink3}}>{e.motion}</span>,
        ])}></HTable>
    </HSec>);
}
function AuditSec(){
  const IMP = ({tags})=><span style={{display:'flex',gap:5,flexWrap:'wrap'}}>{tags.map(t=><span key={t} style={{fontFamily:ES.MONO,fontSize:8.5,letterSpacing:'0.08em',textTransform:'uppercase',padding:'2px 7px',borderRadius:999,background:HT.sunk,color:HT.ink3}}>{t}</span>)}</span>;
  const fams = [
    ['Classic white-card system','Auth + team invites','Generic SaaS look, weak hierarchy, no operational voice — indistinguishable from any tool’s mail.',['trust','brand','comprehension']],
    ['Premium cream order template','Order approved only','The best of the current set — but a one-off. Every neighboring order email breaks its promise.',['brand','maintenance']],
    ['Separate login-alert design','New sign-in','Third visual language for the highest-stakes category; copy references a preference that doesn’t exist.',['trust','action']],
    ['No-logo bare HTML','Portal invite · partial-fulfillment set','Unbranded black-button mail from an unknown sender reads as phishing; external recipients have zero context.',['deliverability','trust','action']],
    ['Raw one-line schedule reminder','Schedule reminders','A single sentence: no event card, no time zone, no CTA, no preferences link despite being preference-controlled.',['comprehension','action']],
    ['Copied rental template','All rental emails','Visually identical to order emails — recipients misread rentals as orders; due dates get lost.',['comprehension','action']],
    ['Unstructured support notifications','Internal tickets','No shared design language, no priority signal, environment data buried in prose — slow triage.',['action','maintenance']],
  ];
  const policy = [
    ['Login-alert copy references a nonexistent preference','Removed the sentence in the redesign; adding a real security-alert preference is a product + security-policy decision. Critical alerts should generally stay mandatory.','Product + Security'],
    ['Rental emails have no unsubscribe or preference mechanism','Redesign shows the preference footer as the recommended default — do not ship until each rental email is classified (essential vs. reminder vs. preference-controlled).','Product'],
    ['Public order emails suppress differently than account emails','Unify suppression or document the difference; the partial-fulfillment family currently behaves inconsistently for the same recipient.','Product + Eng'],
    ['Several preference toggles have no sender','Settings offer controls for email types nothing dispatches — either wire the senders or remove the toggles; a dead toggle erodes trust in all of them.','Eng'],
    ['Packing + staged templates have no triggers','Both are designed in this system and labeled latent. Wiring dispatch is an engineering decision; until then they are not production emails.','Eng'],
  ];
  return (
    <HSec id="audit" kicker="05" title="Current-state audit" intro="Seven template families today; one system after this redesign. Problems are stated by their operational effect, not taste.">
      <HTable cols={['Current family','Where it lives','What it costs','Impact']} widths="190px 170px 1fr 210px"
        rows={fams.map(f=>[<strong style={{fontWeight:600,color:HT.ink}}>{f[0]}</strong>,<span style={{color:HT.ink3}}>{f[1]}</span>,f[2],<IMP tags={f[3]}></IMP>])}></HTable>
      <div style={{margin:'40px 0 14px'}}>
        <ESEyebrow T={HT} mb={4}>05b</ESEyebrow>
        <h3 style={{margin:0,fontSize:19,fontWeight:600,letterSpacing:'-0.01em'}}>Policy & preference audit — decisions required</h3>
        <p style={{margin:'6px 0 0',fontSize:12.5,color:HT.ink3,maxWidth:640,lineHeight:1.6}}>None of these are solved visually. The mockups assume nothing that doesn’t exist; each item names its owner.</p>
      </div>
      <HTable cols={['Inconsistency','How the redesign handles it','Owner']} widths="270px 1fr 130px"
        rows={policy.map(p=>[<strong style={{fontWeight:600,color:HT.ink}}>{p[0]}</strong>,p[1],<ESPill T={HT} s="warn" dot={false}>{p[2]}</ESPill>])}></HTable>
    </HSec>);
}
function AssetsSec(){
  return (
    <HSec id="assets" kicker="06" title="Assets to produce" intro="The finite production list — everything else is HTML.">
      <HTable cols={['Asset','Spec','Notes']} widths="220px 260px 1fr" rows={[
        [<strong style={{fontWeight:600,color:HT.ink}}>13 motion assets</strong>,'1200×440 @2x → 600×220 · GIF ≤300KB (APNG ≤600KB where alpha needed)','Full per-asset specs on the Motion Board — duration, loops, first-frame, Outlook fallback'],
        [<strong style={{fontWeight:600,color:HT.ink}}>13 static first frames</strong>,'Same dims · PNG ≤80KB','Doubles as reduced-motion + images-partially-blocked fallback'],
        [<strong style={{fontWeight:600,color:HT.ink}}>Logo — light + dark</strong>,'Mark 44×44 @2x · lockup 300×44 @2x PNG','Never rely on client color inversion; transparent with 2px safe edge'],
        [<strong style={{fontWeight:600,color:HT.ink}}>Reference templates ×3</strong>,'Email-safe HTML in email-system/templates/','Security · order-status · digest archetypes — table layout, inline CSS, merge tags, dark + mobile queries'],
      ]}></HTable>
    </HSec>);
}
if (window.ES_MOUNT === 'handoff'){
  function App(){
    return (
      <div style={{minHeight:'100vh',background:HT.desk,fontFamily:ES.F1,color:HT.ink,padding:'56px 0 90px'}}>
        <header style={{maxWidth:1160,margin:'0 auto 56px',padding:'0 32px'}}>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:22}}>
            <ESMark size={26} T={HT}></ESMark><ESWordmark size={17} T={HT}></ESWordmark>
            <a href="StockPilot Email System.html" style={{marginLeft:'auto',fontFamily:ES.MONO,fontSize:10,letterSpacing:'0.16em',textTransform:'uppercase',color:HT.ink3,textDecoration:'none'}}>← Email system hub</a>
          </div>
          <ESEyebrow T={HT}>Developer handoff · content matrix · audit</ESEyebrow>
          <h1 style={{margin:'8px 0 10px',fontSize:40,lineHeight:1.05,letterSpacing:'-0.03em',fontWeight:500}}>Precise enough to build.<br></br><span style={{fontFamily:ES.SERIF,fontStyle:'italic',color:HT.ink3,fontWeight:400}}>Honest enough to ship.</span></h1>
          <p style={{margin:0,fontSize:14.5,lineHeight:1.6,color:HT.ink2,maxWidth:620}}>Build constants, the component contract, client-realism rules, the full 28-row content matrix, and the audit that separates design decisions from the product and engineering calls still open.</p>
        </header>
        <ConstantsSec></ConstantsSec>
        <ComponentsSec></ComponentsSec>
        <RealismSec></RealismSec>
        <MatrixSec></MatrixSec>
        <AuditSec></AuditSec>
        <AssetsSec></AssetsSec>
        <footer style={{maxWidth:1160,margin:'0 auto',padding:'24px 32px 0',borderTop:`1px solid ${HT.hair}`,display:'flex',justifyContent:'space-between',
          fontFamily:ES.MONO,fontSize:9.5,letterSpacing:'0.18em',textTransform:'uppercase',color:HT.ink4}}>
          <span>StockPilot · Email design system</span><span>v1.0 · Jul 2026</span>
        </footer>
      </div>);
  }
  ReactDOM.createRoot(document.getElementById('root')).render(<App></App>);
}
