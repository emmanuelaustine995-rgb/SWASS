import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

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
  app.use(json({ limit: '6mb' }));
  app.use(urlencoded({ extended: true, limit: '2mb' }));
  // Always allow the production SWASS frontend. CORS_ORIGINS may add
  // custom domains, but a missing/empty Render variable must not block the app.
  const allowedOrigins = new Set([
    'https://swass-web.onrender.com',
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
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
bootstrap();
