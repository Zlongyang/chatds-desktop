import { z } from 'zod';
import type { AppConfig } from './types.js';

const entry = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    name: z.string().trim().min(1).max(80),
    text: z.string().trim().min(1).max(4000),
  })
  .strict();
const collection = z
  .array(entry)
  .max(40)
  .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, '资料条目编号重复');
export const tavernContextSchema = z
  .object({
    userPersonas: collection,
    worldEntries: collection,
  })
  .strict();
export type TavernContextLibrary = z.infer<typeof tavernContextSchema>;

function ownerRoom(config: AppConfig, roomId: string): boolean {
  const owner = config.onebot.ownerQQ;
  return roomId === 'desktop:owner' || (!!owner && roomId === 'onebot:private:' + owner);
}

export function pruneTavernSelections(config: AppConfig): void {
  const people = new Set(config.tavernContext?.userPersonas.map((item) => item.id));
  const world = new Set(config.tavernContext?.worldEntries.map((item) => item.id));
  for (const [roomId, room] of Object.entries(config.conversations)) {
    if (room.userPersonaId && (!ownerRoom(config, roomId) || !people.has(room.userPersonaId)))
      delete room.userPersonaId;
    if (room.worldEntryIds)
      room.worldEntryIds = [...new Set(room.worldEntryIds.filter((id) => world.has(id)))];
  }
}

/** Only the explicit selection for this exact conversation is eligible for the model. */
export function tavernContextText(config: AppConfig, roomId: string): string {
  const library = config.tavernContext;
  const room = config.conversations[roomId];
  if (!library || !room) return '';
  const user =
    ownerRoom(config, roomId) &&
    library.userPersonas.find((item) => item.id === room.userPersonaId);
  const world = [];
  let remaining = 4000;
  for (const id of new Set(room.worldEntryIds)) {
    const item = library.worldEntries.find((row) => row.id === id);
    if (!item || remaining < 1) continue;
    const content = item.text.slice(0, remaining);
    world.push({ 名称: item.name, 背景: content });
    remaining -= content.length;
  }
  if (!user && !world.length) return '';
  // Keep text quoted in a single JSON record even when cards contain newlines or markup.
  return JSON.stringify({
    ...(user ? { 对话者身份: { 称呼: user.name, 说明: user.text } } : {}),
    ...(world.length ? { 世界书: world } : {}),
  }).replace(/[<>\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
