import { prisma } from './prisma';

export interface ChatConfigData {
  chatId: string;
  topicId?: string | null;
  isActive?: boolean;
  description?: string | null;
}

export class ConfigRepository {
  private static cache: Map<string, { topicId: string | null; isActive: boolean }> = new Map();
  private static cacheLoaded = false;

  private static async ensureLoaded() {
    if (this.cacheLoaded) return;
    try {
      const configs = await prisma.vpnChatConfig.findMany();
      this.cache.clear();
      for (const c of configs) {
        this.cache.set(c.chatId, { topicId: c.topicId, isActive: c.isActive });
      }
      this.cacheLoaded = true;
    } catch (err) {
      console.error('[ConfigRepository] Error al cargar caché inicial:', err);
    }
  }

  static async isChatAllowed(chatId: string | number, topicId?: number | null): Promise<boolean> {
    await this.ensureLoaded();
    const cId = chatId.toString();
    const config = this.cache.get(cId);

    if (!config || !config.isActive) {
      return false;
    }

    if (config.topicId) {
      if (!topicId) return false;
      return config.topicId === topicId.toString();
    }

    return true;
  }

  static async setChatConfig(data: ChatConfigData) {
    const record = await prisma.vpnChatConfig.upsert({
      where: { chatId: data.chatId },
      update: {
        topicId: data.topicId ?? null,
        isActive: data.isActive ?? true,
        description: data.description
      },
      create: {
        chatId: data.chatId,
        topicId: data.topicId ?? null,
        isActive: data.isActive ?? true,
        description: data.description
      }
    });

    this.cache.set(record.chatId, { topicId: record.topicId, isActive: record.isActive });
    return record;
  }

  static async getActiveConfig() {
    return prisma.vpnChatConfig.findFirst({ where: { isActive: true } });
  }

  // ==========================================
  // GESTIÓN MULTI-CUENTA SURFSHARK
  // ==========================================

  static async getAllAccounts() {
    return prisma.surfsharkAccount.findMany({
      orderBy: { id: 'asc' }
    });
  }

  static async getActiveAccounts() {
    return prisma.surfsharkAccount.findMany({
      where: { isActive: true, isLoggedIn: true },
      orderBy: { totalActives: 'asc' } // Prioriza la cuenta con menos activaciones (balanceo)
    });
  }

  static async getAccountById(id: number) {
    return prisma.surfsharkAccount.findUnique({ where: { id } });
  }

  static async getAccountByEmail(email: string) {
    return prisma.surfsharkAccount.findFirst({
      where: { email: email.trim().toLowerCase() }
    });
  }

  static async createNewAccount(alias?: string) {
    const count = await prisma.surfsharkAccount.count();
    const accountAlias = alias || `Cuenta #${count + 1}`;
    const sessionFile = `storageState_account_${count + 1}.json`;

    return prisma.surfsharkAccount.create({
      data: {
        alias: accountAlias,
        sessionFile,
        isActive: true,
        isLoggedIn: false
      }
    });
  }

  static async updateAccountLoginStatus(id: number, isLoggedIn: boolean, email?: string) {
    return prisma.surfsharkAccount.update({
      where: { id },
      data: {
        isLoggedIn,
        email: email || undefined,
        lastUsed: isLoggedIn ? new Date() : undefined
      }
    });
  }

  static async updateAccountDevicesCount(id: number, devicesCount: number) {
    return prisma.surfsharkAccount.update({
      where: { id },
      data: { devicesCount }
    });
  }

  static async incrementAccountActives(id: number) {
    return prisma.surfsharkAccount.update({
      where: { id },
      data: {
        totalActives: { increment: 1 },
        devicesCount: { increment: 1 },
        lastUsed: new Date()
      }
    });
  }

  static async toggleAccountActive(id: number) {
    const acc = await this.getAccountById(id);
    if (!acc) return null;
    return prisma.surfsharkAccount.update({
      where: { id },
      data: { isActive: !acc.isActive }
    });
  }

  static async deleteAccount(id: number) {
    return prisma.surfsharkAccount.delete({ where: { id } });
  }
}
