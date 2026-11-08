import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';
import { RestoreInProgressException } from '../exceptions/restore-in-progress.exception';

function makeHost() {
  const response = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'GET', url: '/graph/x' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('HttpExceptionFilter', () => {
  it('RestoreInProgressException: 202 + Retry-After และ success=true (ไม่ใช่ error)', () => {
    const { host, response } = makeHost();

    new HttpExceptionFilter().catch(new RestoreInProgressException(5), host);

    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(response.status).toHaveBeenCalledWith(202);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: null, retryAfterSeconds: 5, statusCode: 202 }),
    );
  });

  it('HttpException อื่นยังคงเป็น error response เหมือนเดิม', () => {
    const { host, response } = makeHost();

    new HttpExceptionFilter().catch(new BadRequestException('bad'), host);

    expect(response.setHeader).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });
});
