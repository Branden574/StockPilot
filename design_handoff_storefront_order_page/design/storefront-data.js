// StockPilot Storefront — L4L North Region sample catalog
// Mirrors the production /dashboard/orders/new data shapes.
(function () {
  const P = "products/";

  const ITEMS = [
    // ---- New Hire kit ----------------------------------------------------
    { sku: "SP-Q2MPL-NHP", name: "L4L New Hire — Planner",             cat: "New Hire", stock: 64,  low: 10, img: P + "planner.png",  loc: "A2-08", freq: 12, desc: "Undated weekly planner with the L4L North Region cover. Part of the standard new-hire kit." },
    { sku: "SP-M4KPD-NHM", name: "L4L New Hire — Mouse Pad",           cat: "New Hire", stock: 88,  low: 10, img: P + "mousepad.png", loc: "A2-09", freq: 11, desc: "Round fabric-top mouse pad, learn4life mark. Standard new-hire kit item." },
    { sku: "SP-B7RKS-NHB", name: "L4L New Hire — Backpack",            cat: "New Hire", stock: 41,  low: 10, img: P + "backpack.png", loc: "A2-11", freq: 10, desc: "Grey 15\" laptop backpack with embroidered logo." },
    { sku: "SP-C9MUG-NHC", name: "L4L New Hire — Coffee Mug",          cat: "New Hire", stock: 120, low: 12, img: P + "mug.png",      loc: "A2-10", freq: 9,  desc: "11 oz ceramic mug, learn4life wordmark." },
    { sku: "SP-P2WPM-NHW", name: "L4L New Hire — Women's Polo · M",    cat: "New Hire", stock: 18,  low: 20, img: P + "polo-w.png",   loc: "A3-02", freq: 8,  desc: "Navy performance polo, women's cut, embroidered chest logo." },
    { sku: "SP-P3MPL-NHM", name: "L4L New Hire — Men's Polo · L",      cat: "New Hire", stock: 23,  low: 20, img: P + "polo-m.png",   loc: "A3-04", freq: 8,  desc: "Navy performance polo, men's cut, embroidered chest logo." },

    // ---- Community Events (8) ---------------------------------------------
    { sku: "SP-X1WZH-XME", name: "L4L Clear Water Bottle with Black Lid", cat: "Community Events", stock: 107, low: 15, img: P + "bottle.png",    loc: "C1-02", freq: 6, desc: "24 oz clear bottle with flip lid and full-color logo." },
    { sku: "SP-ZE7TG-XK6", name: "L4L Cooling Towel",                     cat: "Community Events", stock: 22,  low: 25, img: P + "towel.png",     loc: "C1-04", freq: 4, desc: "Evaporative cooling towel in printed sleeve — summer event staple." },
    { sku: "SP-ZCDXR-JFE", name: "L4L Hand Fan",                          cat: "Community Events", stock: 75,  low: 15, img: P + "fan.png",       loc: "C1-05", freq: 3, desc: "Die-cut paper hand fan on wood stick, learn4life print." },
    { sku: "SP-X7RB6-WER", name: "L4L Hand Sanitizer",                    cat: "Community Events", stock: 218, low: 20, img: P + "sanitizer.png", loc: "C1-01", freq: 7, desc: "1 oz carabiner sanitizer, citrus scent." },
    { sku: "SP-D4BAG-CE1", name: "L4L Drawstring Bag",                    cat: "Community Events", stock: 340, low: 25, loc: "C2-01", desc: "Lightweight cinch bag for event giveaways." },
    { sku: "SP-L8YRD-CE2", name: "L4L Lanyard — Rainbow",                 cat: "Community Events", stock: 512, low: 40, loc: "C2-02", desc: "Rainbow-gradient lanyard with plastic clip." },
    { sku: "SP-S2STK-CE3", name: "L4L Sticker Sheet",                     cat: "Community Events", stock: 0,   low: 50, loc: "C2-03", desc: "Kiss-cut sticker sheet, 8 designs." },
    { sku: "SP-T6RNR-CE4", name: "L4L Event Table Runner",                cat: "Community Events", stock: 6,   low: 8,  loc: "C2-05", desc: "6 ft fitted table runner, full-bleed print." },

    // ---- Conference Item (9) ----------------------------------------------
    { sku: "SP-B1NNR-CF1", name: "Retractable Banner — 33\"",   cat: "Conference Item", stock: 4,   low: 5,  loc: "D1-01", desc: "Roll-up banner stand with padded case." },
    { sku: "SP-T3CLT-CF2", name: "Logo Tablecloth — 6 ft",      cat: "Conference Item", stock: 9,   low: 10, loc: "D1-02" },
    { sku: "SP-B5HLD-CF3", name: "Badge Holders — 50 ct",       cat: "Conference Item", stock: 63,  low: 10, loc: "D1-04" },
    { sku: "SP-P7PEN-CF4", name: "Click Pens — 100 ct",         cat: "Conference Item", stock: 44,  low: 10, loc: "D1-05" },
    { sku: "SP-L9PAD-CF5", name: "Legal Pads — 12 ct",          cat: "Conference Item", stock: 76,  low: 12, loc: "D1-06" },
    { sku: "SP-T2TOT-CF6", name: "L4L Tote Bag",                cat: "Conference Item", stock: 130, low: 20, loc: "D2-01" },
    { sku: "SP-C4HUB-CF7", name: "Charging Hub — 6 port",       cat: "Conference Item", stock: 11,  low: 6,  loc: "D2-03" },
    { sku: "SP-E6ESL-CF8", name: "Easel Stand — Folding",       cat: "Conference Item", stock: 7,   low: 8,  loc: "D2-04" },
    { sku: "SP-C8CLK-CF9", name: "Presentation Clicker",        cat: "Conference Item", stock: 13,  low: 6,  loc: "D2-05" },

    // ---- Electronics (8) ---------------------------------------------------
    { sku: "SP-H1DST-EL1", name: "USB-C Headset — Mono",        cat: "Electronics", stock: 14, low: 8,  loc: "E1-01" },
    { sku: "SP-W3CAM-EL2", name: "1080p Web Camera",            cat: "Electronics", stock: 6,  low: 8,  loc: "E1-02" },
    { sku: "SP-K5KBD-EL3", name: "Keyboard — Low Profile",      cat: "Electronics", stock: 11, low: 8,  loc: "E1-03" },
    { sku: "SP-M7MSE-EL4", name: "Wireless Mouse",              cat: "Electronics", stock: 27, low: 10, loc: "E1-04" },
    { sku: "SP-H9DMI-EL5", name: "HDMI Cable — 6 ft",           cat: "Electronics", stock: 58, low: 12, loc: "E1-06" },
    { sku: "SP-U2HUB-EL6", name: "USB-C Hub — 7 in 1",          cat: "Electronics", stock: 9,  low: 10, loc: "E1-07" },
    { sku: "SP-T4CLC-EL7", name: "TI-84 Plus CE Calculator",    cat: "Electronics", stock: 31, low: 10, loc: "E2-01" },
    { sku: "SP-D6CAM-EL8", name: "Document Camera",             cat: "Electronics", stock: 3,  low: 5,  loc: "E2-03" },

    // ---- Graduation (2) ----------------------------------------------------
    { sku: "SP-G1GWN-GR1", name: "Cap & Gown Unit — Navy",      cat: "Graduation", stock: 146, low: 30, loc: "F1-01", desc: "Matte navy cap, gown and tassel, poly-bagged by size." },
    { sku: "SP-D3CVR-GR2", name: "Diploma Cover — Embossed",    cat: "Graduation", stock: 152, low: 30, loc: "F1-03" },

    // ---- Novel (8) ---------------------------------------------------------
    { sku: "SP-N1AFM-NV1", name: "Animal Farm",                 cat: "Novel", stock: 56, low: 15, loc: "G1-01", author: "G. Orwell" },
    { sku: "SP-N2GTS-NV2", name: "The Great Gatsby",            cat: "Novel", stock: 19, low: 20, loc: "G1-02", author: "F.S. Fitzgerald" },
    { sku: "SP-N3OMM-NV3", name: "Of Mice and Men",             cat: "Novel", stock: 85, low: 15, loc: "G1-03", author: "J. Steinbeck" },
    { sku: "SP-N4TKM-NV4", name: "To Kill a Mockingbird",       cat: "Novel", stock: 12, low: 15, loc: "G1-04", author: "H. Lee" },
    { sku: "SP-N5LTF-NV5", name: "Lord of the Flies",           cat: "Novel", stock: 33, low: 15, loc: "G1-05", author: "W. Golding" },
    { sku: "SP-N6OUT-NV6", name: "The Outsiders",               cat: "Novel", stock: 0,  low: 15, loc: "G1-06", author: "S.E. Hinton" },
    { sku: "SP-N7NGT-NV7", name: "Night",                       cat: "Novel", stock: 42, low: 15, loc: "G2-01", author: "E. Wiesel" },
    { sku: "SP-N8F45-NV8", name: "Fahrenheit 451",              cat: "Novel", stock: 8,  low: 10, loc: "G2-02", author: "R. Bradbury" },

    // ---- Science Kit (6) ---------------------------------------------------
    { sku: "SP-S1GGL-SK1", name: "Safety Goggles — 12 ct",      cat: "Science Kit", stock: 84, low: 12, loc: "H1-01" },
    { sku: "SP-S3BKR-SK2", name: "Beaker Set — 500 ml",         cat: "Science Kit", stock: 21, low: 10, loc: "H1-02" },
    { sku: "SP-S5SLD-SK3", name: "Microscope Slides — 72 ct",   cat: "Science Kit", stock: 0,  low: 12, loc: "H1-04" },
    { sku: "SP-S7PHS-SK4", name: "pH Test Strips — 100 ct",     cat: "Science Kit", stock: 96, low: 15, loc: "H1-05" },
    { sku: "SP-S9DSK-SK5", name: "Dissection Kit",              cat: "Science Kit", stock: 18, low: 8,  loc: "H2-01" },
    { sku: "SP-S2CIR-SK6", name: "Snap Circuits Kit",           cat: "Science Kit", stock: 9,  low: 10, loc: "H2-02" },

    // ---- Uniform (6) -------------------------------------------------------
    { sku: "SP-U1MPS-UN1", name: "Men's Polo — Navy · S",       cat: "Uniform", stock: 12, low: 10, img: P + "polo-m.png", loc: "A3-03" },
    { sku: "SP-U2MPM-UN2", name: "Men's Polo — Navy · M",       cat: "Uniform", stock: 30, low: 10, img: P + "polo-m.png", loc: "A3-03" },
    { sku: "SP-U3MPX-UN3", name: "Men's Polo — Navy · XL",      cat: "Uniform", stock: 17, low: 10, img: P + "polo-m.png", loc: "A3-05" },
    { sku: "SP-U4MP2-UN4", name: "Men's Polo — Navy · XXL",     cat: "Uniform", stock: 5,  low: 6,  img: P + "polo-m.png", loc: "A3-05" },
    { sku: "SP-U5WPS-UN5", name: "Women's Polo — Navy · S",     cat: "Uniform", stock: 9,  low: 10, img: P + "polo-w.png", loc: "A3-01" },
    { sku: "SP-U6WPL-UN6", name: "Women's Polo — Navy · L",     cat: "Uniform", stock: 26, low: 10, img: P + "polo-w.png", loc: "A3-02" },
  ];

  // status helper: "ok" | "low" | "out"
  function statusOf(it) {
    if (it.stock === 0) return "out";
    if (it.stock <= it.low) return "low";
    return "ok";
  }

  const CATS = [
    { id: "New Hire",         icon: "users" },
    { id: "Community Events", icon: "sparkles" },
    { id: "Conference Item",  icon: "briefcase" },
    { id: "Electronics",      icon: "lightning" },
    { id: "Graduation",       icon: "gradcap" },
    { id: "Novel",            icon: "book" },
    { id: "Science Kit",      icon: "flask" },
    { id: "Uniform",          icon: "shirt" },
  ];

  const WAREHOUSES = [
    { id: "DC4", name: "DC4 — Fresno",       sub: "L4L North Region · default" },
    { id: "DC1", name: "DC1 — Sacramento",   sub: "L4L North Region" },
    { id: "DC2", name: "DC2 — San Diego",    sub: "L4L South Region" },
    { id: "DC7", name: "DC7 — Bakersfield",  sub: "L4L Central Region" },
  ];

  const SITES = [
    { id: "fresno-main", name: "Fresno — Main Campus",      sub: "2822 W Fig Ave" },
    { id: "fresno-na",   name: "Fresno — North Annex",      sub: "1145 E Shaw Ave" },
    { id: "bakers",      name: "Bakersfield Center",        sub: "500 Ming Ave" },
    { id: "modesto",     name: "Modesto Site",              sub: "1620 Coffee Rd" },
    { id: "visalia",     name: "Visalia Learning Center",   sub: "310 NW 3rd Ave" },
  ];

  const PEOPLE = [
    { id: "you",  name: "Branden Vincent Walker", sub: "Super Admin · you" },
    { id: "mg",   name: "Maria Gutierrez",        sub: "Site Coordinator · Fresno" },
    { id: "dc",   name: "DeShawn Carter",         sub: "Teacher · North Annex" },
    { id: "at",   name: "Alyssa Tran",            sub: "Front Office · Fresno" },
    { id: "so",   name: "Sam Okafor",             sub: "Events · North Region" },
    { id: "jl",   name: "Jordan Lee",             sub: "IT · North Region" },
  ];

  window.SF_DATA = { ITEMS, CATS, WAREHOUSES, SITES, PEOPLE, statusOf };
})();
