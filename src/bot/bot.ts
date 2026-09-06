import { Telegraf } from 'telegraf';
import { config } from '../config/env';
import { CustomContext, accessControlMiddleware } from './middlewares/accessControl';
import { registerPanelCommands } from './commands/panelCommand';
import { registerActivarCommand } from './commands/activarCommand';

export function createBot(): Telegraf<CustomContext> {
  const bot = new Telegraf<CustomContext>(config.botToken);

  // 1. Middleware de control de acceso estricto
  bot.use(accessControlMiddleware);

  // 2. Comandos comunes
  bot.start(async (ctx) => {
    if (ctx.state.isOwner) {
      return ctx.reply(
        '👋 *¡Hola Owner!*\n\nUsa `/panel` para configurar el bot o tus credenciales de Surfshark.',
        { parse_mode: 'Markdown' }
      );
    }
    return ctx.reply(
      '🤖 *Bot de Activación Surfshark*\n\nUsa `/activar <codigo>` o envía directamente tu código de 6 dígitos para vincular tu dispositivo.',
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('status', async (ctx) => {
    if (!ctx.state.isOwner) return;
    return ctx.reply('🟢 El bot está activo y en ejecución.');
  });

  // 3. Registrar módulos de comandos
  registerPanelCommands(bot);
  registerActivarCommand(bot);

  // Manejo de errores a nivel de Telegraf para evitar caídas
  bot.catch((err: any, ctx) => {
    console.error(`[Telegraf Error] Error en actualización ${ctx.update.update_id}:`, err);
  });

  return bot;
}
