import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { RegistersService } from './registers.service';

@Injectable()
export class RegisterDeviceTokenGuard implements CanActivate {
  constructor(private readonly registersService: RegistersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RegisterTokenRequest>();
    const token = this.extractBearerToken(request.headers?.authorization);

    if (!token) {
      throw new UnauthorizedException('Register token is required');
    }

    request.registerContext =
      await this.registersService.authenticateRegisterToken(token);

    return true;
  }

  private extractBearerToken(authorization: unknown) {
    if (typeof authorization !== 'string') {
      return null;
    }

    const [scheme, token] = authorization.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return null;
    }

    return token.trim();
  }
}

type RegisterTokenRequest = {
  headers?: {
    authorization?: unknown;
  };
  registerContext?: unknown;
};
