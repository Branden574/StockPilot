import 'server-only';

import { GoogleGenerativeAI, SchemaType, type FunctionDeclaration } from '@google/generative-ai';

import { lookupIsbn as lookupIsbnLib } from '@/lib/books/lookup';
import { env } from '@/lib/env';
import { assertSafeFetchUrl, SsrfBlockedError } from '@/lib/ssrf-guard';
import type { ServiceContext } from '@/server/services/context';
import { BooksImportService } from '@/server/services/books-import';
import { CategoriesService } from '@/server/services/categories';
import {
  getItemVelocity,
  suggestReorderPoint as suggestReorderPointLib,
} from '@/server/services/forecasting';
import { BundlesService } from '@/server/services/bundles';
import { InventoryService } from '@/server/services/inventory';
import { OrderRequestsService } from '@/server/services/order-requests';
import { PurchaseOrdersService } from '@/server/services/purchase-orders';
import {
  getDashboardActions,
  getDashboardSummary,
  getLowStockItems,
  MovementsService,
} from '@/server/services/movements';
import { SuppliersService } from '@/server/services/suppliers';
import { WarehousesService } from '@/server/services/warehouses';

/**
 * Tool catalog the chatbot can call. Each entry pairs a Gemini-shaped
 * function declaration (sent to the model so it knows what's available)
 * with a server-side executor that runs against the user's
 * ServiceContext — meaning RLS is enforced for the asking user, no
 * cross-org leaks possible.
 *
 * Add new tools here; keep declarations terse — Gemini reads them as
 * docs and the prompt tokens scale with the catalog size.
 */

export interface ToolExecutor {
  declaration: FunctionDeclaration;
  execute: (args: Record<string, unknown>, ctx: ServiceContext) => Promise<unknown>;
}

/**
 * Format any service result as a compact JSON-shaped object Gemini can
 * reason about. Don't dump the full row — pick stable fields only.
 */
function compactItem(i: Record<string, unknown>) {
  return {
    id: i.id,
    sku: i.sku,
    name: i.name,
    onHand: i.quantity_on_hand,
    reorderPoint: i.reorder_point,
    status: i.status,
    unitCost: i.unit_cost,
    retailPrice: i.retail_price,
    warehouseId: i.warehouse_id,
    charterId: i.charter_id,
    locationId: i.primary_location_id,
    itemType: i.item_type,
  };
}

const searchInventoryTool: ToolExecutor = {
  declaration: {
    name: 'searchInventory',
    description:
      "Search + RANK the inventory. Filter by free-text (name/SKU/barcode), category UUID, status, low-stock, out-of-stock, item type, or warehouse. The result's `total` field is the TRUE count even when only 25 items are returned — use that for 'how many' questions. When the user names a category by label (e.g. \"Swag\", \"Books\"), call listCategories first to resolve the UUID, then re-query with categoryId. Use `sort` to rank: 'qty_desc' = most-stocked first (perfect for 'most stocked items' / 'top 10 by quantity'), 'qty_asc' = lowest first, 'name_asc' = alphabetical, 'updated_desc' = recently changed, 'created_desc' = newest first.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            'Free-text query. Matches name, SKU, or barcode. Empty string = no text filter.',
        },
        categoryId: {
          type: SchemaType.STRING,
          description:
            "UUID of a category. Empty = no category filter. Resolve labels via listCategories first.",
        },
        status: {
          type: SchemaType.STRING,
          description: "One of 'active', 'archived', 'discontinued', 'all'. Default: 'active'.",
        },
        itemType: {
          type: SchemaType.STRING,
          description:
            "One of 'product', 'book', 'asset', 'consumable', 'all'. Default: 'all'.",
        },
        lowStock: {
          type: SchemaType.BOOLEAN,
          description: 'When true, only items at or below reorder_point. Default false.',
        },
        outOfStock: {
          type: SchemaType.BOOLEAN,
          description: 'When true, only items with on-hand <= 0. Default false.',
        },
        warehouseId: {
          type: SchemaType.STRING,
          description: 'UUID of a specific warehouse. Empty = no filter.',
        },
        sort: {
          type: SchemaType.STRING,
          description:
            "Sort order. One of: 'qty_desc' (most stocked first), 'qty_asc' (least stocked first), 'name_asc', 'name_desc', 'sku_asc', 'sku_desc', 'updated_desc' (recently changed first), 'updated_asc', 'created_desc' (newest first), 'created_asc'. Default: 'updated_desc'. ALWAYS use 'qty_desc' for 'most stocked' / 'highest quantity' questions; 'qty_asc' for 'lowest stock' (when not specifically asking about reorder-point).",
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Max rows to return (1-25). Default 10.',
        },
      },
      required: ['query'],
    },
  },
  async execute(args, ctx) {
    const svc = new InventoryService(ctx);
    const allowedSorts = new Set([
      'qty_desc',
      'qty_asc',
      'name_asc',
      'name_desc',
      'sku_asc',
      'sku_desc',
      'updated_desc',
      'updated_asc',
      'created_desc',
      'created_asc',
    ]);
    const sort =
      typeof args.sort === 'string' && allowedSorts.has(args.sort)
        ? (args.sort as
            | 'qty_desc'
            | 'qty_asc'
            | 'name_asc'
            | 'name_desc'
            | 'sku_asc'
            | 'sku_desc'
            | 'updated_desc'
            | 'updated_asc'
            | 'created_desc'
            | 'created_asc')
        : 'updated_desc';
    const result = await svc.list({
      q: (args.query as string) || undefined,
      categoryId:
        typeof args.categoryId === 'string' && args.categoryId.length > 0
          ? args.categoryId
          : null,
      status:
        args.status === 'archived' ||
        args.status === 'discontinued' ||
        args.status === 'all' ||
        args.status === 'active'
          ? args.status
          : 'active',
      itemType:
        args.itemType === 'product' ||
        args.itemType === 'book' ||
        args.itemType === 'asset' ||
        args.itemType === 'consumable' ||
        args.itemType === 'all'
          ? args.itemType
          : 'all',
      lowStock: Boolean(args.lowStock),
      outOfStock: Boolean(args.outOfStock),
      warehouseId: typeof args.warehouseId === 'string' && args.warehouseId.length > 0 ? args.warehouseId : null,
      sort,
      limit: Math.min(25, Math.max(1, Number(args.limit) || 10)),
    });
    return {
      total: result.total,
      sortedBy: sort,
      items: result.items.slice(0, 25).map((i) => compactItem(i as Record<string, unknown>)),
    };
  },
};

const listCategoriesTool: ToolExecutor = {
  declaration: {
    name: 'listCategories',
    description:
      "List the workspace's item categories with their UUIDs. Use this to resolve a category name (e.g. \"Swag\", \"Fiction\") into the categoryId you'll pass to searchInventory. Returns name + id + an estimated item count per category.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {},
    },
  },
  async execute(_args, ctx) {
    const svc = new CategoriesService(ctx);
    const cats = await svc.list();
    if (cats.length === 0) return { categories: [] };

    // Cheap counts via PostgREST head queries — one per category, but
    // there are typically <30 of these, so the round trip cost is fine.
    // Run in parallel.
    const counts = await Promise.all(
      cats.map(async (c) => {
        const { count } = await ctx.supabase
          .from('inventory_items')
          .select('id', { count: 'estimated', head: true })
          .eq('organization_id', ctx.organizationId)
          .eq('category_id', (c as { id: string }).id)
          .is('deleted_at', null);
        return count ?? 0;
      }),
    );

    return {
      categories: cats.map((c, i) => ({
        id: (c as { id: string }).id,
        name: (c as { name: string }).name,
        itemCount: counts[i] ?? 0,
      })),
    };
  },
};

const getItemDetailsTool: ToolExecutor = {
  declaration: {
    name: 'getItemDetails',
    description: 'Look up a single inventory item by its UUID. Returns full details.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        itemId: { type: SchemaType.STRING, description: 'UUID of the inventory item.' },
      },
      required: ['itemId'],
    },
  },
  async execute(args, ctx) {
    const svc = new InventoryService(ctx);
    const item = await svc.get(args.itemId as string);
    return compactItem(item as Record<string, unknown>);
  },
};

const listLowStockTool: ToolExecutor = {
  declaration: {
    name: 'listLowStock',
    description:
      'List items at or below their reorder point. Optionally scope to a single warehouse. Use this for "what needs restocking" / "what is low" questions.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        warehouseId: {
          type: SchemaType.STRING,
          description: 'Optional warehouse UUID to scope results.',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Max rows (1-25). Default 10.',
        },
      },
    },
  },
  async execute(args, ctx) {
    const wh =
      typeof args.warehouseId === 'string' && args.warehouseId.length > 0
        ? args.warehouseId
        : null;
    const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
    return await getLowStockItems(limit, { warehouseId: wh, ctx });
  },
};

const getDashboardSummaryTool: ToolExecutor = {
  declaration: {
    name: 'getDashboardSummary',
    description:
      'Overall workspace metrics: total active items, out-of-stock count, low-stock count, and total inventory value (sum of qty * unit_cost). Optionally scope to a warehouse.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        warehouseId: {
          type: SchemaType.STRING,
          description: 'Optional warehouse UUID to scope results.',
        },
      },
    },
  },
  async execute(args, ctx) {
    const wh =
      typeof args.warehouseId === 'string' && args.warehouseId.length > 0
        ? args.warehouseId
        : null;
    const [summary, actions] = await Promise.all([
      getDashboardSummary({ warehouseId: wh, ctx }),
      getDashboardActions({ warehouseId: wh, ctx }),
    ]);
    return { ...summary, ...actions };
  },
};

const inventoryByWarehouseTool: ToolExecutor = {
  declaration: {
    name: 'inventoryByWarehouse',
    description:
      "READ-ONLY — break inventory totals down by warehouse. Returns one row per warehouse with itemCount, totalUnits, totalValue. Use for 'which warehouse has the most stock?' / 'how is inventory split?' / 'where is most of our value?'. Includes an 'unassigned' bucket for items with no warehouse set.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        itemType: {
          type: SchemaType.STRING,
          description:
            "Optional filter. One of 'product', 'book', 'asset', 'consumable', 'all'. Default 'all'.",
        },
      },
    },
  },
  async execute(args, ctx) {
    const itemType =
      args.itemType === 'product' ||
      args.itemType === 'book' ||
      args.itemType === 'asset' ||
      args.itemType === 'consumable'
        ? args.itemType
        : null;

    let q = ctx.supabase
      .from('inventory_items')
      .select('warehouse_id, quantity_on_hand, unit_cost')
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null)
      .eq('status', 'active');
    if (itemType) q = q.eq('item_type', itemType);
    const { data: items, error } = await q;
    if (error) throw new Error(error.message);

    const { data: warehouses } = await ctx.supabase
      .from('warehouses')
      .select('id, name')
      .eq('organization_id', ctx.organizationId);
    const nameById = new Map<string, string>();
    for (const w of (warehouses ?? []) as Array<{ id: string; name: string }>) {
      nameById.set(w.id, w.name);
    }

    type Bucket = {
      warehouseId: string | null;
      warehouseName: string;
      itemCount: number;
      totalUnits: number;
      totalValue: number;
    };
    const byWh = new Map<string | null, Bucket>();
    for (const i of (items ?? []) as Array<{
      warehouse_id: string | null;
      quantity_on_hand: number;
      unit_cost: number;
    }>) {
      const key = i.warehouse_id;
      const acc =
        byWh.get(key) ??
        ({
          warehouseId: key,
          warehouseName: key ? (nameById.get(key) ?? '(deleted)') : '(unassigned)',
          itemCount: 0,
          totalUnits: 0,
          totalValue: 0,
        } as Bucket);
      acc.itemCount += 1;
      const qty = Number(i.quantity_on_hand) || 0;
      const cost = Number(i.unit_cost) || 0;
      acc.totalUnits += qty;
      acc.totalValue += qty * cost;
      byWh.set(key, acc);
    }
    const rows = Array.from(byWh.values()).sort((a, b) => b.totalValue - a.totalValue);
    return {
      filter: { itemType: itemType ?? 'all' },
      rows,
      totals: {
        itemCount: rows.reduce((s, r) => s + r.itemCount, 0),
        totalUnits: rows.reduce((s, r) => s + r.totalUnits, 0),
        totalValue: rows.reduce((s, r) => s + r.totalValue, 0),
      },
    };
  },
};

const inventoryByCategoryTool: ToolExecutor = {
  declaration: {
    name: 'inventoryByCategory',
    description:
      "READ-ONLY — break inventory totals down by category. Returns one row per category with itemCount, totalUnits, totalValue. Use for 'biggest category by value' / 'what type of inventory do we have most of' / 'how is inventory split by category'. Includes an 'uncategorized' bucket.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  async execute(_args, ctx) {
    const [{ data: items, error }, { data: cats }] = await Promise.all([
      ctx.supabase
        .from('inventory_items')
        .select('category_id, quantity_on_hand, unit_cost')
        .eq('organization_id', ctx.organizationId)
        .is('deleted_at', null)
        .eq('status', 'active'),
      ctx.supabase
        .from('categories')
        .select('id, name')
        .eq('organization_id', ctx.organizationId),
    ]);
    if (error) throw new Error(error.message);

    const nameById = new Map<string, string>();
    for (const c of (cats ?? []) as Array<{ id: string; name: string }>) {
      nameById.set(c.id, c.name);
    }

    type Bucket = {
      categoryId: string | null;
      categoryName: string;
      itemCount: number;
      totalUnits: number;
      totalValue: number;
    };
    const byCat = new Map<string | null, Bucket>();
    for (const i of (items ?? []) as Array<{
      category_id: string | null;
      quantity_on_hand: number;
      unit_cost: number;
    }>) {
      const key = i.category_id;
      const acc =
        byCat.get(key) ??
        ({
          categoryId: key,
          categoryName: key ? (nameById.get(key) ?? '(deleted)') : '(uncategorized)',
          itemCount: 0,
          totalUnits: 0,
          totalValue: 0,
        } as Bucket);
      acc.itemCount += 1;
      const qty = Number(i.quantity_on_hand) || 0;
      const cost = Number(i.unit_cost) || 0;
      acc.totalUnits += qty;
      acc.totalValue += qty * cost;
      byCat.set(key, acc);
    }
    const rows = Array.from(byCat.values()).sort((a, b) => b.totalValue - a.totalValue);
    return {
      rows,
      totals: {
        itemCount: rows.reduce((s, r) => s + r.itemCount, 0),
        totalUnits: rows.reduce((s, r) => s + r.totalUnits, 0),
        totalValue: rows.reduce((s, r) => s + r.totalValue, 0),
      },
    };
  },
};

const recentMovementsTool: ToolExecutor = {
  declaration: {
    name: 'recentMovements',
    description:
      'List recent stock movements with actor (who did it) and item details. Use for "who adjusted what", "what happened today", "recent activity" questions.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        warehouseId: {
          type: SchemaType.STRING,
          description: 'Optional warehouse UUID to scope.',
        },
        itemId: {
          type: SchemaType.STRING,
          description: 'Optional specific item UUID — only that item\'s movements.',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Max rows (1-50). Default 20.',
        },
      },
    },
  },
  async execute(args, ctx) {
    const svc = new MovementsService(ctx);
    const list = await svc.list({
      itemId: typeof args.itemId === 'string' && args.itemId.length > 0 ? args.itemId : undefined,
      warehouseId:
        typeof args.warehouseId === 'string' && args.warehouseId.length > 0
          ? args.warehouseId
          : undefined,
      limit: Math.min(50, Math.max(1, Number(args.limit) || 20)),
    });
    return list.map((m) => ({
      id: m.id,
      type: m.movement_type,
      delta: m.quantity_change,
      newQuantity: m.new_quantity,
      reason: m.reason,
      notes: m.notes,
      createdAt: m.created_at,
      itemName: m.item?.name ?? null,
      itemSku: m.item?.sku ?? null,
      actor: m.actor?.fullName ?? m.actor?.email ?? (m.user_id ? 'Unknown' : 'System'),
    }));
  },
};

const listSuppliersTool: ToolExecutor = {
  declaration: {
    name: 'listSuppliers',
    description:
      "List suppliers/vendors in the workspace. Use for 'who do we buy from', 'find supplier X', 'who supplies books'.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: 'Optional name substring to filter on.',
        },
      },
    },
  },
  async execute(args, ctx) {
    const svc = new SuppliersService(ctx);
    const all = await svc.list();
    const q = (args.query as string | undefined)?.toLowerCase().trim() ?? '';
    const filtered = q
      ? all.filter((s) => ((s.name as string) ?? '').toLowerCase().includes(q))
      : all;
    return filtered.slice(0, 30).map((s) => ({
      id: s.id,
      name: s.name,
      email: s.email,
      phone: s.phone,
    }));
  },
};

const adjustStockTool: ToolExecutor = {
  declaration: {
    name: 'adjustStock',
    description:
      "WRITE TOOL — adjusts an item's quantity on hand. Use only AFTER the user has explicitly confirmed the item, the delta (positive to add stock, negative to remove), and a reason. Requires stock:adjust permission; staff/manager/admin roles can use it, viewers cannot. Always echo back item name + delta + reason in your reply so the user has a paper trail.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        itemId: {
          type: SchemaType.STRING,
          description:
            "UUID of the item to adjust. Resolve via searchInventory or getItemDetails first if you only have a name.",
        },
        delta: {
          type: SchemaType.NUMBER,
          description:
            "Quantity change. Positive adds stock (receipt, found inventory). Negative removes (shrinkage, damage, sold-off-system).",
        },
        reason: {
          type: SchemaType.STRING,
          description:
            "Required short reason (e.g. 'shrinkage', 'cycle count correction', 'damaged in transit'). Stored on the movement row.",
        },
        movementType: {
          type: SchemaType.STRING,
          description:
            "Optional movement classification. One of 'adjust' (default), 'shrinkage', 'damage', 'count'.",
        },
      },
      required: ['itemId', 'delta', 'reason'],
    },
  },
  async execute(args, ctx) {
    const itemId = String(args.itemId ?? '');
    const delta = Number(args.delta);
    const reason = String(args.reason ?? '').trim();
    const movementType =
      typeof args.movementType === 'string' && args.movementType.length > 0
        ? args.movementType
        : 'adjust';
    if (!itemId) throw new Error('itemId is required');
    if (!Number.isFinite(delta) || delta === 0) {
      throw new Error('delta must be a non-zero number');
    }
    if (!reason) throw new Error('reason is required');

    // Role gate. The service-level assertPermission also enforces this,
    // but we want a clear, AI-friendly error string before the model
    // has invested any tokens chasing the call.
    if (ctx.role === 'viewer') {
      throw new Error('viewer role cannot adjust stock');
    }

    const svc = new InventoryService(ctx);
    await svc.adjustStock({
      itemId,
      quantityChange: delta,
      movementType: movementType as never,
      reason,
    });
    // Re-fetch the item so the model can echo the new on-hand back.
    const updated = (await svc.get(itemId)) as Record<string, unknown>;
    return {
      ok: true,
      itemId,
      newOnHand: updated.quantity_on_hand,
      delta,
      reason,
      movementType,
    };
  },
};

const listWarehousesTool: ToolExecutor = {
  declaration: {
    name: 'listWarehouses',
    description:
      "List warehouses/locations the workspace operates. Useful when the user asks something like 'what warehouses do we have' or 'show me stock at <warehouse name>' — call this first to get the warehouse UUID, then re-query the inventory tool with that warehouseId.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  async execute(_args, ctx) {
    const svc = new WarehousesService(ctx);
    const list = await svc.list();
    return list.map((w) => ({ id: w.id, name: w.name, status: w.status }));
  },
};

const lookupIsbnTool: ToolExecutor = {
  declaration: {
    name: 'lookupIsbn',
    description:
      "Resolve a single ISBN-10 or ISBN-13 to title, authors, publisher, and year via Google Books, Open Library, and the Library of Congress in parallel. Read-only — does NOT add the book to inventory. Use this to verify an ISBN before importing or to answer 'what book is this?' questions.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        isbn: {
          type: SchemaType.STRING,
          description:
            'ISBN-10 or ISBN-13, with or without dashes. Will be normalized server-side.',
        },
      },
      required: ['isbn'],
    },
  },
  async execute(args) {
    const isbn = String(args.isbn ?? '');
    if (!isbn) throw new Error('isbn is required');
    const meta = await lookupIsbnLib(isbn);
    if (!meta) {
      return { found: false, isbn };
    }
    return {
      found: true,
      isbn: meta.isbn,
      title: meta.title,
      authors: meta.authors,
      publisher: meta.publisher,
      publishedDate: meta.publishedDate,
      grade: meta.grade,
      sources: meta.sources,
    };
  },
};

const previewBulkBookImportTool: ToolExecutor = {
  declaration: {
    name: 'previewBulkBookImport',
    description:
      "READ-ONLY preview of a bulk ISBN import. Resolves every ISBN, flags duplicates already in inventory (same barcode), flags ISBNs that appear twice in the input list, and reports lookup failures. ALWAYS call this first when a user wants to bulk-import books — show them the breakdown and the duplicate flags, then wait for explicit confirmation before calling executeBulkBookImport. Capped at 50 ISBNs per call; route larger batches to /dashboard/books/import.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        isbns: {
          type: SchemaType.ARRAY,
          description: 'Array of ISBNs (ISBN-10 or ISBN-13).',
          items: { type: SchemaType.STRING },
        },
      },
      required: ['isbns'],
    },
  },
  async execute(args, ctx) {
    const isbns = Array.isArray(args.isbns) ? args.isbns.map((v) => String(v)) : [];
    if (isbns.length === 0) throw new Error('isbns must be a non-empty array');
    const svc = new BooksImportService(ctx);
    const preview = await svc.preview(isbns);
    return preview;
  },
};

const executeBulkBookImportTool: ToolExecutor = {
  declaration: {
    name: 'executeBulkBookImport',
    description:
      "WRITE TOOL — creates inventory_items (item_type=book) for each ISBN that resolved cleanly. Duplicates (in DB or list) are skipped automatically. NEVER call without first calling previewBulkBookImport AND receiving an explicit user confirmation that names the warehouse + charter + total they expect. After the call, restate the created/skipped/failed counts. Requires items:create permission; viewers cannot use it.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        isbns: {
          type: SchemaType.ARRAY,
          description: 'Array of ISBNs — the same list the user confirmed.',
          items: { type: SchemaType.STRING },
        },
        warehouseId: {
          type: SchemaType.STRING,
          description:
            "UUID of the warehouse to create the books in. Resolve via listWarehouses first if the user named it by label.",
        },
        charterId: {
          type: SchemaType.STRING,
          description:
            "Optional UUID of a charter the warehouse services. Empty string = generic stock (any charter).",
        },
        defaultQuantity: {
          type: SchemaType.NUMBER,
          description:
            'Per-book starting quantity. Defaults to 1 if not provided.',
        },
      },
      required: ['isbns', 'warehouseId'],
    },
  },
  async execute(args, ctx) {
    if (ctx.role === 'viewer') {
      throw new Error('viewer role cannot create books');
    }
    const isbns = Array.isArray(args.isbns) ? args.isbns.map((v) => String(v)) : [];
    if (isbns.length === 0) throw new Error('isbns must be a non-empty array');
    const warehouseId = String(args.warehouseId ?? '');
    if (!warehouseId) throw new Error('warehouseId is required');
    const charterId =
      typeof args.charterId === 'string' && args.charterId.length > 0
        ? args.charterId
        : null;
    const defaultQuantity = Number(args.defaultQuantity);

    const svc = new BooksImportService(ctx);
    const result = await svc.execute(isbns, {
      warehouseId,
      charterId,
      defaultQuantity: Number.isFinite(defaultQuantity) ? defaultQuantity : 1,
      skipDuplicates: true,
    });
    return result;
  },
};

const exportInventoryTool: ToolExecutor = {
  declaration: {
    name: 'exportInventory',
    description:
      "Generate a CSV download URL for a filtered inventory list. Use this whenever the user asks to export, download, save as a spreadsheet, dump the data, or generate a CSV. Supports the same filters as searchInventory. Returns { count, url } — present the URL as a markdown link in your reply (e.g. \"[Download N items as CSV](url)\").",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: 'Free-text query (matches name, SKU, barcode). Empty = no text filter.',
        },
        categoryId: {
          type: SchemaType.STRING,
          description: 'UUID of a category. Empty = no category filter.',
        },
        status: {
          type: SchemaType.STRING,
          description: "One of 'active', 'archived', 'discontinued', 'all'. Default: 'active'.",
        },
        itemType: {
          type: SchemaType.STRING,
          description:
            "Filter by item_type: 'product' | 'book' | 'asset' | 'consumable' | 'all'. Default 'all'.",
        },
        lowStock: {
          type: SchemaType.BOOLEAN,
          description: 'When true, only items at or below reorder_point. Default false.',
        },
        outOfStock: {
          type: SchemaType.BOOLEAN,
          description: 'When true, only items with on-hand <= 0. Default false.',
        },
        warehouseId: {
          type: SchemaType.STRING,
          description: 'UUID of a specific warehouse. Empty = no filter.',
        },
      },
    },
  },
  async execute(args, ctx) {
    const itemType =
      args.itemType === 'product' ||
      args.itemType === 'book' ||
      args.itemType === 'asset' ||
      args.itemType === 'consumable' ||
      args.itemType === 'all'
        ? args.itemType
        : 'all';
    const status =
      args.status === 'archived' ||
      args.status === 'discontinued' ||
      args.status === 'all' ||
      args.status === 'active'
        ? args.status
        : 'active';

    // Cheap count probe — don't materialize all rows just to know how many.
    const svc = new InventoryService(ctx);
    const probe = await svc.list({
      q: typeof args.query === 'string' && args.query.length > 0 ? args.query : undefined,
      categoryId:
        typeof args.categoryId === 'string' && args.categoryId.length > 0
          ? args.categoryId
          : null,
      status,
      itemType,
      lowStock: Boolean(args.lowStock),
      outOfStock: Boolean(args.outOfStock),
      warehouseId:
        typeof args.warehouseId === 'string' && args.warehouseId.length > 0
          ? args.warehouseId
          : null,
      limit: 1,
    });

    const params = new URLSearchParams();
    params.set('scope', 'filtered');
    params.set('type', itemType);
    params.set('status', status);
    if (typeof args.query === 'string' && args.query.length > 0) {
      params.set('q', args.query);
    }
    if (typeof args.categoryId === 'string' && args.categoryId.length > 0) {
      params.append('cat', args.categoryId);
    }
    if (args.lowStock) params.set('stock', 'low');
    else if (args.outOfStock) params.set('stock', 'out');
    if (typeof args.warehouseId === 'string' && args.warehouseId.length > 0) {
      // The list endpoint reads warehouseId from the cookie-backed
      // getActiveWarehouseFilter, not a query param. AI tool can't set
      // that cookie; surface the constraint to the model so it warns
      // the user.
    }

    const base = (env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
    const url = `${base}/api/inventory/export.csv?${params.toString()}`;
    return { count: probe.total, url };
  },
};

const draftPosTool: ToolExecutor = {
  declaration: {
    name: 'draftPos',
    description:
      "WRITE TOOL — drafts purchase orders from items matching a filter, auto-grouped by supplier. Use when the user asks to 'draft POs', 'create restock POs', 'order more X', or any phrasing that means 'turn low/needed inventory into purchase orders.' Required confirmation flow: FIRST call searchInventory (or listLowStock) with the same filter to show the user a count + sample of items, then call draftPos only AFTER the user explicitly confirms. Items without supplier_id are skipped. Returns { createdPoIds, skipped, supplierFailures, supplierCount }; echo each new PO and any skips back to the user. Requires purchase_orders:manage permission — viewers cannot use it.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: 'Free-text query. Empty = no text filter.',
        },
        categoryId: {
          type: SchemaType.STRING,
          description: 'UUID of a category. Empty = no category filter.',
        },
        itemType: {
          type: SchemaType.STRING,
          description:
            "Filter by item_type: 'product' | 'book' | 'asset' | 'consumable' | 'all'. Default 'all'.",
        },
        lowStock: {
          type: SchemaType.BOOLEAN,
          description: 'When true, only items at or below reorder_point. Default true for restock workflows.',
        },
        outOfStock: {
          type: SchemaType.BOOLEAN,
          description: 'When true, only items with on-hand <= 0. Default false.',
        },
        warehouseId: {
          type: SchemaType.STRING,
          description: 'UUID of a specific warehouse. Empty = no warehouse filter.',
        },
        limit: {
          type: SchemaType.NUMBER,
          description:
            'Max items to include in this batch of drafts (1-200). Default 50. Server-side hard cap is 200.',
        },
      },
    },
  },
  async execute(args, ctx) {
    if (ctx.role === 'viewer') {
      throw new Error('viewer role cannot create purchase orders');
    }

    const itemType =
      args.itemType === 'product' ||
      args.itemType === 'book' ||
      args.itemType === 'asset' ||
      args.itemType === 'consumable' ||
      args.itemType === 'all'
        ? args.itemType
        : 'all';
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));

    // Resolve item ids by running the same filter shape as searchInventory.
    const inv = new InventoryService(ctx);
    const list = await inv.list({
      q: typeof args.query === 'string' && args.query.length > 0 ? args.query : undefined,
      categoryId:
        typeof args.categoryId === 'string' && args.categoryId.length > 0
          ? args.categoryId
          : null,
      status: 'active',
      itemType,
      // Default lowStock=true for the restock workflow; pass false explicitly
      // to draft from the full filtered set.
      lowStock: args.lowStock === false ? false : Boolean(args.lowStock ?? true),
      outOfStock: Boolean(args.outOfStock),
      warehouseId:
        typeof args.warehouseId === 'string' && args.warehouseId.length > 0
          ? args.warehouseId
          : null,
      limit,
    });

    if (list.items.length === 0) {
      return {
        matched: 0,
        createdPoIds: [],
        skipped: 0,
        supplierFailures: [],
        supplierCount: 0,
        message: 'No items matched that filter — nothing to draft.',
      };
    }

    const itemIds = list.items.map((i) => i.id);
    const poSvc = new PurchaseOrdersService(ctx);
    const result = await poSvc.createDraftsFromItems(itemIds);

    return {
      matched: list.items.length,
      ...result,
    };
  },
};

const predictRunoutTool: ToolExecutor = {
  declaration: {
    name: 'predictRunout',
    description:
      "READ-ONLY — predicts when an item will run out at its current outbound velocity. Use for 'when will X run out?' / 'how many days of stock left for Y?' / 'at this rate how long will the Mango Street books last?' Returns the item's units-out-per-day, days of stock remaining, and a projected runout date. Works on any item with at least one outbound stock movement in the last 90 days; items with zero out-movement return null for runout (they're not moving). Resolve item names via searchInventory first if you only have a name.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        itemId: {
          type: SchemaType.STRING,
          description: 'UUID of the inventory item.',
        },
        windowDays: {
          type: SchemaType.NUMBER,
          description:
            'Lookback window for the velocity calc, in days (7-365). Default 90. Shorter windows react faster to recent demand changes; longer windows smooth out spikes.',
        },
      },
      required: ['itemId'],
    },
  },
  async execute(args, ctx) {
    const itemId = String(args.itemId ?? '');
    if (!itemId) throw new Error('itemId is required');
    const windowDays = Math.min(
      365,
      Math.max(7, Number(args.windowDays) || 90),
    );
    return getItemVelocity(ctx.supabase, ctx.organizationId, itemId, windowDays);
  },
};

const suggestReorderPointTool: ToolExecutor = {
  declaration: {
    name: 'suggestReorderPoint',
    description:
      "READ-ONLY — recommends a reorder_point and reorder_quantity for an item based on its actual outbound velocity, lead time, and a safety buffer. Use when the user asks 'what should the reorder point be for X?' or 'is my reorder point too high/low?' Returns suggested values, current values for comparison, and a plain-English rationale. Does NOT apply the change; if the user wants to apply, separately call adjustStock or use the inventory edit form. Items with no outbound movement get a zero suggestion (the model should explain why).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        itemId: {
          type: SchemaType.STRING,
          description: 'UUID of the inventory item.',
        },
        leadTimeDays: {
          type: SchemaType.NUMBER,
          description:
            'Days between placing a PO and receiving stock. Default 14. If the user mentions a specific supplier with known lead time, pass it explicitly.',
        },
        safetyMultiplier: {
          type: SchemaType.NUMBER,
          description:
            "Buffer multiplier above lead-time demand. Default 1.5 (50% safety stock). Use 1.2 for stable/predictable demand, 2.0+ for spiky or critical-stock items.",
        },
        windowDays: {
          type: SchemaType.NUMBER,
          description:
            'Lookback window for velocity (days). Default 90.',
        },
      },
      required: ['itemId'],
    },
  },
  async execute(args, ctx) {
    const itemId = String(args.itemId ?? '');
    if (!itemId) throw new Error('itemId is required');
    return suggestReorderPointLib(ctx.supabase, ctx.organizationId, itemId, {
      leadTimeDays:
        typeof args.leadTimeDays === 'number' ? args.leadTimeDays : undefined,
      safetyMultiplier:
        typeof args.safetyMultiplier === 'number' ? args.safetyMultiplier : undefined,
      windowDays:
        typeof args.windowDays === 'number' ? args.windowDays : undefined,
    });
  },
};

const VISION_MODEL = env.GEMINI_MODEL;
const VISION_FETCH_TIMEOUT_MS = 12_000;
const VISION_MAX_BYTES = 6 * 1024 * 1024; // ~6 MB

const identifyFromPhotoTool: ToolExecutor = {
  declaration: {
    name: 'identifyFromPhoto',
    description:
      "READ-ONLY — given a publicly-fetchable image URL of a book cover (or a similar product), uses Gemini Vision to identify it. Returns structured metadata: title, author, isbn (if visible), publisher, edition, plus a confidence label. Use when the user has photographed a book and asks 'what is this?' / 'add this' / 'identify this cover.' For books that come back with an ISBN, follow up with lookupIsbn for canonical metadata, then optionally previewBulkBookImport. The URL must be HTTP(S) and the image must be ≤ 6 MB. Does NOT add anything to inventory.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        imageUrl: {
          type: SchemaType.STRING,
          description:
            'Public HTTP(S) URL of the image to identify. Signed Supabase Storage URLs work; arbitrary external URLs work too as long as the server can fetch them.',
        },
        hint: {
          type: SchemaType.STRING,
          description:
            "Optional free-text hint to disambiguate. E.g. 'this is a children's picture book' or 'looks like a Spanish-language edition.' Helps the model when the cover is unusual.",
        },
      },
      required: ['imageUrl'],
    },
  },
  async execute(args) {
    if (!env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY not configured');
    }
    const url = String(args.imageUrl ?? '');
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('imageUrl must be an http or https URL');
    }
    // SSRF guard: reject URLs whose host resolves to RFC-1918, AWS IMDS
    // (169.254.169.254), or any other internal range. Without this an
    // authenticated user can use the AI vision tool as an internal
    // probe, since the response body is read into Gemini's context
    // (and a sufficiently-imaged content-type would fly through the
    // image/* check below).
    try {
      await assertSafeFetchUrl(url);
    } catch (e) {
      if (e instanceof SsrfBlockedError) {
        throw new Error(`imageUrl rejected: ${e.reason}`);
      }
      throw e;
    }
    const hint = typeof args.hint === 'string' ? args.hint.slice(0, 500) : '';

    // Cheap pre-flight: HEAD the URL so we can reject obviously-huge
    // images BEFORE we buffer the whole thing into memory. Signed
    // Supabase URLs typically return content-length; arbitrary CDNs
    // may not. If the server doesn't advertise a length we fall
    // through to the streaming size cap below — at worst the in-flight
    // download is bounded by VISION_FETCH_TIMEOUT_MS + VISION_MAX_BYTES.
    try {
      const headAc = new AbortController();
      const headTimer = setTimeout(() => headAc.abort(), VISION_FETCH_TIMEOUT_MS);
      try {
        const headRes = await fetch(url, { method: 'HEAD', signal: headAc.signal });
        if (headRes.ok) {
          const advertisedType = headRes.headers
            .get('content-type')
            ?.split(';')[0]
            ?.trim();
          if (advertisedType && !advertisedType.startsWith('image/')) {
            throw new Error(
              `URL did not return an image (content-type: ${advertisedType})`,
            );
          }
          const advertisedLen = Number(headRes.headers.get('content-length') ?? 0);
          if (advertisedLen > VISION_MAX_BYTES) {
            throw new Error(
              `image too large (${advertisedLen} bytes; max ${VISION_MAX_BYTES})`,
            );
          }
        }
        // Non-OK HEAD: don't fail — many CDNs (incl. some Supabase
        // signed-URL paths) reject HEAD. Fall through to GET.
      } finally {
        clearTimeout(headTimer);
      }
    } catch (e) {
      // Re-throw only our own size/type errors — network errors on HEAD
      // shouldn't block a working GET.
      if (e instanceof Error && /image too large|did not return an image/.test(e.message)) {
        throw e;
      }
    }

    // Fetch the image with a hard timeout + size cap so a malicious or
    // huge URL can't tie up a function instance.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), VISION_FETCH_TIMEOUT_MS);
    let bytes: ArrayBuffer;
    let mimeType: string;
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) {
        throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
      }
      mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/jpeg';
      if (!mimeType.startsWith('image/')) {
        throw new Error(`URL did not return an image (content-type: ${mimeType})`);
      }
      // Belt-and-suspenders: if the GET response advertises a length
      // that already exceeds the cap, bail before allocating the
      // ArrayBuffer.
      const advertisedLen = Number(res.headers.get('content-length') ?? 0);
      if (advertisedLen > VISION_MAX_BYTES) {
        throw new Error(
          `image too large (${advertisedLen} bytes; max ${VISION_MAX_BYTES})`,
        );
      }
      bytes = await res.arrayBuffer();
      if (bytes.byteLength > VISION_MAX_BYTES) {
        throw new Error(
          `image too large (${bytes.byteLength} bytes; max ${VISION_MAX_BYTES})`,
        );
      }
    } finally {
      clearTimeout(timer);
    }

    const base64 = Buffer.from(bytes).toString('base64');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const visionModel = genAI.getGenerativeModel({
      model: VISION_MODEL,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            title: { type: SchemaType.STRING },
            author: { type: SchemaType.STRING },
            isbn: { type: SchemaType.STRING },
            publisher: { type: SchemaType.STRING },
            edition: { type: SchemaType.STRING },
            language: { type: SchemaType.STRING },
            confidence: {
              type: SchemaType.STRING,
              description: "One of 'high', 'medium', 'low'.",
            },
            notes: {
              type: SchemaType.STRING,
              description: 'Anything the model wants to flag — partial cover, blur, wrong angle, etc.',
            },
          },
          required: ['title', 'confidence'],
        },
      },
    });

    const prompt = `You are identifying the book or product in this image.
Return only the requested JSON. If a field isn't clearly visible or
inferable, omit it (do not guess). For ISBN, only fill it if you can
read the actual digits on the cover or back — never derive it from
the title. Confidence rubric:
  - "high": title + author are unambiguous from the image
  - "medium": title clear but author or edition uncertain
  - "low": you're inferring from a partial or blurry view
${hint ? `\nUser hint: ${hint}` : ''}`;

    const result = await visionModel.generateContent([
      { text: prompt },
      { inlineData: { data: base64, mimeType } },
    ]);

    const raw = result.response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Vision occasionally wraps JSON in code fences despite the
      // schema. Strip them and retry.
      const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      parsed = JSON.parse(cleaned);
    }
    return parsed;
  },
};

const listBundlesTool: ToolExecutor = {
  declaration: {
    name: 'listBundles',
    description:
      "READ-ONLY — list this org's bundle templates (kits made of multiple items). Use when the user asks 'what bundles do we have?' / 'show me our reading kits' / 'do we have a school visit bundle?' Returns id, name, sku, component count, pre-assembled qty (if pre-assembly is enabled), active flag. Resolve a bundle UUID with this BEFORE calling previewBundleDistribution.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        search: {
          type: SchemaType.STRING,
          description: 'Optional name/SKU substring filter.',
        },
        includeInactive: {
          type: SchemaType.BOOLEAN,
          description: 'If true, include archived/inactive bundles. Default false.',
        },
      },
    },
  },
  async execute(args, ctx) {
    const svc = new BundlesService(ctx);
    const search = typeof args.search === 'string' ? args.search : undefined;
    const includeInactive = args.includeInactive === true;
    const rows = await svc.list({ search, includeInactive });
    return rows.map((b) => ({
      id: b.id,
      name: b.name,
      sku: b.sku,
      componentCount: b.componentCount,
      preassemblyEnabled: b.preassemblyEnabled,
      preassembledQty: b.preassembledQty,
      isActive: b.isActive,
      lastDistributedAt: b.lastDistributedAt,
    }));
  },
};

const previewBundleDistributionTool: ToolExecutor = {
  declaration: {
    name: 'previewBundleDistribution',
    description:
      "READ-ONLY — dry-run a bundle distribution. Tells you what stock would be drawn if you distributed N kits at a given warehouse, and whether any components would short. Use for 'if I give out 20 reading kits today, what would I draw?' / 'do we have enough stock for 50 school visit packs?'. Resolve bundle/warehouse UUIDs via listBundles + listWarehouses first. There is NO execute tool for distributions — direct the user to /dashboard/bundles/<id> to confirm and ship.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        bundleId: { type: SchemaType.STRING, description: 'UUID of the bundle.' },
        quantity: {
          type: SchemaType.NUMBER,
          description: 'Number of kits to distribute (positive integer).',
        },
        warehouseId: {
          type: SchemaType.STRING,
          description: 'UUID of the source warehouse.',
        },
      },
      required: ['bundleId', 'quantity', 'warehouseId'],
    },
  },
  async execute(args, ctx) {
    const svc = new BundlesService(ctx);
    const bundleId = String(args.bundleId ?? '');
    const quantity = Number(args.quantity ?? 0);
    const warehouseId = String(args.warehouseId ?? '');
    if (!bundleId || !warehouseId) throw new Error('bundleId and warehouseId are required');
    if (!Number.isFinite(quantity) || quantity <= 0)
      throw new Error('quantity must be positive');
    return svc.preview(bundleId, quantity, warehouseId);
  },
};

const listOrderRequestsTool: ToolExecutor = {
  declaration: {
    name: 'listOrderRequests',
    description:
      "READ-ONLY — list order requests in the workspace queue. Use for 'what orders are waiting', 'show me pending requests', 'what did Maria order', 'any orders from sequoia elementary'. Filter by status (pending_approval | approved | packaging | ready_for_delivery | delivered | denied | cancelled) and/or by an external requester's email (matches order_requests.requester_email exactly — public-link submissions only). Returns total + a compact row per request with requesterDisplay (name + org for externals, full_name/email for internal users), warehouseName, lineCount, totalQuantity, and key timestamps. There is NO execute tool for order writes — direct the user to /dashboard/orders/<id> to approve / deny / change status.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        status: {
          type: SchemaType.STRING,
          description:
            "Optional status filter. One of 'pending_approval', 'approved', 'packaging', 'ready_for_delivery', 'delivered', 'denied', 'cancelled'. Empty = all statuses.",
        },
        requesterEmail: {
          type: SchemaType.STRING,
          description:
            'Optional exact-match filter on requester_email (public-link external requesters). Empty = no filter.',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Max rows (1-50). Default 25.',
        },
      },
    },
  },
  async execute(args, ctx) {
    const allowedStatuses = new Set([
      'pending_approval',
      'approved',
      'packaging',
      'ready_for_delivery',
      'delivered',
      'denied',
      'cancelled',
    ]);
    const status =
      typeof args.status === 'string' && allowedStatuses.has(args.status)
        ? (args.status as
            | 'pending_approval'
            | 'approved'
            | 'packaging'
            | 'ready_for_delivery'
            | 'delivered'
            | 'denied'
            | 'cancelled')
        : undefined;
    const requesterEmail =
      typeof args.requesterEmail === 'string' && args.requesterEmail.length > 0
        ? args.requesterEmail
        : null;
    const limit = Math.min(50, Math.max(1, Number(args.limit) || 25));

    const svc = new OrderRequestsService(ctx);
    const rows = await svc.list({
      status,
      limit,
      ...(requesterEmail ? { requesterEmail } : {}),
    });

    // Batched lookup of internal-user display names (full_name/email).
    const userIds = Array.from(
      new Set(
        rows
          .filter((r) => r.requesterUserId)
          .map((r) => r.requesterUserId as string),
      ),
    );
    const userMap = new Map<string, { fullName: string | null; email: string | null }>();
    if (userIds.length > 0) {
      const { data: profiles } = await ctx.supabase
        .from('user_profiles')
        .select('id, full_name, email')
        .in('id', userIds);
      for (const p of (profiles ?? []) as Array<{
        id: string;
        full_name: string | null;
        email: string | null;
      }>) {
        userMap.set(p.id, { fullName: p.full_name, email: p.email });
      }
    }

    return {
      total: rows.length,
      requests: rows.map((r) => {
        let requesterDisplay: string;
        if (r.requesterUserId) {
          const u = userMap.get(r.requesterUserId);
          requesterDisplay = u?.fullName || u?.email || '(team member)';
        } else {
          requesterDisplay = `${r.requesterName ?? 'External requester'}${r.requesterOrgLabel ? ' · ' + r.requesterOrgLabel : ''}`;
        }
        return {
          id: r.id,
          status: r.status,
          requesterDisplay,
          warehouseName: r.warehouseName,
          lineCount: r.lineCount,
          totalQuantity: r.totalQuantity,
          createdAt: r.createdAt,
          approvedAt: r.approvedAt,
          deliveredAt: r.deliveredAt,
        };
      }),
    };
  },
};

const getOrderRequestSummaryTool: ToolExecutor = {
  declaration: {
    name: 'getOrderRequestSummary',
    description:
      "READ-ONLY — overall order-request stats. Returns pendingCount, overdueCount (pending_approval older than 3 days), and a byStatus breakdown { pending_approval, approved, packaging, ready_for_delivery, delivered_today }. Use for 'anything overdue', 'how many pending', 'summary of orders'. There is NO execute tool for order writes — direct the user to /dashboard/orders/<id> to approve / deny / change status.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  async execute(_args, ctx) {
    const now = new Date();
    const threeDaysAgoIso = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const startOfTodayIso = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ).toISOString();

    const baseCount = (status: string) =>
      ctx.supabase
        .from('order_requests')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', ctx.organizationId)
        .eq('status', status);

    const [
      pendingRes,
      approvedRes,
      packagingRes,
      readyRes,
      overdueRes,
      deliveredTodayRes,
    ] = await Promise.all([
      baseCount('pending_approval'),
      baseCount('approved'),
      baseCount('packaging'),
      baseCount('ready_for_delivery'),
      ctx.supabase
        .from('order_requests')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', ctx.organizationId)
        .eq('status', 'pending_approval')
        .lt('created_at', threeDaysAgoIso),
      ctx.supabase
        .from('order_requests')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', ctx.organizationId)
        .eq('status', 'delivered')
        .gte('delivered_at', startOfTodayIso),
    ]);

    return {
      pendingCount: pendingRes.count ?? 0,
      overdueCount: overdueRes.count ?? 0,
      byStatus: {
        pending_approval: pendingRes.count ?? 0,
        approved: approvedRes.count ?? 0,
        packaging: packagingRes.count ?? 0,
        ready_for_delivery: readyRes.count ?? 0,
        delivered_today: deliveredTodayRes.count ?? 0,
      },
    };
  },
};

export const TOOL_CATALOG: Record<string, ToolExecutor> = {
  searchInventory: searchInventoryTool,
  listCategories: listCategoriesTool,
  getItemDetails: getItemDetailsTool,
  listLowStock: listLowStockTool,
  getDashboardSummary: getDashboardSummaryTool,
  inventoryByWarehouse: inventoryByWarehouseTool,
  inventoryByCategory: inventoryByCategoryTool,
  recentMovements: recentMovementsTool,
  listSuppliers: listSuppliersTool,
  listWarehouses: listWarehousesTool,
  adjustStock: adjustStockTool,
  lookupIsbn: lookupIsbnTool,
  previewBulkBookImport: previewBulkBookImportTool,
  executeBulkBookImport: executeBulkBookImportTool,
  exportInventory: exportInventoryTool,
  draftPos: draftPosTool,
  predictRunout: predictRunoutTool,
  suggestReorderPoint: suggestReorderPointTool,
  identifyFromPhoto: identifyFromPhotoTool,
  listBundles: listBundlesTool,
  previewBundleDistribution: previewBundleDistributionTool,
  listOrderRequests: listOrderRequestsTool,
  getOrderRequestSummary: getOrderRequestSummaryTool,
};

export function toolDeclarations(): FunctionDeclaration[] {
  return Object.values(TOOL_CATALOG).map((t) => t.declaration);
}
