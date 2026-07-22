import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

export interface FcmBroadcastResult {
  topic: string;
  sent: boolean;
  messageId?: string;
}

@Injectable()
export class FcmService implements OnModuleInit {
  private readonly logger = new Logger(FcmService.name);
  private app?: admin.app.App;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const projectId = this.config.get<string>('firebase.projectId');
    const clientEmail = this.config.get<string>('firebase.clientEmail');
    const privateKey = this.config.get<string>('firebase.privateKey');

    if (!projectId || !clientEmail || !privateKey) {
      this.logger.warn('Firebase credentials not set — FCM push disabled');
      return;
    }

    this.app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({
          credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
        });
    this.logger.log('Firebase Admin initialized');
  }

  /** ชื่อ FCM topic จาก serial (topic name รับเฉพาะ [a-zA-Z0-9-_.~%]+) */
  private topicFor(serial: string): string {
    return `device_${serial.replace(/[^a-zA-Z0-9-_.~%]/g, '_')}`;
  }

  /**
   * ส่ง push แบบ broadcast ไปยัง FCM topic ของ serial — ยิงครั้งเดียว
   * ทุก client ที่ subscribe topic นั้นได้รับ (ไม่วนส่งราย token/ราย user)
   */
  async pushToSerial(
    serial: string,
    notification: { title: string; body: string },
    data?: Record<string, string>,
  ): Promise<FcmBroadcastResult> {
    const topic = this.topicFor(serial);
    const result: FcmBroadcastResult = { topic, sent: false };

    if (!this.app) {
      this.logger.warn('FCM not initialized — skipping broadcast');
      return result;
    }

    try {
      const messageId = await this.app.messaging().send({ topic, notification, data });
      result.sent = true;
      result.messageId = messageId;
      this.logger.debug(`Broadcast to topic ${topic} (${messageId})`);
    } catch (err) {
      const code = (err as { code?: string })?.code ?? String(err);
      this.logger.error(`FCM broadcast to ${topic} failed: ${code}`);
    }

    return result;
  }
}
