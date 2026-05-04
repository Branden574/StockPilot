import { z } from 'zod';

export const roundingRuleSchema = z.enum(['exact', 'floor', 'ceil', 'round']);
export type RoundingRule = z.infer<typeof roundingRuleSchema>;

export const upsertUomConversionSchema = z.object({
  itemId: z.string().uuid(),
  fromUom: z.string().min(1).max(16).trim(),
  toUom: z.string().min(1).max(16).trim(),
  numerator: z.number().int().positive(),
  denominator: z.number().int().positive().default(1),
  roundingRule: roundingRuleSchema.default('exact'),
});
export type UpsertUomConversionInput = z.infer<typeof upsertUomConversionSchema>;

export const deleteUomConversionSchema = z.object({
  id: z.string().uuid(),
});
export type DeleteUomConversionInput = z.infer<typeof deleteUomConversionSchema>;
