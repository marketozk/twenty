import { isUUID } from 'class-validator';

export type MessageParticipantRematchSelector =
  | { kind: 'personOnly'; personEmails: readonly string[] }
  | { kind: 'workspaceMemberOnly'; workspaceMemberIds: readonly string[] };

export const captureMessageParticipantRematchSelector = (
  selector: MessageParticipantRematchSelector,
): MessageParticipantRematchSelector => {
  if (selector?.kind === 'personOnly') {
    if (
      !Array.isArray(selector.personEmails) ||
      selector.personEmails.some((email) => typeof email !== 'string')
    )
      throw new Error('Native message rematch requires email selection');
    return Object.freeze({
      kind: 'personOnly',
      personEmails: Object.freeze([
        ...new Set(selector.personEmails.map((email) => email.toLowerCase())),
      ]),
    });
  }
  if (selector?.kind === 'workspaceMemberOnly') {
    if (
      !Array.isArray(selector.workspaceMemberIds) ||
      selector.workspaceMemberIds.some(
        (id) => typeof id !== 'string' || !isUUID(id),
      )
    )
      throw new Error('Native message rematch requires member selection');
    return Object.freeze({
      kind: 'workspaceMemberOnly',
      workspaceMemberIds: Object.freeze([
        ...new Set(selector.workspaceMemberIds.map((id) => id.toLowerCase())),
      ]),
    });
  }
  throw new Error('Native message rematch requires a selector');
};
