import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { API_PREFIX, createTestApp } from './utils/create-test-app';

describe('App (e2e) — smoke', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  it('บูต AppModule ได้ครบทุกโมดูลโดยไม่ error', () => {
    expect(app).toBeDefined();
  });

  // health ใช้ @SkipInterceptor() จึงไม่ถูกห่อด้วย envelope — body คือผลของ terminus ตรง ๆ
  it('GET /health ตอบ 200 และรายงานว่า database ต่อได้', async () => {
    const res = await request(app.getHttpServer()).get(`${API_PREFIX}/health`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
