import { NestFactory } from '@nestjs/core';
import { json, raw, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { InputValidationPipe } from './common/input-validation.pipe';

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

  if (process.env.FRONTEND_URL) {
    app.enableCors({
      origin: new URL(process.env.FRONTEND_URL).origin,
      credentials: true,
    });
  }

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
