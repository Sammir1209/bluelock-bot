import { Telegraf, Markup } from 'telegraf';
import { CustomContext } from '../middlewares/accessControl';
import { ConfigRepository } from '../../db/configRepository';
import { surfsharkBrowser } from '../../services/surfsharkBrowser';
import * as fs from 'fs';

export function registerPanelCommands(bot: Telegraf<CustomContext>) {
  // Genera el texto y los botones del panel multi-cuenta
  const renderPanel = async () => {
    const accounts = await ConfigRepository.getAllAccounts();
    const activeChat = await ConfigRepository.getActiveConfig();

    let accountListText = '';
    if (accounts.length === 0) {
      accountListText = '⚠️ _No hay ninguna cuenta vinculada todavía._';
    } else {
      accountListText = accounts
        .map((acc) => {
          const statusIcon = acc.isLoggedIn && acc.isActive ? '🟢' : acc.isActive ? '🟡 Requiere Login' : '🔴 Pausada';
          const emailDisplay = acc.email ? ` (${acc.email})` : '';
          return `${statusIcon} *#${acc.id} ${acc.alias}*${emailDisplay}\n  • Estado: ${acc.isLoggedIn ? '🟢 Conectada' : '🔴 Desconectada'}\n  • 📱 *Dispositivos activos:* \`${acc.devicesCount}\`\n  • ⚡ *Activaciones realizadas:* \`${acc.totalActives}\``;
        })
        .join('\n\n');
    }

    const text = [
      '🛡️ *PANEL MULTI-CUENTA SURFSHARK (VIP)*',
      '━━━━━━━━━━━━━━━━━━━━',
      '📊 *Cuentas Registradas en el Pool:*',
      accountListText,
      '━━━━━━━━━━━━━━━━━━━━',
      '💬 *Canal/Tópico de Trabajo:*',
      `• *Chat ID:* \`${activeChat?.chatId || 'No fijado'}\``,
      `• *Topic ID:* \`${activeChat?.topicId || 'General'}\``,
      '━━━━━━━━━━━━━━━━━━━━',
      '👉 *Balanceo:* Las activaciones se reparten automáticamente entre las cuentas activas con failover transparente.'
    ].join('\n');

    const inlineKeyboard: any[][] = [];

    // Fila 1 (2 botones): [ ➕ Vincular Cuenta | 🔄 Refrescar ]
    inlineKeyboard.push([
      Markup.button.callback('➕ Nueva Cuenta', 'panel_add_account'),
      Markup.button.callback('🔄 Refrescar', 'panel_refresh')
    ]);

    // Botones de las cuentas
    const accountButtons = accounts.map((a) =>
      Markup.button.callback(`${a.isActive ? '⏸️ Pausar' : '▶️ Activar'} #${a.id}`, `panel_toggle_${a.id}`)
    );

    // Botón de fijar chat
    const fixChatBtn = Markup.button.callback('📌 Fijar Este Chat', 'panel_setchat');

    // Combinar los botones de las cuentas y el de fijar chat en grupos de 2 exactos
    const remainingButtons = [...accountButtons, fixChatBtn];

    for (let i = 0; i < remainingButtons.length; i += 2) {
      inlineKeyboard.push(remainingButtons.slice(i, i + 2));
    }

    return { text, keyboard: Markup.inlineKeyboard(inlineKeyboard) };
  };

  // Comando /panel para administradores
  bot.command('panel', async (ctx) => {
    if (!ctx.state.isOwner) return;
    const { text, keyboard } = await renderPanel();
    await ctx.replyWithMarkdown(text, keyboard);
  });

  // Callback para refrescar el panel y sincronizar dispositivos reales de Surfshark
  bot.action('panel_refresh', async (ctx) => {
    if (!ctx.state.isOwner) return;
    await ctx.answerCbQuery('Sincronizando dispositivos con Surfshark...');

    // Sincronizar en vivo el total de dispositivos de las cuentas activas
    const activeAccounts = await ConfigRepository.getActiveAccounts();
    for (const acc of activeAccounts) {
      await surfsharkBrowser.syncAccountDevices(acc.id, acc.sessionFile).catch(() => {});
    }

    const { text, keyboard } = await renderPanel();
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...keyboard
    }).catch(() => {});
  });

  // Callback para añadir una nueva cuenta
  bot.action('panel_add_account', async (ctx) => {
    if (!ctx.state.isOwner) return;
    await ctx.answerCbQuery('Preparando nueva cuenta...');

    const newAcc = await ConfigRepository.createNewAccount();
    const waitMsg = await ctx.reply(
      `⏳ *Iniciando vinculación para Cuenta #${newAcc.id} (${newAcc.alias})...*\nObteniendo código y QR de Surfshark...`,
      { parse_mode: 'Markdown' }
    );

    const targetChatId = ctx.chat?.id;
    if (!targetChatId) return;

    const result = await surfsharkBrowser.startAppLoginForAccount(
      newAcc.id,
      newAcc.sessionFile,
      async (approvedId) => {
        try {
          if (approvedId < 0) {
            const originalId = Math.abs(approvedId);
            await ctx.telegram.sendMessage(
              targetChatId,
              `⚠️ *¡Esta cuenta ya se encuentra vinculada!*\n\nEl correo escaneado pertenece a la *Cuenta #${originalId}* existente en el bot. No se crearon duplicados innecesarios.`,
              { parse_mode: 'Markdown' }
            );
          } else {
            await ctx.telegram.sendMessage(
              targetChatId,
              `🎉 *¡Cuenta #${approvedId} vinculada y guardada con éxito!*\n\nYa está añadida y activa en el Pool de activaciones.`,
              { parse_mode: 'Markdown' }
            );
          }
        } catch (err) {
          console.error('[Telegram] Error al notificar login de cuenta:', err);
        }
      }
    );

    if (!result.success) {
      return ctx.telegram.editMessageText(
        targetChatId,
        waitMsg.message_id,
        undefined,
        `❌ ${result.message}`
      ).catch(() => {});
    }

    const cancelKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancelar Vinculación', `panel_cancel_login_${newAcc.id}`)]
    ]);

    if (result.qrImagePath && fs.existsSync(result.qrImagePath)) {
      try {
        await ctx.telegram.sendPhoto(
          targetChatId,
          { source: result.qrImagePath },
          {
            caption: [
              `📲 *Vincular Cuenta #${newAcc.id} (${newAcc.alias})*`,
              '━━━━━━━━━━━━━━━━━━━━',
              `🔑 *Código:* \`${result.code}\``,
              '',
              '👉 *Pasos:*',
              '1. Abre la app de Surfshark con esta cuenta.',
              '2. Ve a: *Configuración ➔ Mi cuenta ➔ Introducir código de inicio de sesión*.',
              `3. Escribe el código: \`${result.code}\` (o escanea el QR).`,
              '',
              '⏳ *Esperando que confirmes en la app... Te avisaré apenas se conecte.*'
            ].join('\n'),
            parse_mode: 'Markdown',
            ...cancelKeyboard
          }
        );
      } catch (err) {
        await ctx.reply(
          `📲 *Código de vinculación para Cuenta #${newAcc.id}:* \`${result.code}\`\n\nIntrodúcelo en la app de Surfshark.`,
          { parse_mode: 'Markdown', ...cancelKeyboard }
        ).catch(() => {});
      }
    }
  });

  // Callback para cancelar vinculación en curso
  bot.action(/panel_cancel_login_(\d+)/, async (ctx) => {
    if (!ctx.state.isOwner) return;
    const accountId = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery('Cancelando proceso de vinculación...');

    await surfsharkBrowser.cancelAppLogin(accountId);

    try {
      if (ctx.callbackQuery.message) {
        await ctx.deleteMessage().catch(() => {});
      }
    } catch (e) {}

    await ctx.reply(`❌ *Vinculación de Cuenta #${accountId} cancelada.* Registro descartado.`, {
      parse_mode: 'Markdown'
    });

    const { text, keyboard } = await renderPanel();
    await ctx.replyWithMarkdown(text, keyboard).catch(() => {});
  });

  // Callback para pausar / activar cuenta
  bot.action(/panel_toggle_(\d+)/, async (ctx) => {
    if (!ctx.state.isOwner) return;
    const accountId = parseInt(ctx.match[1], 10);
    const updated = await ConfigRepository.toggleAccountActive(accountId);
    await ctx.answerCbQuery(updated?.isActive ? `Cuenta #${accountId} activada` : `Cuenta #${accountId} pausada`);

    const { text, keyboard } = await renderPanel();
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...keyboard
    }).catch(() => {});
  });

  // Callback para fijar chat/topic actual
  bot.action('panel_setchat', async (ctx) => {
    if (!ctx.state.isOwner) return;
    const chatId = ctx.chat?.id.toString();
    if (!chatId) return;

    const topicId = (ctx.callbackQuery.message as any)?.message_thread_id
      ? (ctx.callbackQuery.message as any).message_thread_id.toString()
      : null;

    const chatTitle = ctx.chat && 'title' in ctx.chat ? (ctx.chat as any).title : 'Grupo configurado';
    await ConfigRepository.setChatConfig({
      chatId,
      topicId,
      isActive: true,
      description: chatTitle
    });

    await ctx.answerCbQuery('¡Chat y Topic configurados exitosamente!');
    await ctx.reply(`✅ *Chat Autorizado:* \`${chatId}\`\n📌 *Topic ID:* \`${topicId || 'General'}\``, {
      parse_mode: 'Markdown'
    });
  });

  // Comando /setchat desde texto
  bot.command('setchat', async (ctx) => {
    if (!ctx.state.isOwner) return;

    const chatId = ctx.chat.id.toString();
    const topicId = (ctx.message as any)?.message_thread_id
      ? (ctx.message as any).message_thread_id.toString()
      : null;

    const chatTitle = ctx.chat && 'title' in ctx.chat ? (ctx.chat as any).title : 'Grupo configurado';
    await ConfigRepository.setChatConfig({
      chatId,
      topicId,
      isActive: true,
      description: chatTitle
    });

    await ctx.reply(
      `✅ *Canal/Grupo Autorizado con Éxito*\n\n• *Chat ID:* \`${chatId}\`\n• *Topic ID:* \`${topicId || 'Todos / Sin Topic'}\``,
      { parse_mode: 'Markdown' }
    );
  });
}
