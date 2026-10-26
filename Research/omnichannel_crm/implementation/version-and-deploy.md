# Форк 2.52: сборка и обновление существующего экземпляра

26.10.2026. Пункты 1–3 выполнены по прямому разрешению пользователя; новая резервная копия не создавалась. Данные и прежние backups не удалялись.

## Версия и воспроизводимость

- GitHub Releases API latest на момент проверки: [twenty/v2.51.0](https://github.com/twentyhq/twenty/releases/tag/twenty/v2.51.0), опубликован 25.10.2026. В текущем экземпляре уже стоял этот официальный образ.
- Для форка сохранён ранее согласованный snapshot разработки 2.52: `729f6236126eddaa68d176fb766bc349b19de11d`. Это не опубликованный стабильный релиз. Новый main `fc69b162c35850cbbbfa0b2a339f6d213d67e951` проверен, но не смешивался с закреплённой базой.
- Собран полный commit нашего форка `44e1449cbba2c8d88b2d35a6b343f42ea9640c4b`. Runtime совпадает с указанной базой; последующие коммиты содержат операционные скрипты и документы, не другой код приложения.
- Git archive SHA256: `c026bd2a57ddae2c42b69fed1c9c8a00ca0857ff5b7adca5ea05ca7611d47492`. Архив проверен после завершения SCP; ранняя проверка неполного transfer отказала до извлечения/сборки.
- Сборка на Schrodinger: `/opt/twenty-builds/44e1449c`, официальный `packages/twenty-docker/twenty/Dockerfile`, target **twenty**, APP_VERSION=v2.52.0. Node24.22.1, BuildKit ограничен 8 CPU/24 GiB/max-parallelism2. Это сборочная среда, не второй экземпляр CRM.
- Образ: `marketozk/twenty:2.52-44e1449c`, ID `sha256:4a7cb122769f6be4c6256469a58af4d9aa8303c3e68683bc5e528b52ffaa6bac`; OCI label revision равен source SHA. Build exit 0; server и front собраны.

Команда сборки из распакованного Git archive:

```sh
docker buildx build --builder twenty-fork-build --load --target twenty \
  --build-arg APP_VERSION=v2.52.0 \
  --label org.opencontainers.image.revision=44e1449cbba2c8d88b2d35a6b343f42ea9640c4b \
  -t marketozk/twenty:2.52-44e1449c \
  -f packages/twenty-docker/twenty/Dockerfile --progress=plain .
```

## Миграции и операция

В сравнении с тегом 2.51 найдены три workspace command 2.52: reconcile-standard-skill-catalog, seed-workspace-frontend-dependencies, backfill-files-record-form-widgets. Первая синхронизирует штатный каталог, сохраняя isActive; вторая заменяет dependency files встроенного workspace приложения; третья добавляет отсутствующие widgets FILES полей. Новых instance upgrade commands в этом diff нет. Entrypoint может продолжать запуск после ошибки upgrade, поэтому health не использовался как единственное доказательство.

Выполнен полный [deploy-fork.py](../../../ops/omnichannel/deploy-fork.py) из коммита `0ec3fa9c`, SHA256 `49b9def0ad8a7198b5806b01e67aaf540b12a005962a068074a10e7980a388ee`, подтверждён после upload. Скрипт одноразовый: повторное выполнение требует нового preflight, не запускается как универсальный updater.

До stop проверены hashes текущих Compose/.env, image/source label и фактические Env/Cmd/Entrypoint/User/WorkingDir/Mounts/RW/ports/CPU/memory/restart/logging/security/networks/healthcheck. Проверено полное resolved config: единственная разница — image server/worker. Замечание независимого ревью о runtime drift исправлено до запуска.

Остановлены только worker/server; зафиксированы нереверсивные count/content-digests семи CRM-таблиц. Полные исходные данные не копировались. Конфигурация сохранена с заменой repository image и TAG; секреты/тома/порты не менялись. После миграции server проверен upgrade status и содержимое CRM, затем запущен worker.

## Подтверждённый результат

| Проверка | Результат |
|---|---|
| Build и содержимое образа | Exit 0; dist/main.js, front/index.html и migration dependency snapshot присутствуют |
| Версия | APP_VERSION v2.52.0, instance/workspace inferred 2.52.0 |
| Миграции | Instance Up to date; 1 workspace up to date, 0 behind, 0 failed |
| CRM | Count и content fingerprints семи проверенных CRM-таблиц до/после совпали |
| Server/worker | Оба на одном image ID, Running; server healthy, restartCount 0 у обоих |
| HTTP | Серверный и локальный localhost:2020/healthz — 200 |
| Последние логи | В выбранном окне последних 200 строк/5 минут ERROR/FATAL не найдено; не гарантия будущих ошибок |
| Инфраструктура | ID DB/Redis и всех остальных работающих контейнеров совпали до/после операции |
| UI после перезагрузки | Обзор с 6 тендерами, доска с 6 сделками, список двух существующих процессов и схема Quick Lead открываются; запуски не выполнялись |
| Backup | Новый backup не создан; database:reset и удаление томов не выполнялись |

Операционный результат и приватные журналы: `/opt/twenty-demo/operations/fork-2.52-44e1449c/`. В Git не перенесены env, ключи, полные переписки или приватные логи. Отчёт не утверждает готовность новых чатов/прав/аудита и не засчитывает непроведённые тесты этих функций.
