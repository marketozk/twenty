import { Injectable, type NestMiddleware } from '@nestjs/common';
import {
  captureCrmAuditRequest,
  withCrmAuditRequest,
} from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';

import { type NextFunction, type Request, type Response } from 'express';
import { isDefined } from 'twenty-shared/utils';

import { withWorkspaceAuthContext } from 'src/engine/core-modules/auth/storage/workspace-auth-context.storage';
import { buildWorkspaceAuthContextFromRequest } from 'src/engine/core-modules/auth/utils/build-workspace-auth-context-from-request.util';
import { applyWorkspaceSentryContext } from 'src/engine/core-modules/sentry/utils/apply-workspace-sentry-context.util';

@Injectable()
export class WorkspaceAuthContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const auditSnapshot = captureCrmAuditRequest(req);
    return withCrmAuditRequest(auditSnapshot, () => {
      if (!isDefined((req as Request & { workspace?: unknown }).workspace)) {
        next();

        return;
      }

      const authContext = buildWorkspaceAuthContextFromRequest(req);

      applyWorkspaceSentryContext(authContext);

      void withWorkspaceAuthContext(authContext, () => {
        next();
      });
    });
  }
}
