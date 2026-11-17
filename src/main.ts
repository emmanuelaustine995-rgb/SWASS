import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { DbService } from './db/db.service';

async function bootstrap() {
  for (const key of ['DATABASE_URL', 'JWT_SECRET', 'SWASS_ID_SECRET']) {
    if (!process.env[key]) throw new Error(`${key} must be set`);
  }
  if (process.env.JWT_SECRET!.length < 32) {
    throw new Error('JWT_SECRET must contain at least 32 characters');
  }
  if (process.env.SWASS_ID_SECRET!.length < 32) {
    throw new Error('SWASS_ID_SECRET must contain at least 32 characters');
  }

  const app = await NestFactory.create(AppModule, { bodyParser: false });
  // Render terminates HTTPS and forwards the original client address through one trusted proxy.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  // Two compressed identity photos can be sent with the owner signup JSON payload.
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '2mb' }));
  // Always allow the production SWASS frontend. CORS_ORIGINS may add
  // custom domains, but a missing/empty Render variable must not block the app.
  const allowedOrigins = new Set([
    'https://swass-web.onrender.com',
    'https://auroraskyholdings.co.ke',
    'https://www.auroraskyholdings.co.ke',
    ...((process.env.CORS_ORIGINS ?? '').split(',').map((v: string) => v.trim()).filter(Boolean)),
  ]);
  if (process.env.NODE_ENV !== 'production') {
    allowedOrigins.add('http://localhost:3000');
    allowedOrigins.add('http://127.0.0.1:3000');
  }
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allowed?: boolean) => void) => {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Recovery-Token'],
  });
  app.use((_req: any, res: any, next: () => void) => {
    // Baseline browser security headers. Render terminates HTTPS before this app.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()');
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  // Platform-wide maintenance gate. The state is cached briefly to avoid a database
  // read on every request; Super Admin and health routes remain reachable.
  const operationsDb = app.get(DbService);
  await operationsDb.ensureOperationsSchema();
  let maintenanceCache: { enabled: boolean; title: string; message: string; expiresAt: number } = { enabled: false, title: 'Scheduled maintenance', message: '', expiresAt: 0 };
  app.use(async (req: any, res: any, next: () => void) => {
    const path = String(req.path || req.url || '').split('?')[0];
    if (!path.startsWith('/api/v1/') || path.startsWith('/api/v1/platform-admin/') || path.startsWith('/api/v1/auth/admin/') || path === '/api/v1/health' || path === '/api/v1/health/maintenance') return next();
    try {
      if (Date.now() >= maintenanceCache.expiresAt) {
        const result = await operationsDb.pool.query('SELECT maintenance_enabled AS enabled, maintenance_title AS title, maintenance_message AS message FROM aurora_platform_operations WHERE id=1');
        const row = result.rows[0] || {};
        maintenanceCache = { enabled: row.enabled === true, title: row.title || 'Scheduled maintenance', message: row.message || 'AURORA is temporarily unavailable while we improve our services. Please try again shortly.', expiresAt: Date.now() + 5000 };
      }
      if (maintenanceCache.enabled) return res.status(503).set('Retry-After','300').json({ status: 'maintenance', maintenance: true, title: maintenanceCache.title, message: maintenanceCache.message, retryAfterSeconds: 300 });
      return next();
    } catch (error) {
      // Fail closed only if the maintenance state cannot be checked; never silently bypass the gate.
      return res.status(503).json({ status: 'temporarily_unavailable', message: 'AURORA is temporarily unable to verify service status. Please try again shortly.' });
    }
  });
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
bootstrap();
