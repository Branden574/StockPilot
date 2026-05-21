import 'server-only';

/**
 * Cheap, deterministic intent classifier. Runs in zero added latency
 * (~50µs of regex per message) and labels the user's turn with one
 * of ~10 high-level intents. The label is then injected into the
 * system prompt as a NUDGE so Gemini picks the right tool on the
 * first hop instead of stumbling through three round-trips.
 *
 * Why rule-based not LLM-based:
 *   • A separate gemini-flash-lite call would add 300-800ms + per-turn
 *     cost. The wins from "better classification" don't pay for that
 *     when 90% of user queries fall in 8 well-known buckets.
 *   • Deterministic = reproducible = easy to eval.
 *   • Failure mode is graceful: unknown intent just means no nudge,
 *     the main model still gets the full tool catalog.
 *
 * If the classifier turns out to be too narrow, swapping in an LLM
 * call later is a 30-line change — the streamChat API takes
 * `intent?` already.
 */

export type ChatIntent =
  | 'inventory_lookup' // "do we have X", "find Y"
  | 'inventory_ranking' // "most stocked", "cheapest", "top 10 by cost"
  | 'inventory_count' // "how many items total", "total inventory"
  | 'low_stock' // "what's running low", "out of stock"
  | 'value_question' // "total value", "how much is our stock worth"
  | 'order_query' // "what orders are pending"
  | 'order_write' // "approve this", "deny order X"
  | 'book_import' // "import these ISBNs"
  | 'isbn_lookup' // "what book is 978..."
  | 'recent_activity' // "what was received today"
  | 'supplier_query' // "show suppliers"
  | 'warehouse_query' // "which warehouse has the most"
  | 'category_query' // "biggest category"
  | 'forecasting' // "when will we run out"
  | 'semantic_search' // "items related to X"
  | 'photo_identify' // attachment-bearing turns
  | 'general'; // everything else

interface IntentMatcher {
  intent: ChatIntent;
  patterns: RegExp[];
}

const MATCHERS: IntentMatcher[] = [
  // Order writes — checked first so "approve" beats generic "order"
  {
    intent: 'order_write',
    patterns: [
      /\b(approve|deny|reject|cancel|complete)\b.*\b(order|request|po)\b/i,
      /\b(yes|confirm|do it|go ahead|proceed)\b/i,
    ],
  },
  {
    intent: 'order_query',
    patterns: [
      /\b(order|orders|request|requests|po|pos|purchase order)\b/i,
      /\b(who ordered|what.* order|orders for|orders by|pending requests|order queue)\b/i,
    ],
  },
  // Bulk book import + ISBN
  {
    intent: 'book_import',
    patterns: [
      /\b(import|add|bulk).*\b(isbn|isbns|book|books)\b/i,
      /\[uploaded .* extracted \d+ isbns/i,
      /\b\d{10,13}\b.*\b\d{10,13}\b/, // two or more ISBN-shaped numbers
    ],
  },
  {
    intent: 'isbn_lookup',
    patterns: [
      /\bwhat (book|title) (is|for) (isbn )?\d{10,13}/i,
      /\blookup .*\b\d{10,13}\b/i,
    ],
  },
  // Cost / value / financial
  {
    intent: 'inventory_ranking',
    patterns: [
      /\b(most|highest|top \d+|biggest)\b.*\b(stock(ed)?|quantity|qty|cost(ing|s)?|price[ds]?|expensive|valuable)\b/i,
      /\b(lowest|cheapest|least|smallest)\b.*\b(cost(ing|s)?|price[ds]?|expensive|stock(ed)?|quantity|qty)\b/i,
      /\b(rank|sort|order) by\b/i,
      /\b(priciest|cheapest|most expensive|least expensive)\b/i,
    ],
  },
  {
    intent: 'value_question',
    patterns: [
      /\b(total|overall|combined|all)\b.*\b(value|worth|cost)\b/i,
      /\bhow much (is|are).* worth\b/i,
      /\binventory value\b/i,
    ],
  },
  // Low stock
  {
    intent: 'low_stock',
    patterns: [
      /\b(low|running low|low stock|low-stock|out of stock|need restock|need.* reorder|restock|need.* order more|below reorder)\b/i,
      /\b(reorder point|at reorder)\b/i,
    ],
  },
  // Counts and aggregations
  {
    intent: 'inventory_count',
    patterns: [
      /\bhow many.*\b(items?|products?|skus?|things?|do we have)\b/i,
      /\btotal (items|products|inventory|skus)\b/i,
      /\b(count|number) of (items?|products?)\b/i,
    ],
  },
  // Recent activity / time window
  {
    intent: 'recent_activity',
    patterns: [
      /\b(today|yesterday|this week|last \d+ days?|this month|recent|recently)\b/i,
      /\bwhat.* (received|added|moved|changed|edited|created|came in)\b/i,
      /\bmovement(s)?\b/i,
    ],
  },
  // Warehouse / category / supplier
  {
    intent: 'warehouse_query',
    patterns: [
      /\bwarehouse(s)?\b/i,
      /\bby (warehouse|location)\b/i,
      /\b(dc\d|location \w+)\b/i,
    ],
  },
  {
    intent: 'category_query',
    patterns: [
      /\bcategor(y|ies)\b/i,
      /\bby category\b/i,
    ],
  },
  {
    intent: 'supplier_query',
    patterns: [
      /\b(supplier|suppliers|vendor|vendors|who supplies)\b/i,
    ],
  },
  // Forecasting
  {
    intent: 'forecasting',
    patterns: [
      /\bwhen .*\b(run out|deplete)\b/i,
      /\bhow long.*\blast\b/i,
      /\b(forecast|projection|velocity|days of stock|burn rate)\b/i,
    ],
  },
  // Semantic search
  {
    intent: 'semantic_search',
    patterns: [
      /\b(something|things?) (like|similar to|related to)\b/i,
      /\b(the thing for|what.* use to)\b/i,
      /\bconcept\b/i,
    ],
  },
  // Inventory lookup — catch-all for "do we have / find X"
  {
    intent: 'inventory_lookup',
    patterns: [
      /\b(do we have|got any|find|search for|where is|where.* keep|stock of)\b/i,
      /\bin stock\b/i,
    ],
  },
];

/**
 * Classify a user message into a ChatIntent. Returns 'general' when
 * nothing matches — the caller treats that as "no nudge".
 *
 * Important: this is best-effort, not authoritative. The intent is
 * passed as a hint to the system prompt; Gemini still has the full
 * tool catalog and can override the hint when it disagrees.
 */
export function classifyIntent(userMessage: string): ChatIntent {
  const msg = userMessage.trim();
  if (!msg) return 'general';
  for (const matcher of MATCHERS) {
    for (const pattern of matcher.patterns) {
      if (pattern.test(msg)) return matcher.intent;
    }
  }
  return 'general';
}

/**
 * Tool-priority nudge to inject into the system prompt for a given
 * intent. Empty string for 'general' (no nudge — let the model pick
 * freely). The nudge is short on purpose — Gemini ignores long
 * lists of suggestions but reliably acts on a one-line directive.
 */
export function intentNudge(intent: ChatIntent): string {
  switch (intent) {
    case 'order_write':
      return 'INTENT HINT: user is requesting an ORDER ACTION (approve/deny/cancel). Confirm-first rule applies. Use approveOrder / denyOrder / cancelOrder.';
    case 'order_query':
      return 'INTENT HINT: user is asking about ORDERS. Use listOrderRequests or getOrderRequestSummary first.';
    case 'book_import':
      return 'INTENT HINT: user is performing a BULK BOOK IMPORT. Follow the strict ISBN workflow (preview → confirm → execute).';
    case 'isbn_lookup':
      return 'INTENT HINT: user is asking about a single ISBN. Use lookupIsbn, NOT executeBulkBookImport.';
    case 'inventory_ranking':
      return 'INTENT HINT: user is asking for a RANKING. Use searchInventory with the appropriate sort (cost_asc / cost_desc / qty_desc / qty_asc) and a limit.';
    case 'value_question':
      return 'INTENT HINT: user is asking about total VALUE. Use getDashboardSummary (or inventoryByWarehouse / inventoryByCategory for breakdowns).';
    case 'low_stock':
      return 'INTENT HINT: user is asking about LOW STOCK. Use listLowStock.';
    case 'inventory_count':
      return 'INTENT HINT: user is asking for a COUNT. Use the org-snapshot number above OR searchInventory total — do not call multiple tools.';
    case 'recent_activity':
      return 'INTENT HINT: user is asking about a TIME WINDOW. Use getRecentItems / getMovements / getRecentOrders with sinceDaysAgo.';
    case 'warehouse_query':
      return 'INTENT HINT: user is asking about WAREHOUSES. Use listWarehouses or inventoryByWarehouse.';
    case 'category_query':
      return 'INTENT HINT: user is asking about CATEGORIES. Use listCategories or inventoryByCategory.';
    case 'supplier_query':
      return 'INTENT HINT: user is asking about SUPPLIERS. Use listSuppliers.';
    case 'forecasting':
      return 'INTENT HINT: user is asking about FORECASTING. Use suggestReorderPoint or getItemVelocity.';
    case 'semantic_search':
      return 'INTENT HINT: user is asking a SEMANTIC question. Use searchInventorySemantic first; fall back to searchInventory if empty.';
    case 'inventory_lookup':
      return 'INTENT HINT: user is searching for SPECIFIC ITEMS. Use searchInventory.';
    case 'photo_identify':
      return 'INTENT HINT: user attached a PHOTO. Use identifyFromPhoto.';
    case 'general':
    default:
      return '';
  }
}
