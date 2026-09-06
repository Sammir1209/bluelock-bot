import dotenv from 'dotenv';
dotenv.config();

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (!value) {
    throw new Error(`Variable de entorno requerida no encontrada: ${key}`);
  }
  return value;
}

export const config = {
  botToken: getEnv('BOT_TOKEN'),
  ownerIds: (process.env.OWNER_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean),
  databaseUrl: getEnv('DATABASE_URL', 'file:./dev.db'),
  surfshark: {
    loginUrl: 'https://my.surfshark.com/auth/login',
    loginAppCodeUrl: 'https://my.surfshark.com/auth/login/code',
    loginCodeUrl: 'https://my.surfshark.com/account/login-code'
  }
};
