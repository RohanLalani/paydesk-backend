import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, raw, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { InputValidationPipe } from './common/input-validation.pipe';

const corsLogger = new Logger('Cors');

function normalizeOrigin(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');

  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed;
  }
}

function addConfiguredOrigins(
  allowedOrigins: Set<string>,
  value: string | undefined,
) {
  for (const entry of (value ?? '').split(',')) {
    const origin = normalizeOrigin(entry);

    if (origin) {
      allowedOrigins.add(origin);
    }
  }
}

function buildAllowedOrigins() {
  const allowedOrigins = new Set<string>([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://backoffice.paydeskapp.com',
    'http://tauri.localhost',
    'https://tauri.localhost',
    'tauri://localhost',
  ]);

  addConfiguredOrigins(allowedOrigins, process.env.FRONTEND_URL);
  addConfiguredOrigins(allowedOrigins, process.env.BACKOFFICE_FRONTEND_URL);
  addConfiguredOrigins(allowedOrigins, process.env.CORS_ORIGINS);
  addConfiguredOrigins(allowedOrigins, process.env.CORS_ALLOWED_ORIGINS);

  return [...allowedOrigins].sort();
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
  corsLogger.log(
    `Configured CORS origins: ${allowedOrigins.length ? allowedOrigins.join(', ') : '(none)'}`,
  );

  app.enableCors({
    origin(
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) {
      const normalizedOrigin = origin ? normalizeOrigin(origin) : null;

      if (!normalizedOrigin || allowedOrigins.includes(normalizedOrigin)) {
        callback(null, true);
        return;
      }

      if (process.env.NODE_ENV !== 'production') {
        corsLogger.warn(`Rejected CORS origin: ${normalizedOrigin}`);
      }

      callback(
        new Error(`Origin ${normalizedOrigin} is not allowed by CORS`),
        false,
      );
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
