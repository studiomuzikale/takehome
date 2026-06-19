import 'dotenv/config';

export type AppConfig = {
  databaseUrl: string;
  hmacSecret: string;
  port: number;
  logLevel: string;
};

export function loadConfig(): AppConfig {
  return {
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://yeet:yeet@localhost:5432/yeet',
    hmacSecret: process.env.HMAC_SECRET ?? 'test',
    port: Number(process.env.PORT ?? 3000),
    logLevel: process.env.LOG_LEVEL ?? 'info'
  };
}
