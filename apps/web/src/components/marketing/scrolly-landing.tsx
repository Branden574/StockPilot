'use client';

import Link from 'next/link';
import * as React from 'react';

import { ThemeToggle } from '@/components/theme/theme-toggle';

/**
 * Scroll-scrubbed cinematic landing page.
 *
 * A fixed full-bleed <canvas> backdrop plays a ~30s warehouse "film" — a
 * preloaded frame sequence whose playhead is tied to scroll position (the
 * Apple-style technique: no video seeking, so the scrub is decode-free and
 * lag-free). Editorial paper panels scroll over the film for the dense
 * content (features, comparison, privacy, footer).
 *
 * Responsive media: phones / coarse pointers / Save-Data load a light frame
 * set (1024×576), everything else loads the high-quality set (1920×1080).
 *
 * Light/dark is driven by the app's existing next-themes (class strategy):
 * cinematic film beats stay cinematic in both; the paper panels + footer flip
 * between warm paper and ink via the `.dark` re-scope at the bottom of the
 * scoped <style>.
 *
 * All CSS is scoped under #sp-landing so nothing leaks into the rest of the app.
 */

const SIGNIN = 'https://stockpilotusa.com/signin';
const PRICING = 'https://stockpilotusa.com/pricing';

const HI = { dir: '/landing/frames-hi', count: 546, poster: '/landing/frames-hi-poster.jpg' };
const LO = { dir: '/landing/frames-lo', count: 366, poster: '/landing/frames-lo-poster.jpg' };

export function ScrollyLanding() {
  const [menuOpen, setMenuOpen] = React.useState(false);

  React.useEffect(() => {
    const root = document.getElementById('sp-landing');
    if (!root) return;
    const canvas = document.getElementById('sp-film') as HTMLCanvasElement | null;
    const poster = document.getElementById('sp-poster') as HTMLImageElement | null;
    const scrim = document.getElementById('sp-scrim');
    const nav = document.getElementById('sp-nav');
    const bar = document.getElementById('sp-progress');
    if (!canvas || !poster) return;
    const ctx2d = canvas.getContext('2d', { alpha: true });
    if (!ctx2d) return;
    const ctx = ctx2d; // narrowed non-null for the closures below
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // ---- pick the right frame set for this device ----
    const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    const small = window.matchMedia('(max-width: 820px)').matches;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const saveData = !!conn && (conn.saveData === true || /(^|\b)(2g|slow-2g)\b/.test(conn.effectiveType || ''));
    const SET = small || coarse || saveData ? LO : HI;
    const FRAMES = SET.count;
    poster.src = SET.poster;

    const frames: Array<HTMLImageElement & { _ok?: boolean }> = new Array(FRAMES);
    let loaded = 0;
    let ready = false;
    let curT = 0;
    let curFrame = -1;
    let cw = 0;
    let ch = 0;
    let raf = 0;
    let destroyed = false;

    const pad4 = (n: number) => String(n).padStart(4, '0');
    const docProgress = () => {
      const m = document.documentElement.scrollHeight - window.innerHeight;
      return m > 0 ? Math.min(1, Math.max(0, window.scrollY / m)) : 0;
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cw = canvas.clientWidth;
      ch = canvas.clientHeight;
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingQuality = 'high';
      curFrame = -1;
      drawFrame(curT * (FRAMES - 1));
    };

    const nearestLoaded = (i: number) => {
      if (frames[i]?._ok) return i;
      for (let d = 1; d < FRAMES; d++) {
        if (i - d >= 0 && frames[i - d]?._ok) return i - d;
        if (i + d < FRAMES && frames[i + d]?._ok) return i + d;
      }
      return -1;
    };

    function drawFrame(f: number) {
      let i = Math.max(0, Math.min(FRAMES - 1, Math.round(f)));
      if (i === curFrame) return;
      if (!frames[i]?._ok) {
        const j = nearestLoaded(i);
        if (j < 0) return;
        i = j;
      }
      const img = frames[i];
      if (!img) return;
      const ir = img.naturalWidth / img.naturalHeight;
      const cr = cw / ch;
      let dw: number, dh: number, dx: number, dy: number;
      if (ir > cr) {
        dh = ch;
        dw = ch * ir;
        dx = (cw - dw) / 2;
        dy = 0;
      } else {
        dw = cw;
        dh = cw / ir;
        dx = 0;
        dy = (ch - dh) / 2;
      }
      ctx.drawImage(img, dx, dy, dw, dh);
      curFrame = i;
    }

    const markReady = () => {
      if (ready || destroyed) return;
      ready = true;
      resize();
      poster.style.transition = 'opacity .6s ease';
      // keep poster as a permanent underlay (canvas covers it when frames draw);
      // a tiny fade just lets the first real frame settle in.
      poster.style.opacity = '1';
    };

    // preload frames
    for (let i = 1; i <= FRAMES; i++) {
      const img = new Image() as HTMLImageElement & { _ok?: boolean };
      img.decoding = 'async';
      img.onload = () => {
        img._ok = true;
        loaded++;
      };
      img.src = `${SET.dir}/f_${pad4(i)}.jpg`;
      frames[i - 1] = img;
    }
    const readyCheck = window.setInterval(() => {
      if (loaded >= Math.min(36, FRAMES)) {
        window.clearInterval(readyCheck);
        markReady();
      }
    }, 80);
    const readyFallback = window.setTimeout(() => {
      window.clearInterval(readyCheck);
      markReady();
    }, 6000);

    const scrub = () => {
      if (ready) {
        const target = docProgress();
        curT += (target - curT) * 0.18;
        if (Math.abs(target - curT) < 0.0006) curT = target;
        drawFrame(curT * (FRAMES - 1));
      }
      raf = requestAnimationFrame(scrub);
    };
    raf = requestAnimationFrame(scrub);

    // hidden/background tabs pause rAF — draw on scroll/visibility there too
    const onScrollDraw = () => {
      if (ready && document.hidden) {
        curT = docProgress();
        drawFrame(curT * (FRAMES - 1));
      }
    };
    const onVisible = () => {
      if (!document.hidden && ready) {
        curT = docProgress();
        drawFrame(curT * (FRAMES - 1));
      }
    };

    // chrome: progress bar, nav solidify, per-section scrim
    const scrimSections = Array.from(root.querySelectorAll<HTMLElement>('[data-scrim]'));
    let chromeTick = 0;
    const onScrollChrome = () => {
      if (chromeTick) return;
      chromeTick = requestAnimationFrame(() => {
        chromeTick = 0;
        const max = document.documentElement.scrollHeight - window.innerHeight;
        const p = max > 0 ? window.scrollY / max : 0;
        if (bar) bar.style.width = `${Math.min(100, Math.max(0, p * 100))}%`;
        if (nav) nav.classList.toggle('solid', window.scrollY > 80);
        // active scrim = the data-scrim section nearest viewport center
        const mid = window.scrollY + window.innerHeight / 2;
        let best: HTMLElement | null = null;
        for (const s of scrimSections) {
          const top = s.offsetTop;
          const bot = top + s.offsetHeight;
          if (mid >= top && mid < bot) {
            best = s;
            break;
          }
        }
        if (best && scrim) scrim.style.opacity = best.dataset.scrim || '0.5';
      });
    };

    window.addEventListener('scroll', onScrollDraw, { passive: true });
    window.addEventListener('scroll', onScrollChrome, { passive: true });
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisible);
    onScrollChrome();

    // reveals
    const revealIO = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            revealIO.unobserve(e.target);
          }
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.12 },
    );
    root.querySelectorAll('.rise, .stagger').forEach((el) => revealIO.observe(el));

    // count-up stats
    const countIO = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          countIO.unobserve(el);
          const end = parseFloat(el.dataset.count || '0');
          const prefix = el.dataset.prefix || '';
          const suffix = el.dataset.suffix || '';
          const t0 = performance.now();
          const dur = 1500;
          const step = (now: number) => {
            const k = Math.min(1, (now - t0) / dur);
            const eased = 1 - Math.pow(1 - k, 2);
            el.textContent = prefix + Math.round(eased * end) + suffix;
            if (k < 1) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }
      },
      { threshold: 0.6 },
    );
    root.querySelectorAll<HTMLElement>('.stat .num[data-count]').forEach((el) => countIO.observe(el));

    return () => {
      destroyed = true;
      cancelAnimationFrame(raf);
      if (chromeTick) cancelAnimationFrame(chromeTick);
      window.clearInterval(readyCheck);
      window.clearTimeout(readyFallback);
      window.removeEventListener('scroll', onScrollDraw);
      window.removeEventListener('scroll', onScrollChrome);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisible);
      revealIO.disconnect();
      countIO.disconnect();
    };
  }, []);

  // smooth in-page anchor scrolling
  const onAnchor = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    const el = document.querySelector(id);
    if (el) {
      e.preventDefault();
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setMenuOpen(false);
    }
  };

  return (
    <div id="sp-landing">
      <SpStyles />

      <div id="sp-stage">
        {/* poster underlay = first frame; canvas (alpha) draws on top */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img id="sp-poster" src={HI.poster} alt="" aria-hidden />
        <canvas id="sp-film" aria-hidden />
        <div id="sp-grain" aria-hidden />
        <div id="sp-scrim" aria-hidden />
        <div id="sp-vignette" aria-hidden />
      </div>

      <div id="sp-progress" />

      <header className="sp-nav" id="sp-nav">
        <Link className="brand" href="#top" onClick={(e) => onAnchor(e, '#top')}>
          <BrandGlyph />
          <span className="wordmark">
            <b>Stock</b>
            <span>Pilot</span>
          </span>
        </Link>
        <nav className="nav-links">
          <a href="#product" onClick={(e) => onAnchor(e, '#product')}>
            Features
          </a>
          <a href="#how-it-works" onClick={(e) => onAnchor(e, '#how-it-works')}>
            How it works
          </a>
          <a href="#compare" onClick={(e) => onAnchor(e, '#compare')}>
            Compare
          </a>
          <a href={PRICING}>Pricing</a>
          <a href="https://stockpilotusa.com/support">Support</a>
        </nav>
        <div className="nav-right">
          <span className="nav-theme">
            <ThemeToggle />
          </span>
          <a className="nav-signin" href={SIGNIN}>
            Sign in
          </a>
          <a className="nav-cta" href={SIGNIN}>
            Open app
          </a>
          <button
            className="menu-btn"
            aria-label="Menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
        </div>
      </header>

      {menuOpen && (
        <div className="mobile-menu open">
          <a href="#product" onClick={(e) => onAnchor(e, '#product')}>
            Features
          </a>
          <a href="#how-it-works" onClick={(e) => onAnchor(e, '#how-it-works')}>
            How it works
          </a>
          <a href="#compare" onClick={(e) => onAnchor(e, '#compare')}>
            Compare
          </a>
          <a href={PRICING}>Pricing</a>
          <a href="https://stockpilotusa.com/support">Support</a>
          <a href={SIGNIN}>Sign in →</a>
        </div>
      )}

      <div id="top" className="sp-main">
        {/* 1 — HERO */}
        <section className="cine" id="hero" data-scrim=".55">
          <div className="wrap">
            <div className="eyebrow rise">Warehouse &amp; Inventory OS</div>
            <h1 className="rise">
              Inventory software <span className="serif">quiet</span> enough to actually use.
            </h1>
            <p className="lede rise">
              Inventory and order operations for teams that actually run a warehouse — counts, costs, and
              movements you can trust, without the dashboard slop.
            </p>
            <div className="cine-cta rise">
              <a className="btn primary" href={SIGNIN}>
                <span>Get started</span>
                <span className="arr">→</span>
              </a>
              <a className="btn ghost" href="#how-it-works" onClick={(e) => onAnchor(e, '#how-it-works')}>
                See how it works
              </a>
            </div>
            <div className="statstrip stagger">
              <div className="s">
                <div className="k">On hand</div>
                <div className="v">248 SKUs</div>
              </div>
              <div className="s">
                <div className="k">Today</div>
                <div className="v">47 movements</div>
              </div>
              <div className="s">
                <div className="k">Low stock</div>
                <div className="v">3 items · 1 critical</div>
              </div>
              <div className="s">
                <div className="k">Procedures</div>
                <div className="v">14 with video</div>
              </div>
              <div className="s">
                <div className="k">Real-time</div>
                <div className="v">sub-250ms sync</div>
              </div>
              <div className="s">
                <div className="k">Mobile</div>
                <div className="v">iOS + Android</div>
              </div>
            </div>
          </div>
          <div className="scroll-cue">
            <span className="dot" /> Scroll to walk the floor
          </div>
        </section>

        {/* 2 — FEATURES */}
        <section className="paper" id="product">
          <div className="wrap">
            <div className="eyebrow rise">Built for operations</div>
            <h2 className="rise">
              A counter, a calendar, and a calm place to{' '}
              <span className="serif">think about stock.</span>
            </h2>
            <div className="fgrid stagger">
              {FEATURES.map((f) => (
                <div className="fcell" key={f.title}>
                  <div className="k">{f.k}</div>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 3 — WALK THROUGH */}
        <section className="cine" data-scrim=".5">
          <div className="wrap">
            <div className="eyebrow rise">A walk through the warehouse</div>
            <h2 className="rise">
              Three things live in the <span className="serif">same room.</span>
            </h2>
            <div className="dashcard rise">
              <div className="top">
                <h4>Items</h4>
                <span>248 SKUs · $94,200 on hand</span>
              </div>
              {DASH_ROWS.map((r) => (
                <div className="dashrow" key={r.sku}>
                  <div>
                    <div className="nm">{r.nm}</div>
                    <div className="sku">{r.sku}</div>
                  </div>
                  <div className={`qty${r.zero ? ' zero' : ''}`}>{r.qty}</div>
                </div>
              ))}
            </div>
            <div className="three stagger">
              <div className="card">
                <div className="k">Items</div>
                <h3>Mean something</h3>
                <p>Origins, lots, par levels, costs — all first-class. Cycle counts that survive an audit.</p>
              </div>
              <div className="card">
                <div className="k">Movements</div>
                <h3>You can trust</h3>
                <p>Receive, sell, transfer, adjust. Every quantity change is a row you can stand behind.</p>
              </div>
              <div className="card">
                <div className="k">Purchase orders</div>
                <h3>End to end</h3>
                <p>Draft → approve → in transit → received. Three-way match against your receiving counts.</p>
              </div>
            </div>
          </div>
        </section>

        {/* 4 — AI SHELF SCAN */}
        <section className="cine rightish" data-scrim=".4">
          <div className="wrap">
            <div className="eyebrow rise">Or you skip the count entirely</div>
            <h2 className="rise">
              And the phone counts the shelf <span className="serif">for you.</span>
            </h2>
            <p className="lede rise">
              Snap one photo of a shelf. The AI reads every spine and reconciles the line —{' '}
              <b>6 lines in 6.4 seconds</b> — while the manual count is still finding a pen.
            </p>
            <div className="scan stagger">
              <div className="pill">
                <div className="lab">Manual cycle count</div>
                <div className="big">
                  20 min<span className="u"> / shelf</span>
                </div>
              </div>
              <div className="pill win">
                <div className="lab">AI Shelf Scan</div>
                <div className="big">
                  &lt; 30 sec<span className="u"> / shelf</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 5 — ORDER FLOW */}
        <section className="cine" id="how-it-works" data-scrim=".62">
          <div className="wrap">
            <div className="eyebrow rise">One order, end to end</div>
            <h2 className="rise">
              From request to <span className="serif">receiving dock.</span>
            </h2>
            <div className="steps stagger">
              {STEPS.map((s, i) => (
                <div className="step" key={s.title}>
                  <div className="n">{String(i + 1).padStart(2, '0')}</div>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* marquee */}
        <div className="marquee" aria-hidden>
          <div className="track">
            {[...MARQUEE, ...MARQUEE].map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </div>
        </div>

        {/* 6 — TRUST STATS */}
        <section className="paper">
          <div className="wrap">
            <div className="eyebrow rise">Built to be trusted</div>
            <h2 className="rise">
              Accountability is a <span className="serif">feature.</span>
            </h2>
            <div className="stats stagger">
              <div className="stat">
                <div className="tag">Real-time sync</div>
                <div className="num" data-count="240" data-suffix="ms">
                  0ms
                </div>
                <div className="lab">Web ↔ native push — counts land before you look up.</div>
              </div>
              <div className="stat">
                <div className="tag">Live integrations</div>
                <div className="num" data-count="6">
                  0
                </div>
                <div className="lab">QuickBooks, Slack, Teams, webhooks, public API &amp; more.</div>
              </div>
              <div className="stat">
                <div className="tag">Of changes audited</div>
                <div className="num" data-count="100" data-suffix="%">
                  0%
                </div>
                <div className="lab">Every change, order, and admin action logged.</div>
              </div>
              <div className="stat">
                <div className="tag">Tenant isolation</div>
                <div className="num num-text">Multi-tenant</div>
                <div className="lab">RLS-secured by default.</div>
              </div>
            </div>
          </div>
        </section>

        {/* 7 — COMPARE */}
        <section className="paper" id="compare">
          <div className="wrap">
            <div className="eyebrow rise">How we compare</div>
            <h2 className="rise">
              Everything a real operation needs. <span className="serif">Most tools stop short.</span>
            </h2>
            <div className="ctable rise">
              <div className="hd">
                <div>Capability</div>
                <div className="me">StockPilot</div>
                <div>Sortly</div>
                <div>Spreadsheets</div>
              </div>
              {COMPARE.map((row) => (
                <div className="tr" key={row.feat}>
                  <div className="feat">{row.feat}</div>
                  <div className="c me">
                    <Mark v={row.cells[0]} />
                  </div>
                  <div className="c">
                    <Mark v={row.cells[1]} />
                  </div>
                  <div className="c">
                    <Mark v={row.cells[2]} />
                  </div>
                </div>
              ))}
            </div>
            <p className="foot-note">
              <span className="dotyes inline" /> included &nbsp; <span className="dotlim inline" /> limited or
              higher-tier &nbsp; — not available. &nbsp; Sortly capabilities are summarized in good faith from
              their public pricing (sortly.com) as of June 2026; several require Premium, Ultra, or Enterprise
              plans. Verify current details with each vendor.
            </p>
          </div>
        </section>

        {/* 8 — ENTERPRISE */}
        <section className="cine" data-scrim=".6">
          <div className="wrap">
            <div className="eyebrow rise">Versus the big platforms</div>
            <h2 className="rise">
              Enterprise capability. Without the enterprise <span className="serif">tax.</span>
            </h2>
            <p className="lede rise">
              The Oracle-owned NetSuite, SAP, Manhattan, Blue Yonder — the suites a big warehouse runs on — can
              do all of this too. After a six-figure contract and the better part of a year standing it up.
              Here&apos;s the math.
            </p>
            <div className="ent stagger">
              <div className="col us">
                <div className="t">StockPilot</div>
                <div className="price">from $149/mo</div>
                <p>≈ $1,788 a year — every feature, every site you run, your whole team. Live this afternoon.</p>
              </div>
              <div className="col">
                <div className="t">NetSuite · SAP · Oracle · Manhattan</div>
                <div className="price">$100k–$250k+/yr</div>
                <p>Plus a 6–18 month implementation, integrator fees, and per-seat licensing — before anyone scans a thing.</p>
              </div>
            </div>
            <div className="entrows rise">
              {ENTROWS.map((r) => (
                <div className="entrow" key={r.l}>
                  <span className="l">{r.l}</span>
                  <span className="us">{r.us}</span>
                  <span className="them">{r.them}</span>
                </div>
              ))}
            </div>
            <div className="cine-cta rise">
              <a className="btn primary" href={SIGNIN}>
                <span>Start today</span>
                <span className="arr">→</span>
              </a>
              <a className="btn ghost" href={PRICING}>
                See pricing
              </a>
            </div>
          </div>
        </section>

        {/* 9 — PRIVACY */}
        <section className="paper">
          <div className="wrap">
            <div className="eyebrow rise">How we protect your privacy</div>
            <h2 className="rise">
              Your inventory is your business. <span className="serif">We keep it that way.</span>
            </h2>
            <div className="pgrid stagger">
              {PRIVACY.map((p) => (
                <div className="pcell" key={p.title}>
                  <h3>{p.title}</h3>
                  <p>{p.body}</p>
                </div>
              ))}
            </div>
            <p className="fineprint">
              The fine print, in plain language:{' '}
              <a href="https://stockpilotusa.com/privacy">Privacy Policy</a> ·{' '}
              <a href="https://stockpilotusa.com/privacy#california">California privacy rights</a> ·{' '}
              <a href="https://stockpilotusa.com/terms">Terms of Service</a>
            </p>
          </div>
        </section>

        {/* 10 — FINAL CTA */}
        <section className="cine" id="cta" data-scrim=".48">
          <div className="wrap">
            <div className="eyebrow rise" style={{ justifyContent: 'center' }}>
              Start today
            </div>
            <h2 className="rise">
              Get your stock under <span className="serif">control.</span>
            </h2>
            <p className="lede rise">
              Counts, transfers, receiving, reorder alerts, and a native mobile app — for every site you run.
              Start free.
            </p>
            <div className="cine-cta rise">
              <a className="btn primary" href={SIGNIN}>
                <span>Get started</span>
                <span className="arr">→</span>
              </a>
              <a className="btn ghost" href={PRICING}>
                See pricing
              </a>
            </div>
          </div>
        </section>
      </div>

      <footer className="ft">
        <div className="wrap">
          <div className="ftgrid">
            <div className="ftbrand">
              <div className="wm">
                <BrandGlyph ink />
                <span>StockPilot</span>
              </div>
              <p>Inventory + order operations for modern teams.</p>
              <a className="mail" href="mailto:hello@stockpilotusa.com">
                hello@stockpilotusa.com
              </a>
            </div>
            <div className="ftcol">
              <h5>Product</h5>
              <a href="#product" onClick={(e) => onAnchor(e, '#product')}>
                Features
              </a>
              <a href="#how-it-works" onClick={(e) => onAnchor(e, '#how-it-works')}>
                How it works
              </a>
              <a href="#compare" onClick={(e) => onAnchor(e, '#compare')}>
                Compare
              </a>
              <a href={PRICING}>Pricing</a>
            </div>
            <div className="ftcol">
              <h5>Company</h5>
              <a href="https://stockpilotusa.com/contact">Contact</a>
              <a href="https://stockpilotusa.com/support">Support</a>
            </div>
            <div className="ftcol">
              <h5>Legal</h5>
              <a href="https://stockpilotusa.com/privacy">Privacy Policy</a>
              <a href="https://stockpilotusa.com/terms">Terms of Service</a>
              <a href="https://stockpilotusa.com/security">Security</a>
              <a href="https://stockpilotusa.com/privacy#california">California privacy</a>
            </div>
          </div>
          <div className="ftbottom">
            <span>© 2026 StockPilot — Inventory + order operations</span>
            <span className="legal">
              <a href="https://stockpilotusa.com/privacy">Privacy</a>
              <a href="https://stockpilotusa.com/terms">Terms</a>
              <a href="https://stockpilotusa.com/security">Security</a>
              <a href="https://stockpilotusa.com/support">Support</a>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}

// (sp-main closes above; footer is a sibling of the scrollable content)

type Cell = 'yes' | 'lim' | 'no';

function Mark({ v }: { v: Cell }) {
  if (v === 'yes') return <span className="dotyes" />;
  if (v === 'lim') return <span className="dotlim" />;
  return <span className="dotno">—</span>;
}

function BrandGlyph({ ink }: { ink?: boolean }) {
  const id = ink ? 'sp-fm' : 'sp-nm';
  return (
    <svg className="glyph" viewBox="0 0 100 100" aria-hidden>
      <mask id={id}>
        <rect width="100" height="100" fill="#fff" />
        <path
          d="M64 38 q0 -10 -14 -10 q-14 0 -14 11 q0 9 14 11 q14 2 14 11 q0 11 -14 11 q-14 0 -14 -10"
          fill="none"
          stroke="#000"
          strokeWidth="9"
          strokeLinecap="round"
        />
      </mask>
      <rect x="12" y="12" width="76" height="76" rx="16" fill={ink ? 'currentColor' : '#faf9f4'} mask={`url(#${id})`} />
      <circle cx="72" cy="24" r="6" fill="#5db89f" />
    </svg>
  );
}

const FEATURES = [
  { k: 'Items', title: 'Items that mean something', body: 'Not just SKUs. Origins, lots, par levels, sell prices, costs — all first-class. Cycle counts that survive an audit.' },
  { k: 'Movements', title: 'Movements you can trust', body: 'Receive, sell, transfer, adjust. Every quantity change is a row you can stand behind. Bulk reverse with a keyboard shortcut.' },
  { k: 'Purchasing', title: 'Purchase orders, end to end', body: 'Draft → approve → in transit → received. Three-way match against your receiving counts. No mystery variance.' },
  { k: 'Insight', title: 'Sparklines on everything', body: 'Trend, coverage, and weekly draw on every row of every table. The chart is the table.' },
  { k: 'Speed', title: 'Cmd-K, everywhere', body: 'Jump to any item, run any action, kick off a count — without lifting your hands. Built for operators who already know what they want.' },
  { k: 'Security', title: 'Multi-tenant by default', body: 'Workspaces, roles, RLS at the database level. One login, every site you run. No spreadsheets-in-WhatsApp.' },
];

const DASH_ROWS = [
  { nm: 'Algebra I · Grade 9', sku: 'TXT-ALG-G9-2026', qty: '312 ea' },
  { nm: 'Biology · Grade 10', sku: 'TXT-BIO-G10-2026', qty: '96 ea' },
  { nm: 'Chromebook 11" (student)', sku: 'DEV-CHR-11-EDU', qty: '0 ea', zero: true },
  { nm: 'Copy paper · letter (case)', sku: 'SUP-PAP-LTR-CT', qty: '184 case' },
];

const STEPS = [
  { title: 'Request', body: 'A team member submits an order from the catalog — on the web app or their phone.' },
  { title: 'Approve', body: 'A manager approves it; stock is reserved against the warehouse the instant they do.' },
  { title: 'Pick', body: 'Pick slip generated. Scan items off the shelf — quantities reconcile as you go.' },
  { title: 'Pack & stage', body: 'Packing slips print, the order is staged for pickup or delivery.' },
  { title: 'Deliver', body: 'Out for delivery with live map tracking, or handed off at the dock.' },
  { title: 'Signed & closed', body: 'Proof of delivery + signature captured. The audit trail closes the loop.' },
];

const MARQUEE = ['Receive', 'Transfer', 'Cycle count', 'Reorder', 'Pick', 'Pack', 'Deliver', 'Reconcile', 'Audit', 'Sync', 'Forecast', 'Restock'];

const COMPARE: Array<{ feat: string; cells: [Cell, Cell, Cell] }> = [
  { feat: 'Real-time web + native mobile sync', cells: ['yes', 'yes', 'no'] },
  { feat: 'Live delivery tracking on a map', cells: ['yes', 'no', 'no'] },
  { feat: 'Lot / expiry (FEFO) tracking', cells: ['yes', 'no', 'no'] },
  { feat: 'Purchase orders + 3-way match', cells: ['yes', 'lim', 'no'] },
  { feat: 'Audit-grade cycle counts', cells: ['yes', 'lim', 'no'] },
  { feat: 'Returns / RMA workflow', cells: ['yes', 'no', 'no'] },
  { feat: 'AI insights briefing', cells: ['yes', 'no', 'no'] },
  { feat: 'Webhooks · Slack · Teams', cells: ['yes', 'lim', 'no'] },
  { feat: 'Public API + API keys', cells: ['yes', 'lim', 'no'] },
  { feat: 'QuickBooks integration', cells: ['yes', 'yes', 'no'] },
  { feat: 'Multi-tenant + role / RLS security', cells: ['yes', 'lim', 'no'] },
  { feat: 'Full audit log / activity history', cells: ['yes', 'yes', 'no'] },
];

const ENTROWS = [
  { l: 'Live in', us: 'The same afternoon', them: '6–18 month rollouts' },
  { l: 'Setup', us: 'Self-serve — no consultants', them: 'Statement of work, integrator, training' },
  { l: 'Mobile', us: 'Native app, included day one', them: 'Add-on or third-party module' },
  { l: 'Experience', us: 'Modern and fast, no training', them: 'Powerful, but legacy and heavy' },
  { l: 'Upgrades', us: 'Continuous + automatic', them: 'Costly, scheduled upgrade projects' },
];

const PRIVACY = [
  { title: 'Isolation enforced in the database', body: 'Every row is scoped to your organization with PostgreSQL row-level security. Tenant isolation is enforced by the database itself — not just the app code in front of it.' },
  { title: 'Encrypted in transit and at rest', body: 'All traffic runs over TLS, and your data is encrypted at rest (AES-256). Secrets and API keys are stored hashed — we can’t read them back either.' },
  { title: 'Two-factor authentication', body: 'TOTP two-factor auth on web and mobile, on by default for admin accounts. Rate limiting guards sign-in and every sensitive endpoint.' },
  { title: 'New-device sign-in alerts', body: 'Sign in from a device we haven’t seen before and the account owner gets notified — so a stolen password doesn’t go unnoticed.' },
  { title: 'A full audit trail', body: 'Every inventory change, order, and admin action lands in an audit log with who, what, and when. Accountability is a feature, not an afterthought.' },
  { title: 'Your data stays yours', body: 'We don’t sell or share your data — no ads, no brokers. Export everything to CSV, Excel, or PDF anytime, and delete your account whenever you choose.' },
];

function SpStyles() {
  return <style>{CSS}</style>;
}

const CSS = `
#sp-landing{
  --paper:#faf9f4; --paper-2:#f4f3ee; --ink:#0e0f0d; --mint:#5db89f; --mint-bright:#7acdb8;
  --amber:#ce983b; --muted:#5a5d56; --line:#e7e5dd; --line-strong:#d4d2c8;
  --line-dark:rgba(255,255,255,.14); --paper-dim:rgba(250,249,244,.64);
  position:relative; z-index:0; color:var(--paper);
  font-family:var(--font-sans, ui-sans-serif, system-ui, sans-serif);
}
#sp-landing ::selection{background:var(--mint);color:var(--ink)}
#sp-landing a{color:inherit}

#sp-stage{position:fixed;inset:0;z-index:0;background:#0b0c0a;overflow:hidden}
#sp-film,#sp-poster{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:saturate(.92) contrast(1.02) brightness(.96)}
#sp-scrim{position:absolute;inset:0;z-index:1;pointer-events:none;opacity:.5;transition:opacity .6s ease;
  background:radial-gradient(120% 90% at 50% 14%,rgba(8,9,7,0) 36%,rgba(8,9,7,.34) 100%),
    linear-gradient(180deg,rgba(8,9,7,.58) 0%,rgba(8,9,7,.16) 24%,rgba(8,9,7,.12) 56%,rgba(8,9,7,.66) 100%)}
#sp-grain{position:absolute;inset:0;z-index:2;pointer-events:none;opacity:.05;mix-blend-mode:overlay;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>")}
#sp-vignette{position:absolute;inset:0;z-index:2;pointer-events:none;box-shadow:inset 0 0 220px 40px rgba(0,0,0,.5)}

#sp-progress{position:fixed;top:0;left:0;height:2px;width:0;z-index:50;background:linear-gradient(90deg,var(--mint),var(--mint-bright));box-shadow:0 0 14px rgba(93,184,159,.7)}

#sp-landing .sp-nav{position:fixed;top:0;left:0;right:0;z-index:40;display:flex;align-items:center;justify-content:space-between;
  padding:14px clamp(18px,4vw,52px);transition:background .4s ease,backdrop-filter .4s ease,border-color .4s ease;border-bottom:1px solid transparent}
#sp-landing .sp-nav.solid{background:rgba(11,12,10,.72);backdrop-filter:blur(14px) saturate(1.2);border-bottom:1px solid var(--line-dark)}
#sp-landing .brand{display:flex;align-items:center;gap:11px;text-decoration:none}
#sp-landing .glyph{width:26px;height:26px;flex:none}
#sp-landing .wordmark{font-family:var(--font-display);font-weight:600;letter-spacing:-.02em;font-size:18px;color:var(--paper)}
#sp-landing .wordmark b{font-weight:600}#sp-landing .wordmark span{font-weight:500;opacity:.55}
#sp-landing .nav-links{display:flex;align-items:center;gap:28px}
#sp-landing .nav-links a{font-size:14px;font-weight:440;color:var(--paper-dim);text-decoration:none;transition:.2s}
#sp-landing .nav-links a:hover{color:var(--paper)}
#sp-landing .nav-right{display:flex;align-items:center;gap:12px}
#sp-landing .nav-theme{color:var(--paper);display:inline-flex}
#sp-landing .nav-signin{font-size:14px;font-weight:480;color:var(--paper-dim);text-decoration:none;transition:.2s}
#sp-landing .nav-signin:hover{color:var(--paper)}
#sp-landing .nav-cta{font-family:var(--font-display);font-weight:560;font-size:14px;color:var(--ink);background:var(--mint);
  border-radius:999px;padding:9px 18px;text-decoration:none;transition:.25s}
#sp-landing .nav-cta:hover{background:var(--mint-bright)}
#sp-landing .menu-btn{display:none;background:none;border:1px solid rgba(255,255,255,.28);border-radius:9px;width:40px;height:34px;color:var(--paper);cursor:pointer;align-items:center;justify-content:center;padding:0}
#sp-landing .menu-btn svg{width:18px;height:18px}
#sp-landing .mobile-menu{position:fixed;top:58px;left:0;right:0;z-index:39;background:rgba(11,12,10,.97);backdrop-filter:blur(14px);
  border-bottom:1px solid var(--line-dark);display:flex;flex-direction:column;padding:6px clamp(18px,4vw,52px) 16px}
#sp-landing .mobile-menu a{padding:14px 2px;font-size:16px;font-weight:480;color:var(--paper);text-decoration:none;border-bottom:1px solid var(--line-dark)}
#sp-landing .mobile-menu a:last-child{border-bottom:none;color:var(--mint-bright)}

#sp-landing .sp-main{position:relative;z-index:10}
#sp-landing section{position:relative}
#sp-landing .wrap{max-width:1180px;margin:0 auto;padding:0 clamp(20px,5vw,64px)}
#sp-landing .cine{min-height:100vh;display:flex;flex-direction:column;justify-content:center;padding:15vh 0}
#sp-landing .cine .wrap{width:100%}
#sp-landing .cine.rightish .wrap{display:flex;flex-direction:column;align-items:flex-end;text-align:right}
#sp-landing .eyebrow{font-family:var(--font-mono);font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:var(--mint-bright);display:flex;align-items:center;gap:12px;margin-bottom:22px}
#sp-landing .eyebrow::before{content:"";width:28px;height:1px;background:var(--mint)}
#sp-landing .rightish .eyebrow{flex-direction:row-reverse}
#sp-landing h1{font-family:var(--font-display);font-weight:600;letter-spacing:-.035em;line-height:.97;font-size:clamp(40px,7.2vw,104px);max-width:15ch;margin:0}
#sp-landing h2{font-family:var(--font-display);font-weight:600;letter-spacing:-.03em;line-height:1.02;font-size:clamp(30px,5vw,68px);max-width:18ch;margin:0}
#sp-landing .serif{font-family:var(--font-serif);font-style:italic;font-weight:400}
#sp-landing .lede{font-size:clamp(16px,1.45vw,21px);line-height:1.5;color:var(--paper-dim);max-width:46ch;margin-top:24px;font-weight:380}
#sp-landing .lede b{color:var(--paper)}
#sp-landing .cine-cta{display:flex;gap:14px;margin-top:34px;flex-wrap:wrap}
#sp-landing .rightish .cine-cta{justify-content:flex-end}
#sp-landing .btn{display:inline-flex;align-items:center;gap:10px;font-family:var(--font-display);font-weight:560;font-size:16px;padding:14px 26px;border-radius:999px;text-decoration:none;transition:.25s;border:1px solid transparent;cursor:pointer}
#sp-landing .btn.primary{background:var(--mint);color:var(--ink);border-color:var(--mint)}
#sp-landing .btn.primary:hover{background:var(--mint-bright)}
#sp-landing .btn.ghost{color:var(--paper);border-color:rgba(255,255,255,.32);backdrop-filter:blur(6px)}
#sp-landing .btn.ghost:hover{border-color:var(--mint);color:var(--mint-bright)}
#sp-landing .btn .arr{transition:transform .25s}#sp-landing .btn:hover .arr{transform:translateX(4px)}
#sp-landing .scroll-cue{position:absolute;bottom:30px;left:clamp(20px,5vw,64px);font-family:var(--font-mono);font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--paper-dim);display:flex;align-items:center;gap:10px}
#sp-landing .scroll-cue .dot{width:6px;height:6px;border-radius:50%;background:var(--mint);animation:sp-pulse 1.8s ease-in-out infinite}
@keyframes sp-pulse{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1.3)}}

#sp-landing .rise{opacity:0;transform:translateY(26px);transition:opacity .9s cubic-bezier(.2,.7,.2,1),transform .9s cubic-bezier(.2,.7,.2,1)}
#sp-landing .rise.in{opacity:1;transform:none}
#sp-landing .stagger>*{opacity:0;transform:translateY(22px);transition:opacity .8s cubic-bezier(.2,.7,.2,1),transform .8s cubic-bezier(.2,.7,.2,1)}
#sp-landing .stagger.in>*{opacity:1;transform:none}
#sp-landing .stagger.in>*:nth-child(2){transition-delay:.06s}#sp-landing .stagger.in>*:nth-child(3){transition-delay:.12s}
#sp-landing .stagger.in>*:nth-child(4){transition-delay:.18s}#sp-landing .stagger.in>*:nth-child(5){transition-delay:.24s}
#sp-landing .stagger.in>*:nth-child(6){transition-delay:.30s}

#sp-landing .statstrip{display:flex;flex-wrap:wrap;gap:0;margin-top:46px;border-top:1px solid var(--line-dark);border-bottom:1px solid var(--line-dark)}
#sp-landing .statstrip .s{padding:18px 26px 18px 0;margin-right:26px;border-right:1px solid var(--line-dark)}
#sp-landing .statstrip .s:last-child{border-right:none}
#sp-landing .statstrip .k{font-family:var(--font-mono);font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--mint-bright)}
#sp-landing .statstrip .v{font-family:var(--font-display);font-weight:600;font-size:18px;margin-top:7px;letter-spacing:-.01em;color:var(--paper)}

#sp-landing .dashcard{margin-top:42px;max-width:520px;border:1px solid var(--line-dark);border-radius:16px;overflow:hidden;background:rgba(12,13,10,.55);backdrop-filter:blur(12px)}
#sp-landing .dashcard .top{display:flex;align-items:baseline;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--line-dark)}
#sp-landing .dashcard .top h4{font-family:var(--font-display);font-weight:600;font-size:15px;margin:0}
#sp-landing .dashcard .top span{font-family:var(--font-mono);font-size:11px;color:var(--paper-dim)}
#sp-landing .dashrow{display:grid;grid-template-columns:1fr auto;gap:10px;padding:12px 20px;border-bottom:1px solid rgba(255,255,255,.07);align-items:center}
#sp-landing .dashrow:last-child{border-bottom:none}
#sp-landing .dashrow .nm{font-size:13.5px;font-weight:440}
#sp-landing .dashrow .sku{font-family:var(--font-mono);font-size:10.5px;color:var(--paper-dim);margin-top:2px}
#sp-landing .dashrow .qty{font-family:var(--font-mono);font-size:13px;color:var(--mint-bright)}
#sp-landing .dashrow .qty.zero{color:var(--amber)}

#sp-landing .three{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin-top:42px}
#sp-landing .card{border:1px solid var(--line-dark);border-radius:14px;padding:24px 22px;background:rgba(12,13,10,.46);backdrop-filter:blur(9px)}
#sp-landing .card .k{font-family:var(--font-mono);font-size:11px;letter-spacing:.16em;color:var(--mint-bright);text-transform:uppercase}
#sp-landing .card h3{font-family:var(--font-display);font-weight:600;font-size:20px;margin:12px 0 8px;letter-spacing:-.01em}
#sp-landing .card p{font-size:14px;line-height:1.5;color:var(--paper-dim);font-weight:380;margin:0}

#sp-landing .scan{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:40px;max-width:760px}
#sp-landing .scan .pill{border:1px solid var(--line-dark);border-radius:14px;padding:24px 22px;background:rgba(12,13,10,.46);backdrop-filter:blur(9px)}
#sp-landing .scan .pill .lab{font-family:var(--font-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--paper-dim)}
#sp-landing .scan .pill .big{font-family:var(--font-display);font-weight:600;font-size:30px;letter-spacing:-.02em;margin-top:10px}
#sp-landing .scan .pill .big .u{font-size:.5em;color:var(--paper-dim)}
#sp-landing .scan .pill.win{border-color:rgba(93,184,159,.5);background:rgba(93,184,159,.1)}
#sp-landing .scan .pill.win .lab{color:var(--mint-bright)}#sp-landing .scan .pill.win .big{color:var(--mint-bright)}

#sp-landing .steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-top:44px}
#sp-landing .step{border:1px solid var(--line-dark);border-radius:14px;padding:22px 20px;background:rgba(12,13,10,.5);backdrop-filter:blur(9px)}
#sp-landing .step .n{font-family:var(--font-mono);font-size:12px;color:var(--mint);letter-spacing:.1em}
#sp-landing .step h3{font-family:var(--font-display);font-weight:600;font-size:18px;margin:10px 0 7px}
#sp-landing .step p{font-size:13.5px;line-height:1.5;color:var(--paper-dim);font-weight:380;margin:0}

#sp-landing .marquee{overflow:hidden;border-top:1px solid var(--line-dark);border-bottom:1px solid var(--line-dark);padding:26px 0;background:rgba(11,12,10,.4);position:relative;z-index:11}
#sp-landing .marquee .track{display:flex;gap:0;white-space:nowrap;width:max-content;animation:sp-scrollx 28s linear infinite}
#sp-landing .marquee span{font-family:var(--font-display);font-weight:600;font-size:clamp(22px,3vw,40px);letter-spacing:-.02em;color:var(--paper);opacity:.9;padding:0 30px;display:inline-flex;align-items:center;gap:30px}
#sp-landing .marquee span::after{content:"·";color:var(--mint)}
@keyframes sp-scrollx{to{transform:translateX(-50%)}}

#sp-landing .paper{background:var(--paper);color:var(--ink);position:relative;z-index:11;padding:clamp(80px,12vh,150px) 0}
#sp-landing .paper .eyebrow{color:var(--mint)}#sp-landing .paper .eyebrow::before{background:var(--mint)}
#sp-landing .paper h2{color:var(--ink)}
#sp-landing .fgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1px;margin-top:54px;background:var(--line);border:1px solid var(--line);border-radius:18px;overflow:hidden}
#sp-landing .fcell{background:var(--paper);padding:30px 28px}
#sp-landing .fcell .k{font-family:var(--font-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--mint);margin-bottom:14px}
#sp-landing .fcell h3{font-family:var(--font-display);font-weight:600;font-size:21px;letter-spacing:-.01em;color:var(--ink);margin:0}
#sp-landing .fcell p{font-size:14.5px;line-height:1.55;color:var(--muted);margin:10px 0 0;font-weight:380}

#sp-landing .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:2px;margin-top:54px;background:var(--line);border:1px solid var(--line);border-radius:18px;overflow:hidden}
#sp-landing .stat{background:var(--paper);padding:30px 26px}
#sp-landing .stat .num{font-family:var(--font-display);font-weight:600;font-size:clamp(38px,4.6vw,58px);letter-spacing:-.04em;color:var(--ink);line-height:1}
#sp-landing .stat .num.num-text{font-size:clamp(26px,3vw,38px)}
#sp-landing .stat .lab{font-size:13.5px;line-height:1.45;color:var(--muted);margin-top:12px;max-width:24ch}
#sp-landing .stat .tag{font-family:var(--font-mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--mint);margin-bottom:14px}

#sp-landing .ctable{margin-top:50px;border:1px solid var(--line);border-radius:18px;overflow:hidden}
#sp-landing .ctable .hd,#sp-landing .ctable .tr{display:grid;grid-template-columns:1.6fr .8fr .8fr .9fr}
#sp-landing .ctable .hd{background:var(--paper-2);border-bottom:1px solid var(--line)}
#sp-landing .ctable .hd>div{padding:18px 20px;font-family:var(--font-display);font-weight:600;font-size:14px}
#sp-landing .ctable .hd>div:not(:first-child){text-align:center}
#sp-landing .ctable .hd .me{color:var(--mint)}
#sp-landing .ctable .tr{border-bottom:1px solid var(--line)}
#sp-landing .ctable .tr:last-child{border-bottom:none}
#sp-landing .ctable .tr>div{padding:15px 20px;font-size:14px;display:flex;align-items:center}
#sp-landing .ctable .tr .feat{color:var(--ink);font-weight:440}
#sp-landing .ctable .tr .c{justify-content:center;color:var(--muted)}
#sp-landing .ctable .tr .c.me{background:rgba(93,184,159,.07)}
#sp-landing .dotyes{width:18px;height:18px;border-radius:50%;background:var(--mint);position:relative;display:inline-block}
#sp-landing .dotyes::after{content:"";position:absolute;left:50%;top:47%;width:4px;height:7px;border:2px solid #fff;border-top:0;border-left:0;transform:translate(-50%,-50%) rotate(45deg)}
#sp-landing .dotlim{width:18px;height:18px;border-radius:50%;border:2px solid var(--amber);background:linear-gradient(90deg,var(--amber) 50%,transparent 50%);display:inline-block}
#sp-landing .dotno{color:var(--line-strong);font-size:18px}
#sp-landing .dotyes.inline,#sp-landing .dotlim.inline{vertical-align:-3px}
#sp-landing .foot-note{font-size:12px;color:var(--muted);margin-top:18px;max-width:70ch;line-height:1.5}

#sp-landing .ent{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:46px;max-width:920px}
#sp-landing .ent .col{border:1px solid var(--line-dark);border-radius:16px;padding:28px 26px;background:rgba(12,13,10,.55);backdrop-filter:blur(10px)}
#sp-landing .ent .col.us{border-color:rgba(93,184,159,.5);background:rgba(93,184,159,.1)}
#sp-landing .ent .col .t{font-family:var(--font-mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--paper-dim)}
#sp-landing .ent .col.us .t{color:var(--mint-bright)}
#sp-landing .ent .col .price{font-family:var(--font-display);font-weight:600;font-size:clamp(28px,3.4vw,42px);letter-spacing:-.02em;margin:12px 0;color:var(--paper)}
#sp-landing .ent .col p{font-size:13.5px;line-height:1.5;color:var(--paper-dim);margin:0}
#sp-landing .entrows{margin-top:18px;display:flex;flex-direction:column;gap:1px;border:1px solid var(--line-dark);border-radius:14px;overflow:hidden;max-width:920px}
#sp-landing .entrow{display:grid;grid-template-columns:120px 1fr 1fr;gap:14px;padding:14px 18px;background:rgba(12,13,10,.5);font-size:13.5px;align-items:center}
#sp-landing .entrow .l{font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--paper-dim)}
#sp-landing .entrow .us{color:var(--mint-bright);font-weight:460}
#sp-landing .entrow .them{color:var(--paper-dim)}

#sp-landing .pgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1px;margin-top:54px;background:var(--line);border:1px solid var(--line);border-radius:18px;overflow:hidden}
#sp-landing .pcell{background:var(--paper);padding:30px 28px}
#sp-landing .pcell h3{font-family:var(--font-display);font-weight:600;font-size:19px;color:var(--ink);display:flex;gap:10px;align-items:center;margin:0}
#sp-landing .pcell h3::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--mint);flex:none}
#sp-landing .pcell p{font-size:14px;line-height:1.55;color:var(--muted);margin:10px 0 0;font-weight:380}
#sp-landing .fineprint{margin-top:26px;font-size:13.5px;color:var(--muted)}
#sp-landing .fineprint a{color:var(--mint);text-decoration:none}#sp-landing .fineprint a:hover{text-decoration:underline}

#sp-landing #cta{text-align:center;align-items:center}
#sp-landing #cta .wrap{display:flex;flex-direction:column;align-items:center}
#sp-landing #cta h2{font-size:clamp(40px,6.6vw,90px);max-width:18ch}
#sp-landing #cta .lede{text-align:center;max-width:50ch}
#sp-landing #cta .cine-cta{justify-content:center}

#sp-landing .ft{background:var(--paper);color:var(--ink);position:relative;z-index:11;padding:70px 0 40px}
#sp-landing .ftgrid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:40px}
#sp-landing .ftbrand .wm{font-family:var(--font-display);font-weight:600;font-size:20px;color:var(--ink);display:flex;align-items:center;gap:10px}
#sp-landing .ftbrand p{font-size:14px;color:var(--muted);margin:14px 0 0;max-width:30ch}
#sp-landing .ftbrand a.mail{font-family:var(--font-mono);font-size:13px;color:var(--mint);text-decoration:none;margin-top:14px;display:inline-block}
#sp-landing .ftcol h5{font-family:var(--font-mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:16px}
#sp-landing .ftcol a{display:block;font-size:14px;color:var(--ink);text-decoration:none;margin-bottom:10px;opacity:.85;transition:.2s}
#sp-landing .ftcol a:hover{opacity:1;color:var(--mint)}
#sp-landing .ftbottom{display:flex;justify-content:space-between;align-items:center;margin-top:54px;padding-top:24px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)}
#sp-landing .ftbottom .legal{display:flex;gap:18px}#sp-landing .ftbottom .legal a{color:var(--muted);text-decoration:none}#sp-landing .ftbottom .legal a:hover{color:var(--ink)}

@media (max-width:860px){
  #sp-landing .nav-links{display:none}
  #sp-landing .menu-btn{display:inline-flex}
  #sp-landing .nav-signin{display:none}
  #sp-landing .ent{grid-template-columns:1fr}
  #sp-landing .ctable .hd,#sp-landing .ctable .tr{grid-template-columns:1.4fr .7fr .7fr .8fr;font-size:12.5px}
  #sp-landing .ftgrid{grid-template-columns:1fr 1fr;gap:30px}
  #sp-landing .ftbrand{grid-column:1/-1}
}
@media (max-width:560px){
  #sp-landing .ftgrid{grid-template-columns:1fr}
  #sp-landing .ftbottom{flex-direction:column;gap:14px}
  #sp-landing .entrow{grid-template-columns:90px 1fr 1fr}
}
@media (prefers-reduced-motion:reduce){
  #sp-landing .rise,#sp-landing .stagger>*{transition:none;opacity:1;transform:none}
  #sp-landing .marquee .track{animation:none}
}

/* ===== dark mode (next-themes .dark) — flip the paper panels + footer to ink ===== */
.dark #sp-landing .paper, .dark #sp-landing .ft{
  --paper:#0c0d0a; --paper-2:#15160f; --ink:#f0efe8; --muted:#9a9d94;
  --line:rgba(255,255,255,.10); --line-strong:rgba(255,255,255,.24);
}
`;
