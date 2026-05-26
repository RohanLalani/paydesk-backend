import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';

@Injectable()
export class InputValidationPipe implements PipeTransform {
  private readonly maxBodyDepth = 6;
  private readonly maxBodyKeys = 100;
  private readonly maxArrayLength = 100;
  private readonly maxStringLength = 2_000;
  private readonly maxParamLength = 200;
  private readonly blockedKeys = new Set([
    '__proto__',
    'constructor',
    'prototype',
  ]);
  private readonly scriptPattern =
    /<\s*script\b|<\/\s*script\s*>|javascript\s*:|data\s*:\s*text\/html|on[a-z]+\s*=/i;

  transform(value: unknown, metadata: ArgumentMetadata) {
    if (value === undefined || value === null) {
      return value;
    }

    if (metadata.type === 'body' || metadata.type === 'query') {
      this.validateValue(value, metadata.type, 0, { keyCount: 0 });
      return value;
    }

    if (metadata.type === 'param') {
      this.validateParam(value, metadata.data ?? 'parameter');
    }

    return value;
  }

  private validateValue(
    value: unknown,
    path: string,
    depth: number,
    state: { keyCount: number },
  ) {
    if (depth > this.maxBodyDepth) {
      throw new BadRequestException(`${path} is too deeply nested`);
    }

    if (typeof value === 'string') {
      this.validateString(value, path, this.maxStringLength);
      return;
    }

    if (
      typeof value === 'number' &&
      (!Number.isFinite(value) || Number.isNaN(value))
    ) {
      throw new BadRequestException(`${path} must be a finite number`);
    }

    if (Array.isArray(value)) {
      if (value.length > this.maxArrayLength) {
        throw new BadRequestException(`${path} has too many items`);
      }

      value.forEach((item, index) =>
        this.validateValue(item, `${path}[${index}]`, depth + 1, state),
      );
      return;
    }

    if (this.isPlainObject(value)) {
      const entries = Object.entries(value);
      state.keyCount += entries.length;

      if (state.keyCount > this.maxBodyKeys) {
        throw new BadRequestException('Request payload has too many fields');
      }

      for (const [key, item] of entries) {
        if (this.blockedKeys.has(key)) {
          throw new BadRequestException(`${path} contains a blocked field`);
        }

        this.validateString(key, `${path} field name`, this.maxParamLength);
        this.validateValue(item, `${path}.${key}`, depth + 1, state);
      }
      return;
    }

    if (
      typeof value !== 'boolean' &&
      typeof value !== 'number' &&
      value !== null
    ) {
      throw new BadRequestException(`${path} contains unsupported input`);
    }
  }

  private validateParam(value: unknown, field: string) {
    if (typeof value !== 'string') {
      return;
    }

    this.validateString(value, field, this.maxParamLength);
  }

  private validateString(value: string, field: string, maxLength: number) {
    if (value.length > maxLength) {
      throw new BadRequestException(`${field} is too long`);
    }

    if (this.scriptPattern.test(value)) {
      throw new BadRequestException(`${field} contains unsafe script content`);
    }
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    return prototype === Object.prototype || prototype === null;
  }
}
