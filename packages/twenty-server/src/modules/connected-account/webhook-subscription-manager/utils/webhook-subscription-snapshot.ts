export type WebhookSubscriptionSnapshot = {
  connectedAccountId: string;
  webhookSubscriptionExternalId: string | null;
  webhookSubscriptionClientState: string | null;
  webhookSubscriptionStatus: string | null;
  webhookSubscriptionExpiresAt: Date | null;
};

export const webhookSubscriptionSnapshot = (
  channel: WebhookSubscriptionSnapshot,
): WebhookSubscriptionSnapshot => ({
  connectedAccountId: channel.connectedAccountId,
  webhookSubscriptionExternalId: channel.webhookSubscriptionExternalId,
  webhookSubscriptionClientState: channel.webhookSubscriptionClientState,
  webhookSubscriptionStatus: channel.webhookSubscriptionStatus,
  webhookSubscriptionExpiresAt: channel.webhookSubscriptionExpiresAt
    ? new Date(channel.webhookSubscriptionExpiresAt)
    : null,
});

export const matchesWebhookSubscription = (
  channel: WebhookSubscriptionSnapshot,
  expected: WebhookSubscriptionSnapshot,
): boolean =>
  channel.connectedAccountId === expected.connectedAccountId &&
  channel.webhookSubscriptionExternalId ===
    expected.webhookSubscriptionExternalId &&
  channel.webhookSubscriptionClientState ===
    expected.webhookSubscriptionClientState &&
  channel.webhookSubscriptionStatus === expected.webhookSubscriptionStatus &&
  channel.webhookSubscriptionExpiresAt?.getTime() ===
    expected.webhookSubscriptionExpiresAt?.getTime();
