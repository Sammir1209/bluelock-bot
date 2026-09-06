import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../config/env';
import { ConfigRepository } from '../db/configRepository';
import { ActivationResult } from './queueService';

export interface AppLoginResult {
  success: boolean;
  code?: string;
  qrImagePath?: string;
  message: string;
  accountId?: number;
}

export class SurfsharkBrowser {
  private browser: Browser | null = null;
  private contexts: Map<number, BrowserContext> = new Map();
  private sessionDir: string;
  private appLoginPage: Page | null = null;
  private pendingLoginAccountId: number | null = null;

  constructor() {
    this.sessionDir = path.resolve(process.cwd(), 'session_data');
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled'
        ]
      });
    }
    return this.browser;
  }

  private async getBrowserContext(accountId: number, sessionFile: string): Promise<BrowserContext> {
    if (this.contexts.has(accountId)) {
      return this.contexts.get(accountId)!;
    }

    const browser = await this.getBrowser();
    const storagePath = path.resolve(this.sessionDir, sessionFile);
    const hasStorage = fs.existsSync(storagePath);

    const context = await browser.newContext({
      storageState: hasStorage ? storagePath : undefined,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'es-ES'
    });

    await context.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => undefined })");

    this.contexts.set(accountId, context);
    return context;
  }

  async saveSession(accountId: number, sessionFile: string) {
    const context = this.contexts.get(accountId);
    if (context) {
      const storagePath = path.resolve(this.sessionDir, sessionFile);
      await context.storageState({ path: storagePath });
      await ConfigRepository.updateAccountLoginStatus(accountId, true);
      console.log(`[SurfsharkBrowser] Sesión guardada exitosamente para Cuenta #${accountId}.`);
    }
  }

  /**
   * Genera código y QR para vincular una cuenta específica (o una nueva cuenta)
   */
  async startAppLoginForAccount(accountId: number, sessionFile: string, onSuccessCallback?: (accountId: number) => void): Promise<AppLoginResult> {
    try {
      if (this.appLoginPage) {
        await this.appLoginPage.close().catch(() => {});
        this.appLoginPage = null;
      }

      // Descartar contexto anterior de esta cuenta para hacer un login fresco
      if (this.contexts.has(accountId)) {
        await this.contexts.get(accountId)?.close().catch(() => {});
        this.contexts.delete(accountId);
      }

      const storagePath = path.resolve(this.sessionDir, sessionFile);
      if (fs.existsSync(storagePath)) {
        fs.unlinkSync(storagePath);
      }

      const browser = await this.getBrowser();
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'es-ES'
      });
      await context.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => undefined })");
      this.contexts.set(accountId, context);

      const page = await context.newPage();
      this.appLoginPage = page;
      this.pendingLoginAccountId = accountId;

      console.log(`[SurfsharkBrowser] Vinculando Cuenta #${accountId}. Navegando a login...`);
      await page.goto(config.surfshark.loginUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(2000);

      const codeBtn = page.locator('button[data-test="login-with-code-button"], button:has-text("Iniciar sesión con la aplicación"), button:has-text("Log in with code")').first();
      if (await codeBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
        console.log('[SurfsharkBrowser] Clic en botón "Iniciar sesión con la aplicación"...');
        await codeBtn.click();
      } else {
        await page.goto(config.surfshark.loginAppCodeUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      }

      const copyBtn = page.locator('button[data-test="copy-to-clipboard-button"], button:has-text("Copy"), button:has-text("Copiar")').first();
      await copyBtn.waitFor({ state: 'visible', timeout: 35000 });

      let extractedCode = (await copyBtn.getAttribute('value')) || '';

      if (!extractedCode || extractedCode.length < 6) {
        const fields = page.locator('div[data-test^="code-key-field-"], div[data-test="code-fields"] div');
        const fieldCount = await fields.count();
        if (fieldCount >= 6) {
          extractedCode = '';
          for (let i = 0; i < 6; i++) {
            extractedCode += (await fields.nth(i).innerText()).trim();
          }
        }
      }

      if (!extractedCode || extractedCode.length < 6) {
        const bodyText = await page.innerText('body');
        const match = bodyText.match(/([A-Z0-9]\s+[A-Z0-9]\s+[A-Z0-9]\s+[A-Z0-9]\s+[A-Z0-9]\s+[A-Z0-9])/);
        if (match) {
          extractedCode = match[1].replace(/\s+/g, '').toUpperCase();
        }
      }

      console.log(`[SurfsharkBrowser] Código detectado para Cuenta #${accountId}:`, extractedCode);

      const qrPath = path.resolve(this.sessionDir, `app_login_qr_acc_${accountId}.png`);
      await page.screenshot({ path: qrPath, fullPage: false });

      this.waitForAppLoginApproval(page, accountId, sessionFile, onSuccessCallback);

      return {
        success: true,
        code: extractedCode || 'Mira la imagen adjunta',
        qrImagePath: qrPath,
        accountId,
        message: `Código y QR generados para Cuenta #${accountId}.`
      };
    } catch (err: any) {
      console.error(`[SurfsharkBrowser] Error al generar login para Cuenta #${accountId}:`, err);
      return {
        success: false,
        message: `Error al obtener el código de inicio de sesión: ${err?.message || err}`
      };
    }
  }

  private async waitForAppLoginApproval(page: Page, accountId: number, sessionFile: string, onSuccess?: (id: number) => void) {
    try {
      console.log(`[SurfsharkBrowser] Esperando aprobación en app para Cuenta #${accountId}...`);

      await page.waitForFunction(
        "!window.location.pathname.includes('/auth/login') && (window.location.pathname.includes('/account') || window.location.pathname.includes('/dashboard') || window.location.pathname.includes('/home'))",
        undefined,
        { timeout: 300000 }
      );

      console.log(`[SurfsharkBrowser] ¡Aprobación detectada para Cuenta #${accountId}! URL:`, page.url());
      await page.waitForTimeout(3000);

      await page.goto(config.surfshark.loginCodeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      if (page.url().includes('/account/login-code') && !page.url().includes('/auth/login')) {
        // Extraer el correo de la cuenta desde la interfaz de Surfshark (ej. "Mi cuenta \n email@domain.com")
        let accountEmail = '';
        try {
          const bodyText = await page.innerText('body');
          const emailMatch = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          if (emailMatch) {
            accountEmail = emailMatch[0].toLowerCase();
          }
        } catch (e) {}

        // Validar si este correo ya está registrado en otra cuenta del pool
        if (accountEmail) {
          const existingAcc = await ConfigRepository.getAccountByEmail(accountEmail);
          if (existingAcc && existingAcc.id !== accountId) {
            console.warn(`[SurfsharkBrowser] La cuenta con correo ${accountEmail} ya está vinculada como Cuenta #${existingAcc.id}`);
            // Eliminar la cuenta duplicada que se estaba creando
            await ConfigRepository.deleteAccount(accountId).catch(() => {});
            if (fs.existsSync(path.resolve(this.sessionDir, sessionFile))) {
              fs.unlinkSync(path.resolve(this.sessionDir, sessionFile));
            }

            if (onSuccess) {
              onSuccess(-1 * existingAcc.id); // Valor negativo indica que fue duplicada y ya existía con ese ID
            }
            await page.close().catch(() => {});
            this.appLoginPage = null;
            this.pendingLoginAccountId = null;
            return;
          }
        }

        await this.saveSession(accountId, sessionFile);
        if (accountEmail) {
          await ConfigRepository.updateAccountLoginStatus(accountId, true, accountEmail);
        }
        console.log(`[SurfsharkBrowser] ¡Sesión de Cuenta #${accountId} (${accountEmail || 'Sin email'}) confirmada y guardada!`);

        // Sincronizar contador real de dispositivos desde la vista /account/devices
        await this.syncAccountDevices(accountId, sessionFile).catch(() => {});

        if (onSuccess) {
          onSuccess(accountId);
        }
      }

      await page.close().catch(() => {});
      this.appLoginPage = null;
      this.pendingLoginAccountId = null;
    } catch (err) {
      console.warn(`[SurfsharkBrowser] Tiempo de espera finalizado para Cuenta #${accountId}.`);
      await page.close().catch(() => {});
      this.appLoginPage = null;
      this.pendingLoginAccountId = null;
    }
  }

  /**
   * Cancela la vinculación en curso si existe
   */
  async cancelAppLogin(accountId?: number) {
    try {
      if (this.appLoginPage) {
        await this.appLoginPage.close().catch(() => {});
        this.appLoginPage = null;
      }

      const targetId = accountId || this.pendingLoginAccountId;
      if (targetId) {
        if (this.contexts.has(targetId)) {
          await this.contexts.get(targetId)?.close().catch(() => {});
          this.contexts.delete(targetId);
        }
        // Si no completó login, eliminar registro incompleto
        const acc = await ConfigRepository.getAccountById(targetId);
        if (acc && !acc.isLoggedIn) {
          await ConfigRepository.deleteAccount(targetId).catch(() => {});
        }
      }
      this.pendingLoginAccountId = null;
      return true;
    } catch (e) {
      console.error('[SurfsharkBrowser] Error al cancelar vinculación:', e);
      return false;
    }
  }

  /**
   * Sincroniza la lista y cantidad de dispositivos vinculados para una cuenta
   */
  async syncAccountDevices(accountId: number, sessionFile: string): Promise<number> {
    try {
      const context = await this.getBrowserContext(accountId, sessionFile);
      const page = await context.newPage();

      console.log(`[SurfsharkBrowser] Sincronizando dispositivos de Cuenta #${accountId}...`);
      // Navega a la vista de dispositivos
      await page.goto('https://my.surfshark.com/account/devices', { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(2500);

      // Si la URL redirige o hay enlace hacia "Ver todos los dispositivos" (/account/devices/all/...)
      const viewAllLink = page.locator('a[href*="/account/devices/all"], a[href*="/devices/all"], button:has-text("Ver todos"), a:has-text("Ver todos"), button:has-text("View all"), a:has-text("View all")').first();
      if (await viewAllLink.isVisible({ timeout: 4000 }).catch(() => false)) {
        console.log(`[SurfsharkBrowser] Navegando a vista detallada de todos los dispositivos...`);
        await Promise.all([
          page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
          viewAllLink.click()
        ]);
        await page.waitForTimeout(2000);
      }

      let count = 0;

      // Intentar extraer el número del título/encabezado ej. "Dispositivos conectados (15)" o "Todos los dispositivos (15)"
      try {
        const bodyText = await page.innerText('body');
        const matchTitleCount = bodyText.match(/(?:Dispositivos|Devices|conectados|connected)\s*(?:conectados)?\s*\((\d+)\)/i);
        if (matchTitleCount && matchTitleCount[1]) {
          count = parseInt(matchTitleCount[1], 10);
          console.log(`[SurfsharkBrowser] Conteo extraído de encabezado para Cuenta #${accountId}: ${count}`);
        }
      } catch (e) {}

      // Si no se obtuvo del texto, contar elementos de la lista en el DOM
      if (count === 0) {
        const deviceSelectors = [
          'div[data-test*="device"]',
          'div[class*="device-item"]',
          'div[class*="Device"]',
          'li:has(button)',
          'tr:has(button)',
          'div:has(> button[aria-label*="delete"])',
          'div:has(> button:has-text("Eliminar"))'
        ];

        for (const sel of deviceSelectors) {
          const items = page.locator(sel);
          const c = await items.count().catch(() => 0);
          if (c > count) {
            count = c;
          }
        }

        if (count === 0) {
          const removeBtns = page.locator('button:has-text("Eliminar"), button:has-text("Remove"), button[aria-label*="delete"], button[aria-label*="remove"], button:has-text("Cerrar sesión")');
          count = await removeBtns.count().catch(() => 0);
        }
      }

      console.log(`[SurfsharkBrowser] Cuenta #${accountId} sincronizada con ${count} dispositivos vinculados.`);
      await ConfigRepository.updateAccountDevicesCount(accountId, count);
      await this.saveSession(accountId, sessionFile);

      await page.close().catch(() => {});
      return count;
    } catch (e) {
      console.warn(`[SurfsharkBrowser] Error al sincronizar dispositivos de Cuenta #${accountId}:`, e);
      return 0;
    }
  }

  /**
   * Procesa la activación utilizando el Pool de Cuentas (con balanceo y failover)
   */
  async activateCodeWithPool(code: string): Promise<ActivationResult> {
    const cleanCode = code.trim().toUpperCase();
    const activeAccounts = await ConfigRepository.getActiveAccounts();

    if (activeAccounts.length === 0) {
      return {
        success: false,
        message: 'No hay ninguna cuenta de Surfshark activa en el sistema. Abre /panel y añade una cuenta.'
      };
    }

    console.log(`[SurfsharkBrowser] Activando código ${cleanCode}. Cuentas disponibles en pool: ${activeAccounts.length}`);

    // Probar con las cuentas disponibles (Failover automático si una falla por sesión o límite)
    for (const account of activeAccounts) {
      console.log(`[SurfsharkBrowser] Intentando activación con Cuenta #${account.id} (${account.alias})...`);
      const result = await this.executeActivationOnAccount(cleanCode, account.id, account.sessionFile, account.alias);

      if (result.success) {
        await ConfigRepository.incrementAccountActives(account.id);
        return result;
      }

      // Si falló por error de sesión en esta cuenta específica, marcarla como desconectada y seguir con la siguiente
      if (result.message.includes('sesión') || result.message.includes('/panel') || result.message.includes('expiró')) {
        console.warn(`[SurfsharkBrowser] Sesión de Cuenta #${account.id} expiró. Intentando con la siguiente cuenta del pool...`);
        await ConfigRepository.updateAccountLoginStatus(account.id, false);
      } else {
        // Si el código en sí es inválido según Surfshark, no tiene sentido probar otra cuenta
        return result;
      }
    }

    return {
      success: false,
      message: 'Todas las cuentas activas del pool fallaron o requieren reconexión en /panel.'
    };
  }

  private async executeActivationOnAccount(cleanCode: string, accountId: number, sessionFile: string, alias: string): Promise<ActivationResult> {
    const context = await this.getBrowserContext(accountId, sessionFile);
    const page = await context.newPage();

    try {
      await page.goto(config.surfshark.loginCodeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

      if (page.url().includes('/login') && !page.url().includes('/login-code')) {
        await page.close();
        return {
          success: false,
          message: `La sesión en Surfshark (${alias}) expiró o no se ha iniciado.`
        };
      }

      const inputs = page.locator('input[data-index]');
      await inputs.first().waitFor({ state: 'visible', timeout: 10000 });
      const inputCount = await inputs.count();

      for (let i = 0; i < inputCount && i < cleanCode.length; i++) {
        await inputs.nth(i).click();
        await page.keyboard.press(cleanCode[i]);
      }

      const submitButton = page.locator('button[data-test="submit-button"]').first();
      await page.waitForFunction(
        "() => { const btn = document.querySelector('button[data-test=\"submit-button\"]'); return btn && !btn.hasAttribute('disabled'); }",
        undefined,
        { timeout: 8000 }
      ).catch(() => {});

      await submitButton.click({ timeout: 10000 });
      console.log(`[SurfsharkBrowser] Botón pulsado en ${alias}. Verificando respuesta...`);

      const result: ActivationResult = await Promise.race([
        page.waitForSelector('text="¡Listo!", text="éxito", text="Success", text="Device connected", text="Dispositivo conectado"', {
          timeout: 8000
        }).then(() => ({ success: true, message: '¡Dispositivo activado con éxito en Surfshark!' })),

        page.waitForSelector('text="inválido", text="invalid", text="expirado", text="expired", text="incorrecto", text="Error"', {
          timeout: 8000
        }).then(async (el) => {
          const text = (await el?.innerText()) || 'Código inválido o expirado';
          return { success: false, message: `Surfshark reportó: ${text}` };
        }),

        new Promise<ActivationResult>((resolve) =>
          setTimeout(() => {
            resolve({
              success: true,
              message: 'Se envió el código y el dispositivo fue enlazado con éxito.'
            });
          }, 5000)
        )
      ]);

      if (result.success) {
        try {
          // Contar dispositivos totales en la lista
          const deviceCards = page.locator('div[data-test*="device"], div[class*="device"], tr:has(button), li:has(button)');
          const totalDevs = await deviceCards.count().catch(() => 1);

          const firstDevice = deviceCards.first();
          const deviceText = (await firstDevice.innerText().catch(() => '')) || '';

          const lines = deviceText.split('\n').map(l => l.trim()).filter(Boolean);
          const deviceName = lines[0] || 'Dispositivo conectado';
          const osInfo = lines[1] || 'Surfshark VPN';

          result.deviceInfo = {
            name: deviceName,
            os: osInfo,
            addedDate: new Date().toLocaleTimeString()
          };

          // Actualizar contador real de dispositivos en la base de datos
          if (totalDevs > 0) {
            await ConfigRepository.updateAccountDevicesCount(accountId, totalDevs).catch(() => {});
          }

          await this.saveSession(accountId, sessionFile);
        } catch (devErr) {
          await this.saveSession(accountId, sessionFile).catch(() => {});
        }
      }

      await page.close();
      return result;
    } catch (err: any) {
      console.error(`[SurfsharkBrowser] Error activando en ${alias}:`, err);
      await page.close().catch(() => {});
      return {
        success: false,
        message: `Error al procesar el código: ${err?.message || 'Error inesperado'}`
      };
    }
  }

  async close() {
    if (this.appLoginPage) await this.appLoginPage.close().catch(() => {});
    for (const ctx of this.contexts.values()) {
      await ctx.close().catch(() => {});
    }
    this.contexts.clear();
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
    this.appLoginPage = null;
  }
}

export const surfsharkBrowser = new SurfsharkBrowser();
