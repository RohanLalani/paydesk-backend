import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, raw, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { InputValidationPipe } from './common/input-validation.pipe';

const corsLogger = new Logger('Cors');

function buildAllowedOrigins() {
  const allowedOrigins = new Set<string>([
    'http://localhost:3000',
    'http://tauri.localhost',
    'https://tauri.localhost',
    'tauri://localhost',
  ]);

  const frontendUrl = process.env.FRONTEND_URL?.trim();

  if (frontendUrl) {
    allowedOrigins.add(new URL(frontendUrl).origin);
  }

  for (const value of (process.env.CORS_ALLOWED_ORIGINS ?? '').split(',')) {
    const origin = value.trim();

    if (origin) {
      allowedOrigins.add(origin);
    }
  }

  return allowedOrigins;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(helmet());
  app.use('/billing/webhook', raw({ type: 'application/json' }));
  app.use(json({ limit: '64kb' }));
  app.use(
    urlencoded({
      extended: false,
      limit: '16kb',
      parameterLimit: 50,
    }),
  );
  app.useGlobalPipes(new InputValidationPipe());

  const allowedOrigins = buildAllowedOrigins();

  app.enableCors({
    origin(
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      if (process.env.NODE_ENV !== 'production') {
        corsLogger.warn(`Rejected CORS origin: ${origin}`);
      }

      callback(new Error(`Origin ${origin} is not allowed by CORS`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
