/* @license Enterprise */

import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';

import { msg } from '@lingui/core/macro';
import { custom, Issuer } from 'openid-client';
import { isDefined } from 'twenty-shared/utils';
import { DataSource, QueryFailedError, Repository } from 'typeorm';

import { POSTGRESQL_ERROR_CODES } from 'src/engine/api/graphql/workspace-query-runner/constants/postgres-error-codes.constants';
import { type QueryFailedErrorWithCode } from 'src/engine/api/graphql/workspace-query-runner/utils/workspace-query-runner-graphql-api-exception-handler.util';
import {
  captureWorkspaceDomainAudit,
  consumeWorkspaceDomainAuditRequest,
  runAuditedSsoIdentityProviderCreate,
  runAuditedSsoIdentityProviderDelete,
  runAuditedSsoIdentityProviderUpdate,
  type SsoIdentityProviderStatusValue,
  type WorkspaceDomainAuditIdentity,
} from 'src/engine/core-modules/crm-audit/workspace-domain-audit';
import {
  WorkspaceSsoIdentityProviderEntity,
  IdentityProviderType,
  OidcResponseType,
} from 'src/engine/core-modules/sso/workspace-sso-identity-provider.entity';
import { BillingEntitlementKey } from 'src/engine/core-modules/billing/enums/billing-entitlement-key.enum';
import { BillingService } from 'src/engine/core-modules/billing/services/billing.service';
import { ExceptionHandlerService } from 'src/engine/core-modules/exception-handler/exception-handler.service';
import { SecureHttpClientService } from 'src/engine/core-modules/secure-http-client/secure-http-client.service';
import {
  SsoException,
  SsoExceptionCode,
} from 'src/engine/core-modules/sso/sso.exception';
import {
  type OidcConfiguration,
  type SamlConfiguration,
  type SsoConfiguration,
} from 'src/engine/core-modules/sso/types/sso-configurations.type';
import { resolveIdTokenSigningAlgorithm } from 'src/engine/core-modules/sso/utils/resolve-id-token-signing-algorithm.util';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';

@Injectable()
export class SsoService {
  private readonly featureLookUpKey = BillingEntitlementKey.SSO;

  // openid-client resolves this hook on the Issuer class, issuer and client instances, so all three get it.
  // It deep-merges the result with its own per-request options, so only the agent is returned.
  private readonly oidcHttpOptions = (url: URL) => ({
    agent: this.secureHttpClientService.getSsrfSafeAgent(url),
  });

  constructor(
    @InjectRepository(WorkspaceSsoIdentityProviderEntity)
    private readonly workspaceSsoIdentityProviderRepository: Repository<WorkspaceSsoIdentityProviderEntity>,
    private readonly twentyConfigService: TwentyConfigService,
    private readonly billingService: BillingService,
    private readonly exceptionHandlerService: ExceptionHandlerService,
    private readonly secureHttpClientService: SecureHttpClientService,
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {
    Issuer[custom.http_options] = this.oidcHttpOptions;
  }

  private resolveDataSource(): DataSource | undefined {
    return (
      this.dataSource ??
      (this.workspaceSsoIdentityProviderRepository?.manager?.connection as
        | DataSource
        | undefined)
    );
  }

  private async isSsoEnabled(workspaceId: string) {
    const isSsoBillingEnabled = await this.billingService.hasEntitlement(
      workspaceId,
      this.featureLookUpKey,
    );

    if (!isSsoBillingEnabled) {
      throw new SsoException(
        `No entitlement found for this workspace`,
        SsoExceptionCode.SSO_DISABLE,
      );
    }
  }

  async discoverOidcIssuer(issuerUrl: string) {
    try {
      return await Issuer.discover(issuerUrl);
    } catch (error) {
      // Surfaced so a blocked private-network issuer is diagnosable at setup; at login it only shows as a redirect.
      const reason = error instanceof Error ? error.message : String(error);

      throw new SsoException(
        `Invalid issuer: ${reason}`,
        SsoExceptionCode.INVALID_ISSUER_URL,
        { userFriendlyMessage: msg`Invalid issuer URL: ${reason}` },
      );
    }
  }

  async createOidcIdentityProvider(
    data: Pick<
      WorkspaceSsoIdentityProviderEntity,
      'issuer' | 'clientID' | 'clientSecret' | 'name'
    >,
    workspaceId: string,
    options?: {
      auditIdentity?: WorkspaceDomainAuditIdentity;
    },
  ) {
    const resolvedDataSource = this.resolveDataSource();
    const auditRequest =
      resolvedDataSource || options?.auditIdentity !== undefined
        ? captureWorkspaceDomainAudit({
            workspaceId,
            auditIdentity: options?.auditIdentity,
          })
        : undefined;

    try {
      let issuer: Issuer;
      try {
        await this.isSsoEnabled(workspaceId);

        issuer = await this.discoverOidcIssuer(data.issuer);
      } catch (err) {
        if (err instanceof SsoException) {
          return err;
        }

        this.exceptionHandlerService.captureExceptions([err]);

        return new SsoException(
          'Unknown SSO configuration error',
          SsoExceptionCode.UNKNOWN_SSO_CONFIGURATION_ERROR,
        );
      }

      if (!resolvedDataSource && !auditRequest) {
        const identityProvider =
          await this.workspaceSsoIdentityProviderRepository.save({
            type: IdentityProviderType.OIDC,
            clientID: data.clientID,
            clientSecret: data.clientSecret,
            issuer: issuer.metadata.issuer,
            name: data.name,
            workspaceId,
          });

        return {
          id: identityProvider.id,
          type: identityProvider.type,
          name: identityProvider.name,
          status: identityProvider.status,
          issuer: identityProvider.issuer,
        };
      }

      const identityProvider = await runAuditedSsoIdentityProviderCreate(
        resolvedDataSource,
        auditRequest!,
        {
          record: {
            type: IdentityProviderType.OIDC,
            clientID: data.clientID,
            clientSecret: data.clientSecret,
            issuer: issuer.metadata.issuer,
            name: data.name,
          },
        },
      );

      return {
        id: identityProvider.id,
        type: identityProvider.type as IdentityProviderType,
        name: identityProvider.name,
        status:
          identityProvider.status as WorkspaceSsoIdentityProviderEntity['status'],
        issuer: identityProvider.issuer,
      };
    } finally {
      consumeWorkspaceDomainAuditRequest(auditRequest);
    }
  }

  async createSamlIdentityProvider(
    data: Pick<
      WorkspaceSsoIdentityProviderEntity,
      'ssoURL' | 'certificate' | 'fingerprint' | 'id' | 'name' | 'issuer'
    >,
    workspaceId: string,
    options?: {
      auditIdentity?: WorkspaceDomainAuditIdentity;
    },
  ) {
    const resolvedDataSource = this.resolveDataSource();
    const auditRequest =
      resolvedDataSource || options?.auditIdentity !== undefined
        ? captureWorkspaceDomainAudit({
            workspaceId,
            auditIdentity: options?.auditIdentity,
          })
        : undefined;

    try {
      await this.isSsoEnabled(workspaceId);

      const identityProvider = {
        id: data.id,
        name: data.name,
        issuer: data.issuer,
        ssoURL: data.ssoURL,
        certificate: data.certificate,
        fingerprint: data.fingerprint,
        type: IdentityProviderType.SAML,
        workspaceId,
      };

      try {
        if (!resolvedDataSource && !auditRequest) {
          const { generatedMaps } =
            await this.workspaceSsoIdentityProviderRepository.insert(
              identityProvider,
            );

          const { status } = generatedMaps[0] as Pick<
            WorkspaceSsoIdentityProviderEntity,
            'status'
          >;

          return {
            id: identityProvider.id,
            type: identityProvider.type,
            name: identityProvider.name,
            issuer: this.buildIssuerURL(identityProvider),
            status,
          };
        }

        const created = await runAuditedSsoIdentityProviderCreate(
          resolvedDataSource,
          auditRequest!,
          {
            record: {
              id: identityProvider.id,
              name: identityProvider.name,
              issuer: identityProvider.issuer,
              ssoURL: identityProvider.ssoURL,
              certificate: identityProvider.certificate,
              fingerprint: identityProvider.fingerprint,
              type: IdentityProviderType.SAML,
            },
          },
        );

        return {
          id: created.id,
          type: created.type as IdentityProviderType,
          name: created.name,
          issuer: this.buildIssuerURL(identityProvider),
          status:
            created.status as WorkspaceSsoIdentityProviderEntity['status'],
        };
      } catch (error) {
        if (
          error instanceof QueryFailedError &&
          (error as QueryFailedErrorWithCode).code ===
            POSTGRESQL_ERROR_CODES.UNIQUE_VIOLATION &&
          (error as { table?: string }).table !== 'crmAuditEntry'
        ) {
          throw new SsoException(
            'Identity provider already exists',
            SsoExceptionCode.IDENTITY_PROVIDER_ALREADY_EXISTS,
          );
        }

        throw error;
      }
    } finally {
      consumeWorkspaceDomainAuditRequest(auditRequest);
    }
  }

  async findSsoIdentityProviderById(identityProviderId: string) {
    return (await this.workspaceSsoIdentityProviderRepository.findOne({
      where: { id: identityProviderId },
      relations: { workspace: true },
    })) as (SsoConfiguration & WorkspaceSsoIdentityProviderEntity) | null;
  }

  buildCallbackUrl(
    identityProvider: Pick<WorkspaceSsoIdentityProviderEntity, 'type' | 'id'>,
  ) {
    const callbackURL = new URL(this.twentyConfigService.get('SERVER_URL'));

    callbackURL.pathname = `/auth/${identityProvider.type.toLowerCase()}/callback`;

    if (identityProvider.type === IdentityProviderType.SAML) {
      callbackURL.pathname += `/${identityProvider.id}`;
    }

    return callbackURL.toString();
  }

  buildIssuerURL(
    identityProvider: Pick<WorkspaceSsoIdentityProviderEntity, 'id' | 'type'>,
    searchParams?: Record<string, string | boolean>,
  ) {
    const authorizationUrl = new URL(
      this.twentyConfigService.get('SERVER_URL'),
    );

    authorizationUrl.pathname = `/auth/${identityProvider.type.toLowerCase()}/login/${identityProvider.id}`;

    if (searchParams) {
      Object.entries(searchParams).forEach(([key, value]) => {
        authorizationUrl.searchParams.append(key, value.toString());
      });
    }

    return authorizationUrl.toString();
  }

  private isOidcIdentityProvider(
    identityProvider: WorkspaceSsoIdentityProviderEntity,
  ): identityProvider is OidcConfiguration &
    WorkspaceSsoIdentityProviderEntity {
    return identityProvider.type === IdentityProviderType.OIDC;
  }

  isSamlIdentityProvider(
    identityProvider: WorkspaceSsoIdentityProviderEntity,
  ): identityProvider is SamlConfiguration &
    WorkspaceSsoIdentityProviderEntity {
    return identityProvider.type === IdentityProviderType.SAML;
  }

  getOidcClient(
    identityProvider: WorkspaceSsoIdentityProviderEntity,
    issuer: Issuer,
  ) {
    if (!this.isOidcIdentityProvider(identityProvider)) {
      throw new SsoException(
        'Invalid Identity Provider type',
        SsoExceptionCode.INVALID_IDP_TYPE,
      );
    }

    issuer[custom.http_options] = this.oidcHttpOptions;

    const idTokenSigningAlgorithm = resolveIdTokenSigningAlgorithm(
      issuer.metadata,
    );

    const client = new issuer.Client({
      client_id: identityProvider.clientID,
      client_secret: identityProvider.clientSecret,
      redirect_uris: [this.buildCallbackUrl(identityProvider)],
      response_types: [OidcResponseType.CODE],
      ...(isDefined(idTokenSigningAlgorithm) && {
        id_token_signed_response_alg: idTokenSigningAlgorithm,
      }),
    });

    client[custom.http_options] = this.oidcHttpOptions;

    return client;
  }

  async getAuthorizationUrlForSSO(
    identityProviderId: string,
    searchParams: Record<string, string | boolean>,
  ) {
    const identityProvider =
      (await this.workspaceSsoIdentityProviderRepository.findOne({
        where: {
          id: identityProviderId,
        },
      })) as WorkspaceSsoIdentityProviderEntity & SsoConfiguration;

    if (!identityProvider) {
      throw new SsoException(
        'Identity Provider not found',
        SsoExceptionCode.USER_NOT_FOUND,
      );
    }

    return {
      id: identityProvider.id,
      authorizationURL: this.buildIssuerURL(identityProvider, searchParams),
      type: identityProvider.type,
    };
  }

  async getSsoIdentityProviders(workspaceId: string) {
    return (await this.workspaceSsoIdentityProviderRepository.find({
      where: { workspaceId },
      select: ['id', 'name', 'type', 'issuer', 'status'],
    })) as Array<
      Pick<
        WorkspaceSsoIdentityProviderEntity,
        'id' | 'name' | 'type' | 'issuer' | 'status'
      >
    >;
  }

  async deleteSsoIdentityProvider(
    identityProviderId: string,
    workspaceId: string,
    options?: {
      auditIdentity?: WorkspaceDomainAuditIdentity;
    },
  ) {
    const resolvedDataSource = this.resolveDataSource();
    const auditRequest =
      resolvedDataSource || options?.auditIdentity !== undefined
        ? captureWorkspaceDomainAudit({
            workspaceId,
            auditIdentity: options?.auditIdentity,
          })
        : undefined;

    if (!resolvedDataSource && !auditRequest) {
      const identityProvider =
        await this.workspaceSsoIdentityProviderRepository.findOne({
          where: {
            id: identityProviderId,
            workspaceId,
          },
        });

      if (!identityProvider) {
        throw new SsoException(
          'Identity Provider not found',
          SsoExceptionCode.IDENTITY_PROVIDER_NOT_FOUND,
        );
      }

      await this.workspaceSsoIdentityProviderRepository.delete({
        id: identityProvider.id,
      });

      return { identityProviderId: identityProvider.id };
    }

    try {
      return await runAuditedSsoIdentityProviderDelete(
        resolvedDataSource,
        auditRequest!,
        {
          identityProviderId,
          onNotFound: () => {
            throw new SsoException(
              'Identity Provider not found',
              SsoExceptionCode.IDENTITY_PROVIDER_NOT_FOUND,
            );
          },
        },
      );
    } finally {
      consumeWorkspaceDomainAuditRequest(auditRequest);
    }
  }

  async editSsoIdentityProvider(
    payload: Partial<WorkspaceSsoIdentityProviderEntity>,
    workspaceId: string,
    options?: {
      auditIdentity?: WorkspaceDomainAuditIdentity;
    },
  ) {
    const resolvedDataSource = this.resolveDataSource();
    const auditRequest =
      resolvedDataSource || options?.auditIdentity !== undefined
        ? captureWorkspaceDomainAudit({
            workspaceId,
            auditIdentity: options?.auditIdentity,
          })
        : undefined;

    if (!resolvedDataSource && !auditRequest) {
      const ssoIdp = await this.workspaceSsoIdentityProviderRepository.findOne({
        where: {
          id: payload.id,
          workspaceId,
        },
      });

      if (!ssoIdp) {
        throw new SsoException(
          'Identity Provider not found',
          SsoExceptionCode.IDENTITY_PROVIDER_NOT_FOUND,
        );
      }

      const result = await this.workspaceSsoIdentityProviderRepository.save({
        ...ssoIdp,
        ...payload,
      });

      return {
        id: result.id,
        type: result.type,
        issuer: result.issuer,
        name: result.name,
        status: result.status,
      };
    }

    try {
      const result = await runAuditedSsoIdentityProviderUpdate(
        resolvedDataSource,
        auditRequest!,
        {
          identityProviderId: payload.id ?? '',
          patch: {
            ...(payload.name !== undefined ? { name: payload.name } : {}),
            ...(payload.status !== undefined
              ? { status: payload.status as SsoIdentityProviderStatusValue }
              : {}),
            ...(payload.issuer !== undefined ? { issuer: payload.issuer } : {}),
            ...(payload.clientID !== undefined
              ? { clientID: payload.clientID }
              : {}),
            ...(payload.clientSecret !== undefined
              ? { clientSecret: payload.clientSecret }
              : {}),
            ...(payload.ssoURL !== undefined ? { ssoURL: payload.ssoURL } : {}),
            ...(payload.certificate !== undefined
              ? { certificate: payload.certificate }
              : {}),
            ...(payload.fingerprint !== undefined
              ? { fingerprint: payload.fingerprint }
              : {}),
          },
          onNotFound: () => {
            throw new SsoException(
              'Identity Provider not found',
              SsoExceptionCode.IDENTITY_PROVIDER_NOT_FOUND,
            );
          },
        },
      );

      return {
        id: result.id,
        type: result.type as IdentityProviderType,
        issuer: result.issuer,
        name: result.name,
        status: result.status as WorkspaceSsoIdentityProviderEntity['status'],
      };
    } finally {
      consumeWorkspaceDomainAuditRequest(auditRequest);
    }
  }
}
