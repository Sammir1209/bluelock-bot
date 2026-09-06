import { createBot } from './bot/bot';
import { surfsharkBrowser } from './services/surfsharkBrowser';
import { activationQueue } from './services/queueService';
import { prisma } from './db/prisma';

// Configurar el procesador de activaciones con el Pool Multi-Cuenta de Surfshark
activationQueue.setProcessor(async (code: string) => {
  return surfsharkBrowser.activateCodeWithPool(code);
});

async function main() {
  console.log('🚀 Iniciando Bot de Telegram y servicios...');

  // Conectar con base de datos
  await prisma.$connect();
  console.log('📦 Conexión a base de datos Prisma establecida.');

  const bot = createBot();

  // Mini servidor HTTP para satisfacer el requerimiento de puerto de Render Web Service
  const port = process.env.PORT || 3000;
  const http = await import('http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'Surfshark Bot Running' }));
  });
  server.listen(port, () => {
    console.log(`🌐 Servidor HTTP de salud escuchando en puerto ${port} (Render Web Service).`);
  });

  // Iniciar Telegraf en modo polling
  await bot.launch();
  console.log('🤖 Bot de Telegram en línea y escuchando eventos.');

  // Prevenir caídas ante excepciones no capturadas
  process.on('uncaughtException', (err) => {
    console.error('💥 [uncaughtException]:', err);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 [unhandledRejection] en:', promise, 'motivo:', reason);
  });

  // Cierre limpio de recursos
  const gracefulShutdown = async (signal: string) => {
    console.log(`\n🛑 Recibida señal ${signal}. Cerrando bot y navegador...`);
    bot.stop(signal);
    await surfsharkBrowser.close();
    await prisma.$disconnect();
    console.log('✅ Recursos liberados con éxito. Proceso finalizado.');
    process.exit(0);
  };

  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Error fatal al iniciar la aplicación:', err);
  process.exit(1);
});
