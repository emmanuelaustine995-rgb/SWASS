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
  app.use(json({ limit: '256kb' }));
  app.use(urlencoded({ extended: true, limit: '256kb' }));
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? '').split(',').map((v: string) => v.trim()).filter(Boolean),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  app.use((_req: any, res: any, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
bootstrap();
