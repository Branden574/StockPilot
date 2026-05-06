import 'server-only';

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';

import type { ServiceContext } from '@/server/services/context';
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
      'Search the inventory by free-text on name, SKU, or barcode. Optionally filter by status, low-stock, out-of-stock, item type, or a specific warehouse. Returns up to 25 matches.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            'Free-text query. Matches name, SKU, or barcode. Empty string = no text filter.',
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

export const TOOL_CATALOG: Record<string, ToolExecutor> = {
  searchInventory: searchInventoryTool,
  getItemDetails: getItemDetailsTool,
  listLowStock: listLowStockTool,
  getDashboardSummary: getDashboardSummaryTool,
  recentMovements: recentMovementsTool,
  listSuppliers: listSuppliersTool,
  listWarehouses: listWarehousesTool,
};

export function toolDeclarations(): FunctionDeclaration[] {
  return Object.values(TOOL_CATALOG).map((t) => t.declaration);
}
