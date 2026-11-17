import { z } from 'zod';
import type { ToolId } from './types.js';
const text = (max = 6000) => z.string().min(1).max(max);
export const toolArguments: Record<ToolId, z.ZodType> = {
  memory_search: z.object({ query: z.string().max(1000) }).strict(),
  memory_remember: z.object({ content: text(800) }).strict(),
  skills_load: z
    .object({ id: z.string().regex(/^[a-f0-9]{24}$/), resource: z.string().max(150).optional() })
    .strict(),
  read_file: z.object({ path: text(250) }).strict(),
  write_file: z.object({ path: text(250), content: z.string().max(100000) }).strict(),
  web_read: z.object({ url: z.string().url().max(2048) }).strict(),
  sandbox_exec: z
    .object({
      language: z.enum(['javascript', 'python']),
      code: text(30000),
      outputs: z.array(text(100)).max(5).optional(),
    })
    .strict(),
  qzone_publish: z.object({ content: text(2000) }).strict(),
};
export function toolSchema(tool: ToolId): object {
  return z.toJSONSchema(toolArguments[tool], { target: 'draft-7' });
}
