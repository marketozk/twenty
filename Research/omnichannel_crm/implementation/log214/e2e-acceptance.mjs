import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const SERVER = 'http://server:3000';
const ORIGIN = 'http://server:3000';
const DB_URL =
  'postgres://test_owner:isolated-test-only@postgres:5432/twenty_rob764_test_2140000000000001';

const gql = async (path, query, variables = {}, headers = {}) => {
  const res = await fetch(`${SERVER}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      ...headers,
    },
    body: JSON.stringify({ query, variables }),
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const json = await res.json();
  return { status: res.status, json, setCookies };
};

const extractCookieHeader = (setCookies) =>
  setCookies.map((c) => c.split(';')[0]).join('; ');

const loginUser = async (email, password) => {
  const step1 = await gql(
    '/metadata',
    `mutation Login($email: String!, $password: String!, $origin: String!) {
      getLoginTokenFromCredentials(email: $email, password: $password, origin: $origin) {
        loginToken { token }
      }
    }`,
    { email, password, origin: ORIGIN },
  );
  assert.equal(step1.status, 200, `step1 HTTP ${step1.status}: ${JSON.stringify(step1.json)}`);
  assert.ok(!step1.json.errors, `step1 errors: ${JSON.stringify(step1.json.errors)}`);
  const loginToken = step1.json.data.getLoginTokenFromCredentials.loginToken.token;

  const step2 = await gql(
    '/metadata',
    `mutation Tokens($loginToken: String!, $origin: String!) {
      getAuthTokensFromLoginToken(loginToken: $loginToken, origin: $origin) {
        tokens {
          accessOrWorkspaceAgnosticToken { token }
          refreshToken { token }
        }
      }
    }`,
    { loginToken, origin: ORIGIN },
  );
  assert.equal(step2.status, 200, `step2 HTTP ${step2.status}: ${JSON.stringify(step2.json)}`);
  assert.ok(!step2.json.errors, `step2 errors: ${JSON.stringify(step2.json.errors)}`);
  const tokens = step2.json.data.getAuthTokensFromLoginToken.tokens;
  const cookieHeader = extractCookieHeader(step2.setCookies);
  assert.ok(tokens.accessOrWorkspaceAgnosticToken.token.length > 20, 'missing accessToken');
  assert.ok(tokens.refreshToken.token.length > 20, 'missing refreshToken');
  return {
    accessToken: tokens.accessOrWorkspaceAgnosticToken.token,
    refreshToken: tokens.refreshToken.token,
    cookieHeader,
  };
};

const main = async () => {
  const pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  const report = {};

  try {
    // 1. GET /healthz
    const healthRes = await fetch(`${SERVER}/healthz`);
    assert.equal(healthRes.status, 200);
    const healthBody = await healthRes.json();
    assert.equal(healthBody.status, 'ok');
    report.healthz = healthBody;

    // 2. Real HTTP login for full server admin (tim@apple.dev) and non-admin (scott.forstall@apple.dev)
    const auditBeforeAuth = Number(
      (await pg.query('SELECT count(*) FROM crm_audit."crmAuditEntry"')).rows[0].count,
    );
    const adminAuth = await loginUser('tim@apple.dev', 'tim@apple.dev');
    const nonAdminAuth = await loginUser('scott.forstall@apple.dev', 'tim@apple.dev');
    const authAudits = (
      await pg.query(
        `SELECT "resourceKind", action, outcome, actor, "redactedDiff"
         FROM crm_audit."crmAuditEntry"
         WHERE "resourceKind" IN ('userSession', 'refreshToken') AND action = 'create'
         ORDER BY "createdAt" DESC LIMIT 10`,
      )
    ).rows;
    assert.ok(
      authAudits.some((r) => r.resourceKind === 'userSession' && r.action === 'create'),
      'Expected userSession:create audit',
    );
    assert.ok(
      authAudits.some((r) => r.resourceKind === 'refreshToken' && r.action === 'create'),
      'Expected refreshToken:create audit',
    );
    assert.ok(!JSON.stringify(authAudits).includes(adminAuth.accessToken), 'accessToken leaked');
    assert.ok(!JSON.stringify(authAudits).includes(adminAuth.refreshToken), 'refreshToken leaked');
    report.authLoginAudited = {
      auditBeforeAuth,
      sessionAndRefreshCreateCount: authAudits.length,
      cookieIssued: adminAuth.cookieHeader.length > 0,
    };

    // 3. Protected AdminPanelResolver.crmAuditHealth on /admin-panel
    const healthQuery = `query CrmAuditHealth($bypassCache: Boolean) {
      crmAuditHealth(bypassCache: $bypassCache) {
        status
        databaseReachable
        appendOnlyPrivilegesVerified
        checkedAt
        fromCache
        totalUnavailableCount
        recentUnavailableCount
        hasRecentAuditLoss
        recentWindowMs
        alertSink {
          sentryEnabled
          webhookConfigured
          webhookDeliveredCount
          webhookDeliveryFailureCount
          webhookDroppedCount
          webhookSuppressedCount
        }
      }
    }`;

    const unauthHealth = await gql('/admin-panel', healthQuery, { bypassCache: true });
    assert.ok(
      unauthHealth.status >= 400 || (unauthHealth.json.errors && unauthHealth.json.errors.length > 0),
      `Unauthenticated /admin-panel crmAuditHealth must be rejected: ${JSON.stringify(unauthHealth)}`,
    );

    const nonAdminHealth = await gql(
      '/admin-panel',
      healthQuery,
      { bypassCache: true },
      nonAdminAuth.cookieHeader
        ? { Cookie: nonAdminAuth.cookieHeader }
        : { Authorization: `Bearer ${nonAdminAuth.accessToken}` },
    );
    assert.ok(
      nonAdminHealth.status >= 400 || (nonAdminHealth.json.errors && nonAdminHealth.json.errors.length > 0),
      `Non-admin /admin-panel crmAuditHealth must be rejected: ${JSON.stringify(nonAdminHealth)}`,
    );

    const adminHeaders = adminAuth.cookieHeader
      ? { Cookie: adminAuth.cookieHeader }
      : { Authorization: `Bearer ${adminAuth.accessToken}` };
    const adminHealth = await gql('/admin-panel', healthQuery, { bypassCache: true }, adminHeaders);
    assert.equal(adminHealth.status, 200, `adminHealth HTTP ${adminHealth.status}`);
    assert.ok(!adminHealth.json.errors, `adminHealth errors: ${JSON.stringify(adminHealth.json.errors)}`);
    const ah = adminHealth.json.data.crmAuditHealth;
    assert.equal(ah.status, 'OK');
    assert.equal(ah.databaseReachable, true);
    assert.equal(ah.appendOnlyPrivilegesVerified, true);
    assert.equal(ah.fromCache, false);
    assert.equal(ah.hasRecentAuditLoss, false);
    assert.equal(ah.alertSink.webhookConfigured, false);
    report.adminCrmAuditHealth = {
      unauthRejected: true,
      nonAdminRejected: true,
      adminResponse: ah,
    };

    // 4. Native CRM GraphQL CRUD over HTTP (/graphql): Company (create/update/delete/restore/destroy), Note, Task, Dashboard
    const bearerAdmin = { Authorization: `Bearer ${adminAuth.accessToken}` };

    const createCompany = await gql(
      '/graphql',
      `mutation CreateCompany($data: CompanyCreateInput!) {
        createCompany(data: $data) { id name }
      }`,
      { data: { name: 'LOG214 Acceptance Corp' } },
      bearerAdmin,
    );
    assert.ok(!createCompany.json.errors, `createCompany errors: ${JSON.stringify(createCompany.json.errors)}`);
    const companyId = createCompany.json.data.createCompany.id;

    const updateCompany = await gql(
      '/graphql',
      `mutation UpdateCompany($id: UUID!, $data: CompanyUpdateInput!) {
        updateCompany(id: $id, data: $data) { id name }
      }`,
      { id: companyId, data: { name: 'LOG214 Acceptance Corp Updated' } },
      bearerAdmin,
    );
    assert.ok(!updateCompany.json.errors, `updateCompany errors: ${JSON.stringify(updateCompany.json.errors)}`);

    const deleteCompany = await gql(
      '/graphql',
      `mutation DeleteCompany($id: UUID!) {
        deleteCompany(id: $id) { id }
      }`,
      { id: companyId },
      bearerAdmin,
    );
    assert.ok(!deleteCompany.json.errors, `deleteCompany errors: ${JSON.stringify(deleteCompany.json.errors)}`);

    const restoreCompany = await gql(
      '/graphql',
      `mutation RestoreCompany($id: UUID!) {
        restoreCompany(id: $id) { id }
      }`,
      { id: companyId },
      bearerAdmin,
    );
    assert.ok(!restoreCompany.json.errors, `restoreCompany errors: ${JSON.stringify(restoreCompany.json.errors)}`);

    const destroyCompany = await gql(
      '/graphql',
      `mutation DestroyCompany($id: UUID!) {
        destroyCompany(id: $id) { id }
      }`,
      { id: companyId },
      bearerAdmin,
    );
    assert.ok(!destroyCompany.json.errors, `destroyCompany errors: ${JSON.stringify(destroyCompany.json.errors)}`);

    const companyAudits = (
      await pg.query(
        `SELECT action, outcome, actor, "redactedDiff"
         FROM crm_audit."crmAuditEntry"
         WHERE "resourceKind" = 'crmRecord' AND "resourceId" = $1
         ORDER BY "createdAt" ASC, id ASC`,
        [companyId],
      )
    ).rows;
    assert.deepEqual(
      companyAudits.map((r) => `${r.action}:${r.outcome}`),
      [
        'create:success',
        'update:success',
        'update:success',
        'update:success',
        'delete:success',
      ],
      `Unexpected company audit sequence: ${JSON.stringify(companyAudits)}`,
    );

    const createNote = await gql(
      '/graphql',
      `mutation CreateNote($data: NoteCreateInput!) {
        createNote(data: $data) { id title }
      }`,
      { data: { title: 'LOG214 Note' } },
      bearerAdmin,
    );
    assert.ok(!createNote.json.errors, `createNote errors: ${JSON.stringify(createNote.json.errors)}`);
    const noteId = createNote.json.data.createNote.id;

    const createTask = await gql(
      '/graphql',
      `mutation CreateTask($data: TaskCreateInput!) {
        createTask(data: $data) { id title }
      }`,
      { data: { title: 'LOG214 Task' } },
      bearerAdmin,
    );
    assert.ok(!createTask.json.errors, `createTask errors: ${JSON.stringify(createTask.json.errors)}`);
    const taskId = createTask.json.data.createTask.id;

    const createDashboard = await gql(
      '/graphql',
      `mutation CreateDashboard($data: DashboardCreateInput!) {
        createDashboard(data: $data) { id title }
      }`,
      { data: { title: 'LOG214 Dashboard' } },
      bearerAdmin,
    );
    assert.ok(!createDashboard.json.errors, `createDashboard errors: ${JSON.stringify(createDashboard.json.errors)}`);
    const dashboardId = createDashboard.json.data.createDashboard.id;

    const otherRecordAudits = (
      await pg.query(
        `SELECT "resourceId", action, outcome
         FROM crm_audit."crmAuditEntry"
         WHERE "resourceKind" = 'crmRecord' AND "resourceId" = ANY($1::text[])`,
        [[noteId, taskId, dashboardId]],
      )
    ).rows;
    assert.equal(otherRecordAudits.length, 3, `Expected 3 audits for note/task/dashboard, got ${JSON.stringify(otherRecordAudits)}`);

    report.crmCrudAudited = {
      companyLifecycle: companyAudits.map((r) => `${r.action}:${r.outcome}`),
      noteAudited: otherRecordAudits.some((r) => r.resourceId === noteId && r.action === 'create'),
      taskAudited: otherRecordAudits.some((r) => r.resourceId === taskId && r.action === 'create'),
      dashboardAudited: otherRecordAudits.some((r) => r.resourceId === dashboardId && r.action === 'create'),
    };

    // 5. Post-rollback failed audit on non-existent company update over HTTP
    const missingId = '00000000-0000-4000-8000-000000000214';
    const failedUpdate = await gql(
      '/graphql',
      `mutation UpdateMissing($id: UUID!, $data: CompanyUpdateInput!) {
        updateCompany(id: $id, data: $data) { id }
      }`,
      { id: missingId, data: { name: 'Should fail' } },
      bearerAdmin,
    );
    assert.ok(failedUpdate.json.errors && failedUpdate.json.errors.length > 0, 'Expected error on missing company update');
    const postRollbackRows = (
      await pg.query(
        `SELECT outcome, "reasonCode", "resourceKind", action
         FROM crm_audit."crmAuditEntry"
         WHERE "resourceKind" = 'crmRecord' AND outcome IN ('denied', 'failed')
         ORDER BY "createdAt" DESC LIMIT 5`,
      )
    ).rows;
    assert.ok(
      postRollbackRows.length >= 1,
      'Expected post-rollback denied/failed audit entry after failed updateCompany',
    );
    report.postRollbackFailedAudit = postRollbackRows[0];

    // 6. Refresh token rotation + family revocation on signOut({ refreshToken }) over HTTP
    const renewRes = await gql(
      '/metadata',
      `mutation Renew($appToken: String!) {
        renewToken(appToken: $appToken) {
          tokens {
            accessOrWorkspaceAgnosticToken { token }
            refreshToken { token }
          }
        }
      }`,
      { appToken: nonAdminAuth.refreshToken },
      nonAdminAuth.cookieHeader ? { Cookie: nonAdminAuth.cookieHeader } : {},
    );
    assert.ok(!renewRes.json.errors, `renewToken errors: ${JSON.stringify(renewRes.json.errors)}`);
    const rotatedRefresh = renewRes.json.data.renewToken.tokens.refreshToken.token;
    const decodeJwtPayload = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    const parentJti = decodeJwtPayload(nonAdminAuth.refreshToken).jti;
    const childJti = decodeJwtPayload(rotatedRefresh).jti;
    assert.notEqual(parentJti, childJti);

    // Sign out presenting the PRE-ROTATION parent token + session cookie
    const signOutRes = await gql(
      '/metadata',
      `mutation SignOut($refreshToken: String) {
        signOut(refreshToken: $refreshToken)
      }`,
      { refreshToken: nonAdminAuth.refreshToken },
      nonAdminAuth.cookieHeader ? { Cookie: nonAdminAuth.cookieHeader } : {},
    );
    assert.ok(!signOutRes.json.errors, `signOut errors: ${JSON.stringify(signOutRes.json.errors)}`);
    assert.equal(signOutRes.json.data.signOut, true);

    const familyRows = (
      await pg.query(
        `SELECT id, "revokedAt", context->>'revokedReason' AS reason, context->>'familyId' AS family_id
         FROM core."appToken"
         WHERE id = ANY($1::uuid[])
         ORDER BY id`,
        [[parentJti, childJti]],
      )
    ).rows;
    assert.equal(familyRows.length, 2);
    for (const row of familyRows) {
      assert.ok(row.revokedAt !== null, `Expected revokedAt on ${row.id}`);
      assert.equal(row.reason, 'USER_SIGN_OUT', `Expected USER_SIGN_OUT on ${row.id}, got ${row.reason}`);
    }
    assert.equal(familyRows[0].family_id, familyRows[1].family_id);

    // Subsequent renewToken using rotated child MUST be rejected
    const replayChild = await gql(
      '/metadata',
      `mutation RenewChild($appToken: String!) {
        renewToken(appToken: $appToken) {
          tokens { refreshToken { token } }
        }
      }`,
      { appToken: rotatedRefresh },
    );
    assert.ok(
      replayChild.json.errors && replayChild.json.errors.length > 0,
      `Rotated child token must be rejected after parent signOut: ${JSON.stringify(replayChild.json)}`,
    );

    const signOutAudits = (
      await pg.query(
        `SELECT "resourceKind", "resourceId", action, "operationId", "correlationId"
         FROM crm_audit."crmAuditEntry"
         WHERE "resourceId" = ANY($1::text[]) AND action = 'update'
         ORDER BY "createdAt" DESC`,
        [[parentJti, childJti]],
      )
    ).rows;
    const childSignOutAudit = signOutAudits.find((r) => r.resourceId === childJti);
    assert.ok(childSignOutAudit, 'Expected child refreshToken sign-out audit');
    assert.ok(childSignOutAudit.correlationId, 'Expected correlationId on sign-out audit');

    report.refreshFamilySignOut = {
      parentRevokedReason: familyRows.find((r) => r.id === parentJti).reason,
      childRevokedReason: familyRows.find((r) => r.id === childJti).reason,
      familyIdMatched: true,
      childRenewRejectedAfterParentSignOut: true,
      signOutAuditCorrelationIdPresent: true,
    };

    console.log(JSON.stringify({ status: 'PASS', report }, null, 2));
  } finally {
    await pg.end();
  }
};

main().catch((err) => {
  console.error('ACCEPTANCE_FAILED:', err);
  process.exit(1);
});
