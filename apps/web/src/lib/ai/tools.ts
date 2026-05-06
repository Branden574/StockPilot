import 'server-only';

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';

import { lookupIsbn as lookupIsbnLib } from '@/lib/books/lookup';
import type { ServiceContext } from '@/server/services/context';
import { BooksImportService } from '@/server/services/books-import';
import { CategoriesService } from '@/server/services/categories';
import { InventoryService } from '@/server/services/inventory';
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
      "Search the inventory. Filter by free-text (name/SKU/barcode), category UUID, status, low-stock, out-of-stock, item type, or warehouse. The result's `total` field is the TRUE count even when only 25 items are returned — use that for 'how many' questions. When the user names a category by label (e.g. \"Swag\", \"Books\"), call listCategories first to resolve the UUID, then re-query with categoryId.",
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
      limit: Math.min(25, Math.max(1, Number(args.limit) || 10)),
    });
    return {
      total: result.total,
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

export const TOOL_CATALOG: Record<string, ToolExecutor> = {
  searchInventory: searchInventoryTool,
  listCategories: listCategoriesTool,
  getItemDetails: getItemDetailsTool,
  listLowStock: listLowStockTool,
  getDashboardSummary: getDashboardSummaryTool,
  recentMovements: recentMovementsTool,
  listSuppliers: listSuppliersTool,
  listWarehouses: listWarehousesTool,
  adjustStock: adjustStockTool,
  lookupIsbn: lookupIsbnTool,
  previewBulkBookImport: previewBulkBookImportTool,
  executeBulkBookImport: executeBulkBookImportTool,
};

export function toolDeclarations(): FunctionDeclaration[] {
  return Object.values(TOOL_CATALOG).map((t) => t.declaration);
}
