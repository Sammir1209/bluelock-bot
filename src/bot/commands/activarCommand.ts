import { Telegraf } from 'telegraf';
import { CustomContext } from '../middlewares/accessControl';
import { activationQueue } from '../../services/queueService';
import { config } from '../../config/env';

export function registerActivarCommand(bot: Telegraf<CustomContext>) {
  // Notificar a los administradores si ocurre un fallo crítico de sesión o de sistema
  const notifyOwners = async (botInstance: Telegraf<CustomContext>, detail: string, code: string, userText: string) => {
    // Sanitizar logs o errores largos para evitar romper el parser Markdown de Telegram
    const cleanDetail = detail.split('\n')[0].replace(/[_*[\]()~`>#+-=|{}.!]/g, ' ').substring(0, 200);

    for (const ownerId of config.ownerIds) {
      try {
        await botInstance.telegram.sendMessage(
          ownerId,
          `🚨 <b>Alerta para Administrador:</b>\n━━━━━━━━━━━━━━━━━━━━\n🔑 <b>Código:</b> <code>${code}</code>\n👤 <b>Usuario:</b> ${userText}\n⚠️ <b>Detalle:</b> ${cleanDetail}\n\n👉 Usa /panel para revisar la sesión.`,
          { parse_mode: 'HTML' }
        );
      } catch (e: any) {
        if (e?.response?.description?.includes('chat not found')) {
          console.log(`[NotifyOwner] El Owner ${ownerId} aún no ha iniciado chat privado con el bot (/start).`);
        } else {
          console.error(`[NotifyOwner] No se pudo enviar alerta al Owner ${ownerId}:`, e?.message || e);
        }
      }
    }
  };

  // Manejador del comando /activar <codigo>
  bot.command('activar', async (ctx) => {
    const text = ctx.message.text.trim();
    const parts = text.split(/\s+/);

    if (parts.length < 2) {
      await ctx.reply('⚠️ *Por favor introduce el código:* `/activar <codigo>`\n_Ejemplo: `/activar ABC123`_', {
        parse_mode: 'Markdown'
      });
      return;
    }

    const code = parts[1].trim().toUpperCase();

    if (code.length < 4 || code.length > 10) {
      await ctx.reply('⚠️ *Formato de código inválido.* Los códigos de Surfshark son de 6 caracteres.', {
        parse_mode: 'Markdown'
      });
      return;
    }

    const queueLength = activationQueue.getQueueLength();
    let initialText = `⏳ *Procesando activación para el código:* \`${code}\`\nPor favor espera unos segundos...`;
    if (queueLength > 0) {
      initialText += `\n_Posición en cola: ${queueLength}_`;
    }

    const statusMsg = await ctx.reply(initialText, { parse_mode: 'Markdown' });
    const isOwner = !!ctx.state.isOwner;
    const userLabel = ctx.from?.username ? `@${ctx.from.username}` : `${ctx.from?.first_name || 'Usuario'} (ID: \`${ctx.from?.id}\`)`;

    try {
      const result = await activationQueue.enqueue(
        code,
        ctx.from?.id || 0,
        ctx.from?.username || ctx.from?.first_name
      );

      if (result.success) {
        let successMsg = `✅ <b>¡Activación Exitosa!</b>\n━━━━━━━━━━━━━━━━━━━━\n🔑 <b>Código:</b> <code>${code}</code>\n🎉 <b>Estado:</b> Dispositivo conectado con éxito a Surfshark.`;
        if (result.deviceInfo) {
          successMsg += `\n━━━━━━━━━━━━━━━━━━━━\n📱 <b>Dispositivo:</b> ${result.deviceInfo.name || 'Dispositivo vinculado'}`;
          if (result.deviceInfo.os) {
            successMsg += `\n💻 <b>Sistema / App:</b> ${result.deviceInfo.os}`;
          }
          if (result.deviceInfo.addedDate) {
            successMsg += `\n⏰ <b>Hora de enlace:</b> ${result.deviceInfo.addedDate}`;
          }
        }

        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          undefined,
          successMsg,
          { parse_mode: 'HTML' }
        );
      } else {
        const isSessionError = result.message.includes('sesión') || result.message.includes('/panel') || result.message.includes('expiró');

        // Si es un error de sesión interno del bot:
        if (isSessionError) {
          // Notificar en privado a los Owners
          await notifyOwners(bot, result.message, code, userLabel);

          // Si el que ejecutó fue el Owner, mostrarle el detalle completo
          if (isOwner) {
            const shortDetail = result.message.split('\n')[0].substring(0, 150);
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMsg.message_id,
              undefined,
              `❌ <b>Error de Activación (Owner)</b>\n━━━━━━━━━━━━━━━━━━━━\n🔑 <b>Código:</b> <code>${code}</code>\n⚠️ <b>Detalle:</b> ${shortDetail}`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          } else {
            // A los usuarios comunes solo se les muestra un mensaje limpio y amigable
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMsg.message_id,
              undefined,
              `❌ *No se pudo activar el dispositivo*\n━━━━━━━━━━━━━━━━━━━━\n🔑 *Código:* \`${code}\`\n⚠️ El servicio se encuentra en mantenimiento o el código es inválido. Por favor intenta de nuevo en unos momentos.`,
              { parse_mode: 'Markdown' }
            );
          }
        } else {
          // Si fue error del código (ej. código inválido/expirado en Surfshark)
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            undefined,
            `❌ *Error al Activar*\n━━━━━━━━━━━━━━━━━━━━\n🔑 *Código:* \`${code}\`\n⚠️ *Detalle:* ${result.message}`,
            { parse_mode: 'Markdown' }
          );
        }
      }
    } catch (err: any) {
      console.error('[ActivarCommand] Error:', err);
      await notifyOwners(bot, err?.message || 'Error desconocido', code, userLabel);

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `❌ No se pudo completar la activación en este momento. Intenta de nuevo más tarde.`
      );
    }
  });

  // Listener para códigos enviados directamente (sin el prefijo /activar)
  bot.on('text', async (ctx, next) => {
    const text = ctx.message.text.trim();

    if (text.startsWith('/')) {
      return next();
    }

    const isCode = /^[A-Za-z0-9]{6}$/.test(text);
    if (!isCode) {
      return next();
    }

    const code = text.toUpperCase();
    const statusMsg = await ctx.reply(
      `⏳ *Detectado código:* \`${code}\`\nProcesando activación en Surfshark...`,
      { parse_mode: 'Markdown' }
    );

    const isOwner = !!ctx.state.isOwner;
    const userLabel = ctx.from?.username ? `@${ctx.from.username}` : `${ctx.from?.first_name || 'Usuario'} (ID: \`${ctx.from?.id}\`)`;

    try {
      const result = await activationQueue.enqueue(
        code,
        ctx.from?.id || 0,
        ctx.from?.username || ctx.from?.first_name
      );

      if (result.success) {
        let successMsg = `✅ <b>¡Activación Exitosa!</b>\n━━━━━━━━━━━━━━━━━━━━\n🔑 <b>Código:</b> <code>${code}</code>\n🎉 <b>Estado:</b> Dispositivo conectado con éxito a Surfshark.`;
        if (result.deviceInfo) {
          successMsg += `\n━━━━━━━━━━━━━━━━━━━━\n📱 <b>Dispositivo:</b> ${result.deviceInfo.name || 'Dispositivo vinculado'}`;
          if (result.deviceInfo.os) {
            successMsg += `\n💻 <b>Sistema / App:</b> ${result.deviceInfo.os}`;
          }
          if (result.deviceInfo.addedDate) {
            successMsg += `\n⏰ <b>Hora de enlace:</b> ${result.deviceInfo.addedDate}`;
          }
        }

        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          undefined,
          successMsg,
          { parse_mode: 'HTML' }
        );
      } else {
        const isSessionError = result.message.includes('sesión') || result.message.includes('/panel') || result.message.includes('expiró');

        if (isSessionError) {
          await notifyOwners(bot, result.message, code, userLabel);

          if (isOwner) {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMsg.message_id,
              undefined,
              `❌ *Error de Sesión (Owner)*\n━━━━━━━━━━━━━━━━━━━━\n🔑 *Código:* \`${code}\`\n⚠️ *Detalle:* ${result.message}`,
              { parse_mode: 'Markdown' }
            );
          } else {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMsg.message_id,
              undefined,
              `❌ *No se pudo activar el dispositivo*\n━━━━━━━━━━━━━━━━━━━━\n🔑 *Código:* \`${code}\`\n⚠️ El servicio se encuentra en mantenimiento o el código es inválido. Por favor intenta de nuevo en unos momentos.`,
              { parse_mode: 'Markdown' }
            );
          }
        } else {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            undefined,
            `❌ *Error al Activar*\n━━━━━━━━━━━━━━━━━━━━\n🔑 *Código:* \`${code}\`\n⚠️ *Detalle:* ${result.message}`,
            { parse_mode: 'Markdown' }
          );
        }
      }
    } catch (err: any) {
      await notifyOwners(bot, err?.message || 'Error desconocido', code, userLabel);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `❌ No se pudo completar la activación en este momento. Intenta de nuevo más tarde.`
      );
    }
  });
}
