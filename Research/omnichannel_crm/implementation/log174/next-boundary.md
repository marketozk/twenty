# Следующая граница ROB-765 после LOG-174

После закрытия в `LOG-174` транзакционного аудита полного жизненного цикла доменов одобренного доступа (`core."approvedAccessDomain"` в `ApprovedAccessDomainService` и `ApprovedAccessDomainResolver`) и публичных доменов приложений (`core."publicDomain"` в `PublicDomainService`, `PublicDomainResolver`, `CheckPublicDomainsValidRecordsCronJob`, `DnsCloudflareService` и каскадного удаления в `ApplicationService.delete` / `runAuditedApplicationDelete`) открытыми границами `ROB-765` остаются:

1. Оставшиеся административные настройки рабочего пространства и аутентификации в схеме `core` (включая настройки провайдеров входа/SSO `core."workspaceSsoIdentityProvider"`, домены отправки писем `core."emailingDomain"`, настройки безопасности `core.workspace`, вебхуки `core.webhook`).
2. Семейный отзыв refresh-токенов, in-flight fencing и конкурентный вход в `Session lifecycle`.
3. Публичный `DESTROY` / `MERGE`, реальные `recordShare` и физическое удаление файлов (`FilesFieldDeletionJob`) в общем контуре native/core аудита.
4. Полная HTTP/JWT приёмка и выкат собранного кандидата.
