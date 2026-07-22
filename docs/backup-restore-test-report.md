# รายงานผลทดสอบระบบ Backup / Restore

**วันที่ทดสอบ:** 2026-07-19
**สภาพแวดล้อม:** docker compose (local), Docker Engine 29.2.1
**ผลรวม: ผ่าน 42 / 42 เคส**

| องค์ประกอบ | เวอร์ชัน |
|---|---|
| TimescaleDB | `timescale/timescaledb:latest-pg17` |
| MinIO | `minio/minio:RELEASE.2025-04-22T22-12-26Z` |
| app | build จาก `Dockerfile` target `runner`, `NODE_ENV=production` |
| ARCHIVE_RETENTION_MONTHS | 6 |

วิธีรันซ้ำ:

```bash
docker compose up -d --build
bash scripts/test-backup.sh          # exit 0 = ผ่านทุกเคส
```

---

## 1. สิ่งที่ต้องแก้ก่อนถึงจะทดสอบได้

ระบบ backup **ไม่เคยถูกทดสอบกับ object storage จริงมาก่อน** — e2e ทุกตัว mock `ObjectStorageService` ทิ้ง (`test/utils/create-test-app.ts:80`) และ `docker-compose.yml` ไม่มี object storage service เลย ทั้งยังไม่ตั้ง `ARCHIVE_S3_*` ใน `x-app-env`

**ผลคือบน Docker profile เดิม S3 client ถูกสร้างด้วย credential ว่าง และ cron `0 3 1 * *` รอบแรกจะพังแน่นอน** — ไม่ใช่ปัญหาที่จะเห็นจากการรันเทสชุดเดิม เพราะไม่มีเทสไหนแตะ S3 จริง

จึงเพิ่ม:

- service `minio` + one-shot `minio-init` (สร้าง bucket `smtrack-log-archive`) ใน `docker-compose.yml`
- `ARCHIVE_S3_*` ครบชุดใน `x-app-env` และ `.env.docker.example`
- `app.depends_on` รอ `minio-init` เสร็จก่อน start

---

## 2. วิธีจำลองเวลา

`restoreMonth` บล็อกเดือนที่ยังอยู่ใน retention window (`archive-restore.service.ts:91-99`) ขณะที่ TimescaleDB มี `add_retention_policy('"LogDays"', INTERVAL '6 months')` คอย drop chunk เก่าทิ้ง — สองอย่างนี้ทำให้ทดสอบรอบเต็ม export → restore ตรง ๆ ไม่ได้ เพราะข้อมูลที่ export ได้จะยัง restore ไม่ได้ และข้อมูลที่ restore ได้จะถูก drop ไปแล้ว

สคริปต์จึงจำลองแทน โดย **ไม่แตะนาฬิกา container** (ซึ่งจะกระทบ JWT/OTel/service อื่นทั้งสแตก):

1. `remove_retention_policy('"LogDays"')` ชั่วคราว
2. seed 5,000 แถวในเดือน M-7 (2025-12)
3. export ผ่าน REST
4. `DELETE FROM "LogDays"` เองเพื่อจำลอง chunk drop
5. restore แล้วตรวจข้อมูล
6. คืน retention policy กลับ (ผ่าน `trap EXIT` — คืนแม้สคริปต์ล้มกลางคัน)

---

## 3. ผลรายเคส

### Export (เคส 3-6)

| # | เคส | ผล | หลักฐาน |
|---|---|---|---|
| 3 | `POST /backup/exports/2025-12` | ✅ | HTTP 201 |
| 3 | rowCount ตรงกับที่ seed | ✅ | 5000 = 5000 |
| 3 | คืน sha256 | ✅ | `fbd40c6bebe7d132…` |
| 4 | มีไฟล์ `.csv.gz` บน storage | ✅ | `log-days/2025/12/log-days-2025-12.csv.gz`, 169,429 bytes |
| 4 | `meta.json` rowCount ตรง | ✅ | 5000 |
| 5 | gzip แตกได้ + จำนวนบรรทัดถูก | ✅ | 5,001 บรรทัด (รวม header) |
| 6 | `ArchiveExport` มีแถวของเดือนนั้น | ✅ | 1 แถว |

### Restore (เคส 7-11)

| # | เคส | ผล | หลักฐาน |
|---|---|---|---|
| 7 | จำลอง retention drop | ✅ | `LogDaysAll` เหลือ 0 แถว |
| 8 | `POST /backup/restores/2025-12` | ✅ | HTTP 201, rowCount 5000 |
| 9 | **count ตรง** | ✅ | 5000 |
| 9 | **sum(temp) ตรง** | ✅ | 97770.0000 = 97770.0000 |
| 9 | **min/max(sendTime) ตรง** | ✅ | ขอบเขตเวลาตรงทั้งสองด้าน |
| 10 | view `LogDaysAll` คืนครบ ไม่ซ้ำ | ✅ | 5000 |
| 11 | `GET /backup/months` | ✅ | เดือน 2025-12 `restored: true` |

เคส 9 เทียบมากกว่าจำนวนแถว — เทียบ `sum(temp)` และขอบเขตเวลาด้วย เพราะ restore ที่ "จำนวนแถวตรง" ยังอาจได้ค่าเพี้ยนจาก CSV escaping หรือลำดับคอลัมน์สลับ

### Guard (เคส 12-15)

| # | เคส | คาดหวัง | ได้ | ผล |
|---|---|---|---|---|
| 12 | restore ซ้ำ | 409 | 409 | ✅ |
| 13 | restore เดือนปัจจุบัน (ใน retention window) | 400 | 400 | ✅ |
| 14 | restore เดือนที่ไม่มี backup (2020-01) | 404 | 404 | ✅ |
| 15 | เดือน 13 (`2020-13`) | 400 | 400 | ✅ |
| 15 | รูปแบบผิด (`abc`) | 400 | 400 | ✅ |

### Rollback — เคสสำคัญที่สุด (เคส 16)

unit test ของ restore mock `pg.Pool` ไว้ทั้งก้อน จึง**พิสูจน์ไม่ได้ว่า `ROLLBACK` จริงทำงาน** เคสนี้จึงจงใจทำให้ archive เพี้ยน (ตัด 10 แถวท้ายออกแล้วอัดกลับ) เพื่อยิง path row-count mismatch จริง

| เคส | ผล | หลักฐาน |
|---|---|---|
| restore ไฟล์เพี้ยน → error | ✅ | HTTP 500 |
| ไม่มีข้อมูลค้างใน `LogDayArchive` | ✅ | 0 แถว — ROLLBACK ครบ |
| ไม่มี audit row ค้างใน `ArchiveRestore` | ✅ | 0 แถว |
| restore ไฟล์ดีหลัง rollback สำเร็จ | ✅ | HTTP 201 — ไม่มี state ค้างขวาง |

**ยืนยันแล้วว่า transaction boundary ถูกต้อง** — restore ที่ล้มกลางคันไม่ทิ้งข้อมูลบางส่วนไว้ในตาราง

### Remove และ edge case (เคส 17-21)

| # | เคส | ผล | หลักฐาน |
|---|---|---|---|
| 17 | `DELETE /backup/restores/2025-12` | ✅ | 200, removedRows 5000 |
| 17 | `LogDayArchive` ว่าง | ✅ | 0 แถว |
| 17 | ไฟล์บน object storage ยังอยู่ | ✅ | remove ไม่แตะ archive ตามที่ออกแบบ |
| 18 | remove ซ้ำ | ✅ | 404 |
| 19 | export เดือนที่ไม่มีข้อมูล | ✅ | 201, rowCount 0 ไม่ throw |
| 20 | export เดือนเดิมซ้ำ | ✅ | 201 (upsert) |
| 21 | restore ตอน MinIO ล่ม | ⚠️ | 404 — ไม่ค้าง แต่ status ชวนเข้าใจผิด (ดูข้อ 5.2) |
| 21 | pg pool ไม่รั่ว | ✅ | connection คงที่ 1 ก่อน/หลัง |
| 22 | คืนสภาพ DB | ✅ | retention policy กลับมา, ไม่มีข้อมูลตกค้าง |

---

## 4. Performance

วัดแยกด้วยชุดข้อมูล 300,000 แถวในเดือนเดียว (ประมาณโหลดจริงของอุปกรณ์ที่ส่งทุก 8 วินาที):

| รายการ | ค่า |
|---|---|
| export 300,000 แถว | **0.85 วินาที** (~353,000 แถว/วินาที) |
| ขนาด archive | **10.3 MB** gzip (~34 bytes/แถว) |
| restore 300,000 แถว | **2.27 วินาที** (~132,000 แถว/วินาที) |
| ตรวจความถูกต้อง | `sum(temp)` = 5,985,000.0000 ตรงกับค่าคำนวณเป๊ะ |

**ประมาณการ production:** อุปกรณ์ 100 ตัว ส่งทุก 5 นาที = ~864,000 แถว/เดือน → export ~2.5 วินาที, archive ~30 MB/เดือน (~360 MB/ปี) ทั้ง export และ restore เป็น streaming ทั้งเส้น (COPY → gzip → S3 multipart) ไม่โหลดข้อมูลทั้งเดือนเข้าหน่วยความจำ จึงไม่มีเพดานที่น่ากังวลในสเกลนี้

---

## 5. ประเด็นที่พบ

เรียงตามความเร่งด่วน ทั้งหมดเป็นเรื่องที่อยู่นอกขอบเขตการทดสอบรอบนี้ ยังไม่ได้แก้

### 5.1 `ArchiveController` ไม่มี auth guard — เร่งด่วนสูง

`src/backup/archive.controller.ts:10` ไม่มี `@UseGuards` เลย ทั้งที่ doc comment ที่บรรทัด 6-9 ของไฟล์เดียวกันเขียนไว้เองว่าควรครอบด้วย `@UseGuards(JwtAuthGuard, AdminGuard)`

ยืนยันจากการทดสอบ: **ทุก request ในรายงานนี้ยิงโดยไม่แนบ token เลย และผ่านหมด** รวมถึง `DELETE /backup/restores/:month` แปลว่าใครก็ตามที่เข้าถึง API ได้ สามารถลบข้อมูลที่ restore ไว้ หรือสั่ง export ซ้ำ ๆ จนเปลือง I/O ได้

### 5.2 `exists()` กลืน error ทุกชนิด ทำให้ storage ล่มถูกรายงานเป็น 404

`object-storage.service.ts:74-81` จับ error ทั้งหมดจาก HeadObject แล้วคืน `false` ผลคือตอน MinIO ล่ม `restoreMonth` เห็นว่า "ไม่มีไฟล์" แล้วโยน `NotFoundException`

ยืนยันจากเคส 21: หยุด MinIO แล้ว restore เดือนที่**มี** archive อยู่จริง ได้ **404 "ไม่พบ backup ของเดือน 2025-12"** ซึ่งบอกให้คนแก้ปัญหาเข้าใจผิดว่าไฟล์หาย ทั้งที่ปัญหาคือ storage ต่อไม่ได้ ควรแยก `NotFound` ออกจาก error อื่นแล้วปล่อย error การเชื่อมต่อขึ้นไปเป็น 503

### 5.3 retention 6 เดือน hardcode ใน SQL แต่ export cron อ่านจาก env

migration `20260715010000_log_day_archive` ตรึง `INTERVAL '6 months'` ไว้ใน SQL ส่วน `ArchiveExportService` คำนวณเดือนเป้าหมายจาก `ARCHIVE_RETENTION_MONTHS`

- ตั้ง env สูงกว่า 6 → buffer 1 เดือนที่ตั้งใจไว้หายไปเงียบ ๆ
- ตั้ง env ต่ำกว่า 6 → export ทำงานช้ากว่าที่ policy จะ drop → **ข้อมูลหายก่อนถูก backup**

ควรอ่านค่าจากที่เดียว หรืออย่างน้อยใส่ startup check เทียบค่า env กับ policy จริงใน DB แล้วเตือนถ้าไม่สอดคล้อง

### 5.4 `.env.example` มี credential ที่ดูเหมือนของจริง

`.env.example:29-31` (`ARCHIVE_S3_ENDPOINT`, `_ACCESS_KEY`, `_SECRET_KEY`) มีค่าที่ดูเป็น endpoint และ key ของจริง ไม่ใช่ placeholder ควรตรวจสอบและ rotate ถ้าใช่ แล้วแทนด้วยค่าตัวอย่าง

### 5.5 ไม่มี lifecycle policy ฝั่ง object storage

ไม่มีอะไรลบ archive เก่าเลย — โตไปเรื่อย ๆ ไม่มีเพดาน ตามตัวเลขข้อ 4 คือ ~360 MB/ปีต่อ 100 อุปกรณ์ ยังไม่วิกฤตแต่ควรตั้ง bucket lifecycle (เช่นย้ายไป infrequent-access tier หลัง 1 ปี) ไว้ตั้งแต่ตอนนี้

---

## 6. สรุป

**core logic ของ backup/restore ทำงานถูกต้อง** — export/restore รักษาความถูกต้องของข้อมูลได้ครบทั้งจำนวนแถวและค่าจริง, guard ครบทุกทาง, transaction rollback ทำงานจริงเมื่อไฟล์เสียหาย, และ performance เหลือเฟือสำหรับสเกลที่คาดไว้

ปัญหาที่พบไม่ได้อยู่ที่ตัว logic แต่อยู่ที่ **สิ่งที่ล้อมรอบมัน** — ไม่มี auth บน endpoint, deployment ที่ config ไม่ครบจนพังเงียบ ๆ, และค่า retention ที่แยกกันอยู่สองที่ ควรจัดการข้อ 5.1 และ 5.3 ก่อนขึ้น production

## ไฟล์ที่แก้ในรอบนี้

- `docker-compose.yml` — เพิ่ม `minio`, `minio-init`, `ARCHIVE_S3_*`, volume `minio-data`
- `.env.docker.example` — เพิ่ม `ARCHIVE_S3_*`
- `scripts/test-backup.sh` — ใหม่, ชุดทดสอบ 42 เคส
- `docs/backup-restore-test-report.md` — ไฟล์นี้

ไม่แตะโค้ดใน `src/backup/` เลย — รอบนี้คือการทดสอบของเดิม
