import { Context, MiddlewareFn } from 'telegraf';
import { config } from '../../config/env';
import { ConfigRepository } from '../../db/configRepository';

export interface CustomContext extends Context {
  state: {
    isOwner?: boolean;
  };
}

export const accessControlMiddleware: MiddlewareFn<CustomContext> = async (ctx, next) => {
  const fromId = ctx.from?.id ? ctx.from.id.toString() : '';
  const isOwner = config.ownerIds.includes(fromId);

  ctx.state = ctx.state || {};
  ctx.state.isOwner = isOwner;

  // Si es Owner, tiene bypass total en cualquier chat y privado
  if (isOwner) {
    return next();
  }

  // Si es un chat privado y NO es owner, ignorar en silencio
  if (ctx.chat?.type === 'private') {
    return;
  }

  // Para grupos/supergrupos: verificar que el grupo y el topic coincidan con los configurados
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // En supergrupos con tópicos, message_thread_id identifica el topic
  const messageThreadId = (ctx.message as any)?.message_thread_id || null;

  const isAllowed = await ConfigRepository.isChatAllowed(chatId, messageThreadId);
  if (!isAllowed) {
    // Ignora silenciosamente la interacción para chats/topics no autorizados
    return;
  }

  return next();
};
