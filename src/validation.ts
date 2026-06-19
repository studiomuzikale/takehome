import { z } from 'zod';

const uuid = z.string().uuid();
const amount = z.number().int().positive();

const betAction = z.object({
  action: z.literal('bet'),
  action_id: uuid,
  amount
});

const winAction = z.object({
  action: z.literal('win'),
  action_id: uuid,
  amount
});

const rollbackAction = z.object({
  action: z.literal('rollback'),
  action_id: uuid,
  original_action_id: uuid
});

export const processRequestSchema = z.object({
  user_id: z.string().min(1),
  currency: z.string().min(1),
  game: z.string().min(1),
  game_id: z.string().min(1).optional(),
  finished: z.boolean().optional(),
  actions: z.array(z.discriminatedUnion('action', [betAction, winAction, rollbackAction])).optional()
});

export const reportQuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  currency: z.string().min(1).optional(),
  user_id: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0)
});

export type ProcessRequest = z.infer<typeof processRequestSchema>;
export type ProcessAction = NonNullable<ProcessRequest['actions']>[number];
export type ReportQuery = z.infer<typeof reportQuerySchema>;
