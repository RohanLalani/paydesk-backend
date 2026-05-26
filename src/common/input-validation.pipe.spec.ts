import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { InputValidationPipe } from './input-validation.pipe';

describe('InputValidationPipe', () => {
  const pipe = new InputValidationPipe();
  const bodyMetadata: ArgumentMetadata = {
    type: 'body',
    metatype: undefined,
    data: undefined,
  };

  it('allows normal request bodies', () => {
    const body = {
      name: 'Main Store',
      active: true,
      count: 2,
      tags: ['retail'],
    };

    expect(pipe.transform(body, bodyMetadata)).toBe(body);
  });

  it('rejects script-like string input', () => {
    expect(() =>
      pipe.transform({ name: '<script>alert(1)</script>' }, bodyMetadata),
    ).toThrow(BadRequestException);
  });

  it('rejects oversized arrays', () => {
    expect(() =>
      pipe.transform({ ids: new Array(101).fill('id') }, bodyMetadata),
    ).toThrow(BadRequestException);
  });

  it('rejects prototype pollution keys', () => {
    expect(() =>
      pipe.transform({ constructor: 'polluted' }, bodyMetadata),
    ).toThrow(BadRequestException);
  });
});
