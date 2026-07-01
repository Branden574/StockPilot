/* global React */
// StockPilot Storefront — shell: icons, production sidebar, topbar.

const SFIcon = ({ name, size = 16, stroke = 1.5 }) => {
  const p = {
    home: <><path d="M3 11 12 4l9 7" /><path d="M5 10v10h14V10" /></>,
    boxes: <><path d="M3 8 12 4l9 4-9 4-9-4z" /><path d="M3 12l9 4 9-4" /><path d="M3 16l9 4 9-4" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /><path d="m3 17 9 5 9-5" /></>,
    book: <><path d="M4 4h6a3 3 0 0 1 3 3v14a2 2 0 0 0-2-2H4z" /><path d="M20 4h-6a3 3 0 0 0-3 3v14a2 2 0 0 1 2-2h7z" /></>,
    tag: <><path d="m3 12 9-9h8v8l-9 9z" /><circle cx="15" cy="9" r="1.4" /></>,
    arrows: <><path d="M7 7h13" /><path d="M16 3l4 4-4 4" /><path d="M17 17H4" /><path d="M8 21l-4-4 4-4" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    pkg: <><path d="m3 7 9-4 9 4-9 4z" /><path d="M3 7v10l9 4 9-4V7" /><path d="M12 11v10" /></>,
    cart: <><circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" /><path d="M2 3h3l3 13h12" /><path d="M6 7h16l-2 7H8" /></>,
    undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-4" /></>,
    refresh: <><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v5h-5" /></>,
    clipboard: <><path d="M9 4h6v3H9z" /><path d="M15 5h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" /></>,
    receipt: <><path d="M5 3h14v18l-2.3-1.5-2.3 1.5-2.4-1.5L9.6 21l-2.3-1.5L5 21z" /><path d="M9 8h6" /><path d="M9 12h6" /></>,
    repeat: <><path d="M17 2l4 4-4 4" /><path d="M3 11V9a3 3 0 0 1 3-3h15" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a3 3 0 0 1-3 3H3" /></>,
    trend: <><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
    upload: <><path d="M12 20V8" /><path d="m7 13 5-5 5 5" /><path d="M4 4h16" /></>,
    map: <><path d="m3 6 6-2 6 2 6-2v14l-6 2-6-2-6 2z" /><path d="M9 4v16" /><path d="M15 6v16" /></>,
    truck: <><path d="M3 17h12V6H3z" /><path d="M15 9h4l3 4v4h-7" /><circle cx="7" cy="18" r="2" /><circle cx="18" cy="18" r="2" /></>,
    chart: <><path d="M3 3v18h18" /><path d="M7 14l4-4 3 3 5-7" /></>,
    bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2H4.5L6 16z" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
    users: <><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17" cy="9" r="2.6" /><path d="M21 19c0-2.5-2-4.5-4.5-4.5" /></>,
    cog: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    minus: <path d="M5 12h14" />,
    x: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>,
    check: <path d="m4 12 5 5 11-11" />,
    chevD: <path d="m6 9 6 6 6-6" />,
    chevR: <path d="m9 6 6 6-6 6" />,
    chevL: <path d="m15 6-6 6 6 6" />,
    filter: <path d="M3 5h18l-7 9v6l-4-2v-4z" />,
    sort: <><path d="M7 4v16" /><path d="m3 8 4-4 4 4" /><path d="M17 20V4" /><path d="m13 16 4 4 4-4" /></>,
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
    grid: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>,
    list: <><path d="M9 6h12" /><path d="M9 12h12" /><path d="M9 18h12" /><path d="M4 5.6h1" /><path d="M4 11.6h1" /><path d="M4 17.6h1" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    moon: <path d="M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10z" />,
    sliders: <><path d="M4 7h10" /><path d="M18 7h2" /><path d="M4 17h4" /><path d="M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>,
    sparkles: <><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9z" /></>,
    lightning: <path d="m13 2-9 12h7l-1 8 9-12h-7z" />,
    briefcase: <><rect x="3" y="8" width="18" height="12" rx="2" /><path d="M9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /><path d="M3 13h18" /></>,
    gradcap: <><path d="m2 10 10-5 10 5-10 5z" /><path d="M6 12.5V17c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-4.5" /><path d="M22 10v5" /></>,
    flask: <><path d="M10 3v6l-5.2 8.6A2 2 0 0 0 6.5 21h11a2 2 0 0 0 1.7-3.4L14 9V3" /><path d="M8 3h8" /><path d="M7.5 15h9" /></>,
    shirt: <path d="M8.5 4 4 6.5 6 10l2-1v11h8V9l2 1 2-3.5L15.5 4a3.5 3.5 0 0 1-7 0z" />,
    trash: <><path d="M4 7h16" /><path d="M9 7V5h6v2" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v5" /><path d="M14 11v5" /></>,
    note: <><path d="M4 20h4l11-11-4-4L4 16z" /><path d="m14 6 4 4" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.3a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.1.9-1.1 1.7" /><path d="M11.6 16.6h.8" /></>,
    warn: <><path d="M12 3 2 20h20z" /><path d="M12 9.5v4" /><path d="M11.6 16.6h.8" /></>,
  };
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {p[name]}
    </svg>
  );
};

// =========================================================================
// Sidebar — mirrors the production L4L North Region nav
// =========================================================================
function SFSidebar() {
  const sections = [
    { label: null, items: [{ id: "overview", label: "Overview", icon: "home" }] },
    {
      label: "Inventory",
      items: [
        { id: "items", label: "Items", icon: "boxes" },
        { id: "staging", label: "Staging", icon: "layers" },
        { id: "books", label: "Books", icon: "book" },
        { id: "categories", label: "Categories", icon: "tag" },
        { id: "movements", label: "Movements", icon: "arrows" },
        { id: "rentals", label: "Rentals", icon: "clock" },
        { id: "bundles", label: "Bundles", icon: "pkg" },
        { id: "orders", label: "Orders", icon: "cart", active: true },
        { id: "returns", label: "Returns", icon: "undo" },
        { id: "cycle", label: "Cycle counts", icon: "refresh" },
        { id: "procedures", label: "Procedures", icon: "clipboard" },
        { id: "pos", label: "Purchase orders", icon: "receipt" },
        { id: "recurring", label: "Recurring POs", icon: "repeat" },
        { id: "reorder", label: "Reorder planning", icon: "trend" },
        { id: "imports", label: "PO imports", icon: "upload" },
        { id: "locations", label: "Locations", icon: "map" },
        { id: "suppliers", label: "Suppliers", icon: "truck" },
        { id: "reports", label: "Reports", icon: "chart" },
      ],
    },
    {
      label: "Workspace",
      items: [
        { id: "notifications", label: "Notifications", icon: "bell" },
        { id: "team", label: "Team", icon: "users" },
        { id: "settings", label: "Settings", icon: "cog" },
      ],
    },
  ];
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand-mark"></div>
        <span className="brand-word">StockPilot</span>
      </div>
      <button className="org-pill" type="button">
        <span className="dot"></span>
        <span style={{ flex: 1 }}>L4L North Region</span>
        <SFIcon name="chevD" size={12} />
      </button>
      <nav className="nav">
        {sections.map((s, i) => (
          <div className="nav-section" key={i}>
            {s.label && <div className="nav-section-label">{s.label}</div>}
            {s.items.map((it) => (
              <button key={it.id} className="nav-item" data-active={!!it.active} title={it.label}>
                <SFIcon name={it.icon} size={15} />
                <span>{it.label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        <div className="avatar">BV</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="user-name">Branden Vincent Walker</div>
          <div className="user-role">Super Admin · L4L North Region</div>
        </div>
      </div>
    </aside>
  );
}

// =========================================================================
// Topbar
// =========================================================================
function SFTopbar({ dark, onToggleTheme }) {
  return (
    <header className="topbar">
      <button className="icon-btn" title="Toggle sidebar"><SFIcon name="sliders" size={15} /></button>
      <div className="crumbs">
        <span>Inventory</span><span className="sep">/</span>
        <span>Orders</span><span className="sep">/</span>
        <span className="here">New</span>
      </div>
      <button className="btn ghost" style={{ marginLeft: "auto" }}>
        <SFIcon name="boxes" size={13} />
        <span>All warehouses</span>
        <SFIcon name="chevD" size={11} />
      </button>
      <button className="search-trigger" style={{ marginLeft: 0 }}>
        <SFIcon name="search" size={13} />
        <span>Search items, POs, suppliers…</span>
        <span className="kbd">⌘K</span>
      </button>
      <button className="icon-btn" title="Notifications" style={{ position: "relative" }}>
        <SFIcon name="bell" size={15} />
        <span className="dot-alert"></span>
      </button>
      <button className="icon-btn" title="Help"><SFIcon name="help" size={15} /></button>
      <button className="icon-btn" title="Theme" onClick={onToggleTheme}>
        <SFIcon name={dark ? "sun" : "moon"} size={15} />
      </button>
      <div className="avatar" style={{ width: 28, height: 28 }}>BV</div>
    </header>
  );
}

Object.assign(window, { SFIcon, SFSidebar, SFTopbar });
