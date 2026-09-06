export interface ActivationResult {
  success: boolean;
  message: string;
  screenshotPath?: string;
  deviceInfo?: {
    name?: string;
    os?: string;
    addedDate?: string;
  };
}

export interface ActivationTask {
  code: string;
  userId: number;
  userName?: string;
  resolve: (result: ActivationResult) => void;
  reject: (err: any) => void;
}

export class ActivationQueue {
  private queue: ActivationTask[] = [];
  private isProcessing = false;
  private processor: ((code: string) => Promise<ActivationResult>) | null = null;

  setProcessor(fn: (code: string) => Promise<ActivationResult>) {
    this.processor = fn;
  }

  async enqueue(code: string, userId: number, userName?: string): Promise<ActivationResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ code, userId, userName, resolve, reject });
      this.processNext();
    });
  }

  private async processNext() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    if (!this.processor) {
      const task = this.queue.shift();
      task?.reject(new Error('Procesador de activación no configurado'));
      return;
    }

    this.isProcessing = true;
    const currentTask = this.queue.shift()!;

    try {
      console.log(`[Queue] Procesando código: ${currentTask.code} para usuario: ${currentTask.userName || currentTask.userId}`);
      const result = await this.processor(currentTask.code);
      currentTask.resolve(result);
    } catch (error: any) {
      console.error(`[Queue] Error procesando código ${currentTask.code}:`, error);
      currentTask.resolve({
        success: false,
        message: `Error interno al procesar el código: ${error?.message || 'Fallo desconocido'}`
      });
    } finally {
      this.isProcessing = false;
      // Procesa el siguiente de la cola si hay
      if (this.queue.length > 0) {
        setTimeout(() => this.processNext(), 1500);
      }
    }
  }

  getQueueLength(): number {
    return this.queue.length + (this.isProcessing ? 1 : 0);
  }
}

export const activationQueue = new ActivationQueue();
