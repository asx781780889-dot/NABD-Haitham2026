# تحليل مشكلة امتلاء `postgres-volume`

## خلاصة تنفيذية

تمت مراجعة المستودع `NABD-AI` وتحليل تعريف PostgreSQL، مخطط الجداول، مهام التنظيف، النسخ الاحتياطي، ومراقبة قاعدة البيانات.

**لا توجد في نسخة المستودع بيانات تشغيلية أو اتصال مباشر بخادم Docker يمكن بواسطته قياس الحجم الحالي**؛ لذلك لا يمكن الجزم بحجم جدول بعينه أو نسبة الامتلاء الفعلية من المستودع وحده. ما يلي هو تشخيص ساكن مؤكد من الكود، مع أوامر يجب تشغيلها على الخادم الذي يحتوي على `postgres-volume` لتحديد السبب النهائي قبل الحذف.

## ما هو `postgres-volume` في هذا المشروع؟

في `docker-compose.yml` يُربط الحجم المسمى `pg-data` بمسار PostgreSQL:

```yaml
postgres:
  image: postgres:16-alpine
  volumes:
    - pg-data:/var/lib/postgresql/data
```

إذن بيانات PostgreSQL، بما فيها الجداول والفهارس و`WAL` وملفات PostgreSQL الداخلية، موجودة في `pg-data`/`postgres-volume` بحسب اسم الحجم في بيئة النشر. لا يوجد حد حجم أو تدوير تلقائي للحجم في Compose؛ امتلاء القرص أو الحجم سيؤدي في النهاية إلى توقف الكتابة وربما توقف الإدخال.

يوجد حجمان آخران يجب عدم الخلط بينهما:

- `nabd-data:/data`: يحتوي على النسخ الاحتياطية المشفرة، السجلات والملفات المصدرة.
- `redis-data:/data`: يحتوي على Redis وAOF.

النسخ الاحتياطية ليست داخل `pg-data` وفق Compose الحالي، لكنها قد تملئ `nabd-data`.

## النتائج المؤكدة من الكود

### 1. جدول `messages` مرشح لأن يكون أكبر مصدر للنمو

كل رسالة Telegram تُحفظ مع نصها وبياناتها في `messages`. يوجد فهرس GIN على النص عبر `pg_trgm` إضافة إلى عدة فهارس زمنية ومصدرية ومرسِلة. لذلك فالحجم الفعلي قد يكون أكبر من حجم الصفوف وحدها بسبب الفهارس وبيانات GIN/TOAST.

التنظيف الحالي يعالج الرسائل غير المرتبطة فقط:

- بعد `retention_unmatched_days` (الافتراضي يوم واحد / 24 ساعة) تُوسم الرسالة `deleted_at`.
- بعد `purge_grace_days` (الافتراضي 7 أيام) تُحذف فعلياً.
- الرسالة التي لها `message_matches` أو `match_occurrences` لا تُحذف.

بالتالي، إذا كانت نسبة كبيرة من الرسائل تؤدي إلى تطابقات أو occurrences، فقد يستمر `messages` في النمو إلى أجل غير محدود، وهذا يبدو مقصوداً للحفاظ على البطاقات التاريخية لكنه يحتاج سياسة احتفاظ مستقلة.

### 2. بيانات التطابقات والذكاء الاصطناعي لا تملك احتفاظاً زمنياً

الجداول التالية لا تظهر ضمن `runCleanup()` بسياسة حذف زمنية:

- `message_matches`
- `match_occurrences`
- `ai_results`
- `saved_results`

وبعضها يحتوي نصوصاً وحقول `jsonb` وفهارس متعددة. خصوصاً `message_matches` لديه عدد كبير من الفهارس (`created`, `priority`, `bucket`, hash، sender، rule، source)، ما قد يضاعف استهلاك القرص مقارنة بالبيانات الأساسية.

الحذف اليدوي للتطابقات خطر لأنه قد يحذف البطاقات والمراجع التابعة. يلزم أولاً تعريف سياسة: أرشفة، أو الاحتفاظ بالبطاقات المثبتة/المحفوظة فقط، أو حذف التطابقات الأقدم من مدة محددة مع cascading مضبوط واختبار استعادة.

### 3. `audit_logs` لا تُنظف رغم وجود احتفاظ للسجلات

التنظيف يحذف من `system_logs` وفق `logs.retention_days`، لكنه **لا يحذف من `audit_logs`**. وبما أن `audit_logs` append-only ويُسجل فيه عدد كبير من أحداث المستخدم والنظام، فقد يصبح مصدراً دائماً للنمو.

هذا اختلاف مهم بين الوصف التشغيلي والسياسة الفعلية: الاحتفاظ المعلن للسجلات لا ينطبق حالياً على سجلات التدقيق.

### 4. `system_logs` و`notifications` تنظف، لكن الحذف قد يسبب bloat

هناك حذف دوري من:

- `system_logs` بعد 30 يوماً افتراضياً.
- `notifications` ذات الحالات النهائية بعد 60 يوماً.
- `jobs` بعد 30 يوماً.
- `api_usage` بعد 90 يوماً.
- `automation_runs` بعد 60 يوماً.
- `user_sessions` المنتهية.
- `workers` القديمة.

لكن الحذف المتكرر لا يعيد المساحة تلقائياً إلى نظام الملفات؛ PostgreSQL يعيد استخدامها داخلياً غالباً، وقد تظهر مساحة كبيرة كـ dead tuples/bloat. يلزم مراقبة `n_dead_tup` ثم `VACUUM (ANALYZE)`، ولا يُستخدم `VACUUM FULL` أثناء التشغيل الطبيعي لأنه يحجز قفلًا ويحتاج مساحة مؤقتة إضافية.

### 5. لا توجد partitioning للجداول الزمنية

الجداول ذات النمو الطبيعي مثل `messages`, `message_matches`, `ai_results`, `system_logs`, `audit_logs`, `api_usage` و`automation_runs` ليست مقسّمة حسب الشهر أو اليوم. لذلك يصبح حذف البيانات القديمة وإدارة الفهارس أكثر كلفة كلما كبرت القاعدة.

### 6. `WAL` وreplication slots مراقبان فقط

المراقبة تعرض حجم WAL وlag الخاص بـ replication slots، لكنها لا تعالج slot مهجوراً أو إعداداً يؤدي إلى احتجاز WAL. إذا وُجد replication slot غير نشط، فقد يحتجز كمية كبيرة من WAL داخل `pg-data`.

يجب فحص ذلك قبل حذف أي ملفات من `pg_wal`؛ **لا تحذف ملفات `pg_wal` يدوياً**.

### 7. النسخ الاحتياطية قد تسبب امتلاء حجماً آخر

النسخ الاحتياطي يستخدم `pg_dump -Fc` ثم تشفير الملف، ويحتفظ افتراضياً بآخر 7 نسخ لكل نوع. الملفات تُحفظ تحت `/data/backups`، أي في `nabd-data` لا `pg-data` في Compose الحالي. يجب فحص الحجمين معاً لأن تشخيص امتلاء القرص قد يُنسب خطأً إلى PostgreSQL.

## أوامر التشخيص الآمنة على الخادم

شغّل الأوامر من مجلد المشروع. لا تنفذ أوامر الحذف قبل حفظ النتائج ونسخة احتياطية قابلة للاختبار.

### 1. معرفة اسم الحجم ومكانه وحجمه

```bash
docker volume ls | grep -E 'pg-data|postgres-volume'
docker volume inspect <اسم-الحجم>
docker system df -v

docker compose exec postgres sh -lc 'du -sh /var/lib/postgresql/data /var/lib/postgresql/data/pg_wal 2>/dev/null'
du -sh "$(docker volume inspect -f '{{.Mountpoint}}' <اسم-الحجم>)"
```

### 2. أكبر الجداول والفهارس

```bash
docker compose exec -T postgres psql -U nabd -d nabd <<'SQL'
SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size;

SELECT
  n.nspname AS schema,
  c.relname AS table_name,
  pg_size_pretty(pg_table_size(c.oid)) AS table_size,
  pg_size_pretty(pg_indexes_size(c.oid)) AS indexes_size,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
  s.n_live_tup,
  s.n_dead_tup,
  s.last_autovacuum,
  s.last_autoanalyze
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relkind = 'r' AND n.nspname = 'public'
ORDER BY pg_total_relation_size(c.oid) DESC;

SELECT
  schemaname, relname AS table_name, indexrelname AS index_name,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
  idx_scan
FROM pg_stat_user_indexes
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 30;
SQL
```

### 3. تقدير البيانات المرشحة للتنظيف

```bash
docker compose exec -T postgres psql -U nabd -d nabd <<'SQL'
SELECT
  count(*) FILTER (WHERE deleted_at IS NULL) AS live_messages,
  count(*) FILTER (WHERE deleted_at IS NOT NULL) AS soft_deleted_messages,
  count(*) FILTER (WHERE created_at < now() - interval '7 days'
    AND NOT EXISTS (SELECT 1 FROM message_matches mm WHERE mm.message_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM match_occurrences mo WHERE mo.message_id = m.id)) AS unmatched_older_than_7d
FROM messages m;

SELECT 'system_logs' AS table_name, count(*) AS old_rows
FROM system_logs WHERE created_at < now() - interval '30 days'
UNION ALL
SELECT 'notifications', count(*)
FROM notifications WHERE status IN ('sent','read','failed') AND created_at < now() - interval '60 days'
UNION ALL
SELECT 'audit_logs', count(*)
FROM audit_logs WHERE created_at < now() - interval '90 days'
UNION ALL
SELECT 'ai_results', count(*)
FROM ai_results WHERE created_at < now() - interval '180 days'
UNION ALL
SELECT 'automation_runs', count(*)
FROM automation_runs WHERE started_at < now() - interval '60 days';
SQL
```

### 4. فحص WAL والـ replication slots والمعاملات العالقة

```bash
docker compose exec -T postgres psql -U nabd -d nabd <<'SQL'
SELECT pg_size_pretty(COALESCE(sum(size),0)) AS wal_size
FROM pg_ls_waldir();

SELECT slot_name, active,
       pg_size_pretty(COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn),0)) AS retained_wal
FROM pg_replication_slots;

SELECT pid, usename, state,
       now() - xact_start AS transaction_age,
       now() - query_start AS query_age,
       left(query, 200) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY xact_start;
SQL
```

## خطة المعالجة المقترحة

### أولوية فورية: منع التوقف

1. احفظ نسخة `pg_dump -Fc` خارج نفس الخادم أو على تخزين منفصل، وتحقق من أن الملف يمكن قراءته عبر `pg_restore --list`.
2. خذ نسخة من ناتج استعلامات الأحجام أعلاه.
3. إذا كانت النسبة حرجة، أوقف الإدخال مؤقتاً بإيقاف worker/telegram أو فعّل وضع الإيقاف من لوحة النظام، ولا تحذف ملفات PostgreSQL يدوياً.
4. وسّع القرص/الحجم أولاً إذا كان الخطر قريباً من 90–95% ولا توجد مساحة آمنة لإجراء صيانة.
5. شغّل معاينة التنظيف الموجودة في لوحة `System → Database` قبل التنفيذ.

### أولوية قصيرة: استعادة المساحة بأمان

1. نفّذ retention الحالي للرسائل غير المرتبطة بعد مراجعة عدد الصفوف المتوقع.
2. نفّذ `VACUUM (ANALYZE)` للجداول التي يظهر فيها `n_dead_tup` مرتفعاً. هذا يعيد المساحة للاستخدام الداخلي ولا يصغّر الملف غالباً، لكنه يمنع مزيداً من النمو غير الضروري.
3. افحص replication slots. إذا كان slot مهجوراً، احذف أو أصلح slot عبر إجراء موثق وبعد التأكد أنه غير مستخدم؛ لا تحذف `pg_wal` يدوياً.
4. راجع `/data/backups` و`redis-data` أيضاً، لأن امتلاء القرص قد لا يكون من `pg-data`.
5. خفّض مدة الاحتفاظ بالرسائل غير المرتبطة فقط إذا كان ذلك مقبولاً تشغيلياً، ولا تخفضها إلى يوم واحد دون اختبار.

### أولوية تطويرية: إصلاح جذور النمو

1. **إضافة retention لـ `audit_logs`** مع مدة مستقلة، أو أرشفتها خارج PostgreSQL قبل حذفها. ينبغي أن تكون السياسة صريحة بسبب طبيعتها التدقيقية.
2. إضافة retention لـ `ai_results` و`match_occurrences` و`message_matches` مع استثناء `pinned` و`saved_results` والحالات المطلوبة قانونياً/تشغيلياً.
3. إضافة retention أو partitioning لـ `messages` و`message_matches` إذا كان حجم الإدخال كبيراً.
4. إضافة فهارس مناسبة لاستعلامات التنظيف، مثل فهرس جزئي زمني مع `deleted_at` و`state`، بعد مراجعة `EXPLAIN (ANALYZE, BUFFERS)` على نسخة اختبار.
5. تقسيم الجداول الزمنية الكبيرة شهرياً مستقبلاً، بحيث يصبح حذف شهر قديم عملية `DROP/DETACH PARTITION` بدلاً من حذف صفوف ضخمة.
6. إضافة مراقبة وتنبيه منفصلين لـ:
   - حجم `pg-data` الفعلي على مستوى Docker/نظام الملفات.
   - حجم قاعدة البيانات.
   - حجم WAL والـ replication slots.
   - نسبة dead tuples ووقت آخر autovacuum.
7. جعل عملية الصيانة idempotent وقابلة للتدرج، مع تسجيل عدد الصفوف والمساحة قبل/بعد كل عملية.

## ما لا ينبغي فعله

- لا تحذف مجلد `pg_wal` أو ملفات قاعدة البيانات يدوياً.
- لا تستخدم `docker volume prune`؛ قد يحذف أحجاماً أخرى.
- لا تستخدم `DROP DATABASE` أو `TRUNCATE` قبل نسخة احتياطية واختبار استعادة.
- لا تبدأ بـ `VACUUM FULL` على قاعدة إنتاجية ممتلئة؛ يحتاج قفلاً ومساحة مؤقتة وقد يفشل بسبب نقص المساحة.
- لا تحذف `message_matches` أو `match_occurrences` عشوائياً، لأن ذلك قد يكسر البطاقات والإشعارات والتقارير.

## الحكم النهائي

من الكود، السبب الأرجح ليس عطباً في Docker volume نفسه، بل **نمو بيانات التطبيق بلا سياسة احتفاظ كاملة**، وعلى رأسها الرسائل المرتبطة بالتطابقات، نتائج الذكاء الاصطناعي، occurrences، والتدقيق `audit_logs`. ويجب استبعاد WAL المحتجز وbloat والفهارس الكبيرة بقياسات الخادم قبل اختيار إجراء الحذف.

الترتيب الآمن هو: **قياس → نسخة احتياطية واختبارها → إيقاف الإدخال عند الضرورة → تنظيف مدروس → VACUUM/ANALYZE → توسيع الحجم أو partitioning → إضافة سياسات retention الناقصة**.
