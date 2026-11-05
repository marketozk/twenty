import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

import { isNonEmptyString } from '@sniptt/guards';
import { type AxiosInstance } from 'axios';
import { TWENTY_COMPANIES_BASE_URL } from 'twenty-shared/constants';
import {
  type ConnectedAccountProvider,
  type FieldActorSource,
  type LinksMetadata,
} from 'twenty-shared/types';
import { isDefined, normalizeDomain } from 'twenty-shared/utils';
import { type DeepPartial, In } from 'typeorm';

import { type ContactCreationSnapshot } from 'src/engine/core-modules/crm-audit/contact-creation-proof';
import { SecureHttpClientService } from 'src/engine/core-modules/secure-http-client/secure-http-client.service';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { type WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace-repository';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { CompanyWorkspaceEntity } from 'src/modules/company/standard-objects/company.workspace-entity';
import { getCompanyNameFromDomainName } from 'src/modules/contact-creation-manager/utils/get-company-name-from-domain-name.util';
import { getDomainNamesFromLinks } from 'src/modules/contact-creation-manager/utils/get-domain-names-from-links.util';
import { WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';
import { computeDisplayName } from 'src/utils/compute-display-name';

type ContactCreationScope = Parameters<
  Parameters<WorkspaceOrmManager['runInWorkspaceTransaction']>[0]
>[0];

const uniqueByKey = <TItem, TKey extends keyof TItem>(
  items: readonly TItem[],
  key: TKey,
): TItem[] => {
  const seen = new Set<TItem[TKey]>();
  const result: TItem[] = [];
  for (const item of items) {
    const value = item[key];
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(item);
  }
  return result;
};

export type CompanyToCreate = {
  domainName: string | undefined;
  createdBySource: FieldActorSource;
  createdByWorkspaceMember?: WorkspaceMemberWorkspaceEntity | null;
  createdByContext: {
    provider: ConnectedAccountProvider;
  };
};

export type PrefetchedCompanyDomainInfo = Readonly<{
  name: string;
  city: string | undefined;
}>;

export type PreparedCompanyRecordToCreate = Readonly<{
  id: string;
  domainName: {
    primaryLinkUrl: string;
  };
  name: string;
  createdBy: {
    source: FieldActorSource;
    workspaceMemberId: string | null;
    name: string;
    context: {
      provider: ConnectedAccountProvider;
    };
  };
  address?: {
    addressCity: string;
  };
  position: number;
}>;

@Injectable()
export class CreateCompanyService {
  private readonly httpService: AxiosInstance;

  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly secureHttpClientService: SecureHttpClientService,
  ) {
    this.httpService = this.secureHttpClientService.getHttpClient({
      baseURL: TWENTY_COMPANIES_BASE_URL,
    });
  }

  async prefetchCompanyInfoByDomainNames(
    rawDomainNames: readonly string[],
    workspaceId: string,
  ): Promise<ReadonlyMap<string, PrefetchedCompanyDomainInfo>> {
    const normalizedDomains = [
      ...new Set(
        rawDomainNames
          .map((domain) => (domain ? normalizeDomain(domain) : ''))
          .filter(isNonEmptyString),
      ),
    ];
    if (normalizedDomains.length === 0) {
      return new Map();
    }

    const authContext = buildSystemAuthContext(workspaceId);
    const existingCompanies =
      await this.workspaceOrmManager.executeInWorkspaceContext(
        async () => {
          const companyRepository =
            this.workspaceOrmManager.getRepository<CompanyWorkspaceEntity>(
              'company',
              { shouldBypassPermissionChecks: true },
            );
          const primaryMatches = await companyRepository.find({
            where: {
              domainName: {
                primaryLinkUrl: In(normalizedDomains),
              },
            },
            withDeleted: true,
          });
          const secondaryMatches =
            await this.findCompaniesBySecondaryDomainNames({
              domainNames: normalizedDomains,
              companyRepository,
            });
          return [...primaryMatches, ...secondaryMatches];
        },
        authContext,
        { lite: true },
      );

    const missingDomains = normalizedDomains.filter(
      (domainName) =>
        !isDefined(
          this.findExistingCompanyByDomainName({
            existingCompanies,
            domainName,
          }),
        ),
    );
    const entries = await Promise.all(
      missingDomains.map(async (domainName) => {
        const info = await this.getCompanyInfoFromDomainName(domainName);
        return [
          domainName,
          Object.freeze({ name: info.name, city: info.city }),
        ] as const;
      }),
    );
    return new Map(entries);
  }

  async prepareCompaniesWithinTransaction({
    companies,
    workspaceId,
    transactionScope,
    prefetchedInfoByDomain,
  }: {
    companies: readonly CompanyToCreate[];
    workspaceId: string;
    transactionScope: ContactCreationScope;
    prefetchedInfoByDomain: ReadonlyMap<string, PrefetchedCompanyDomainInfo>;
  }): Promise<{
    discoveredCompanyIds: readonly string[];
    companiesToCreate: readonly PreparedCompanyRecordToCreate[];
    companiesToRestore: readonly { id: string; domainName: string }[];
  }> {
    if (companies.length === 0) {
      return Object.freeze({
        discoveredCompanyIds: Object.freeze([]),
        companiesToCreate: Object.freeze([]),
        companiesToRestore: Object.freeze([]),
      });
    }

    const authContext = buildSystemAuthContext(workspaceId);
    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const companyRepository =
          transactionScope.getRepository<CompanyWorkspaceEntity>('company', {
            shouldBypassPermissionChecks: true,
          });
        const normalizedCompanies = companies.map((company) => ({
          ...company,
          domainName: company.domainName
            ? normalizeDomain(company.domainName)
            : undefined,
        }));
        const uniqueCompanies = uniqueByKey(normalizedCompanies, 'domainName');
        const domainNames = uniqueCompanies
          .map((companyToCreate) => companyToCreate.domainName)
          .filter(isNonEmptyString);

        if (domainNames.length === 0) {
          return Object.freeze({
            discoveredCompanyIds: Object.freeze([]),
            companiesToCreate: Object.freeze([]),
            companiesToRestore: Object.freeze([]),
          });
        }

        const companiesMatchedOnPrimaryLink = await companyRepository.find({
          where: {
            domainName: {
              primaryLinkUrl: In(domainNames),
            },
          },
          withDeleted: true,
        });
        const domainNamesWithoutLiveCompany = domainNames.filter(
          (domainName) =>
            !isDefined(
              this.findExistingCompanyByDomainName({
                existingCompanies: companiesMatchedOnPrimaryLink.filter(
                  (company) => !isDefined(company.deletedAt),
                ),
                domainName,
              }),
            ),
        );
        const companiesMatchedOnSecondaryLinks =
          await this.findCompaniesBySecondaryDomainNames({
            domainNames: domainNamesWithoutLiveCompany,
            companyRepository,
          });
        const companyIdsMatchedOnPrimaryLink = new Set(
          companiesMatchedOnPrimaryLink.map((company) => company.id),
        );
        const matchedCompanies = [
          ...companiesMatchedOnPrimaryLink,
          ...companiesMatchedOnSecondaryLinks.filter(
            (company) => !companyIdsMatchedOnPrimaryLink.has(company.id),
          ),
        ];
        const existingCompanies = [
          ...matchedCompanies.filter(
            (company) => !isDefined(company.deletedAt),
          ),
          ...matchedCompanies.filter((company) => isDefined(company.deletedAt)),
        ];
        const newCompaniesToCreate = uniqueCompanies.filter(
          (company) =>
            isNonEmptyString(company.domainName) &&
            !isDefined(
              this.findExistingCompanyByDomainName({
                existingCompanies,
                domainName: company.domainName,
              }),
            ),
        );
        const companiesToRestore = uniqueByKey(
          this.filterCompaniesToRestore(uniqueCompanies, existingCompanies),
          'id',
        ).flatMap((row) =>
          isNonEmptyString(row.domainName)
            ? [
                Object.freeze({
                  id: row.id.toLowerCase(),
                  domainName: row.domainName,
                }),
              ]
            : [],
        );

        let lastCompanyPosition =
          newCompaniesToCreate.length > 0
            ? await this.getLastCompanyPosition(companyRepository)
            : 0;
        const companiesToCreate: PreparedCompanyRecordToCreate[] =
          newCompaniesToCreate.map((company) => {
            const domainName = company.domainName!;
            const info = prefetchedInfoByDomain.get(domainName) ?? {
              name: getCompanyNameFromDomainName(domainName),
              city: '',
            };
            const createdByName = computeDisplayName(
              company.createdByWorkspaceMember?.name,
            );
            return Object.freeze({
              id: randomUUID(),
              domainName: Object.freeze({
                primaryLinkUrl: domainName,
              }),
              name: info.name,
              createdBy: Object.freeze({
                source: company.createdBySource,
                workspaceMemberId:
                  company.createdByWorkspaceMember?.id?.toLowerCase() ?? null,
                name: createdByName,
                context: Object.freeze({
                  provider: company.createdByContext.provider,
                }),
              }),
              ...(info.city !== undefined
                ? { address: Object.freeze({ addressCity: info.city }) }
                : {}),
              position: ++lastCompanyPosition,
            });
          });

        return Object.freeze({
          discoveredCompanyIds: Object.freeze(
            [
              ...new Set(
                existingCompanies.map((company) => company.id.toLowerCase()),
              ),
            ].sort(),
          ),
          companiesToCreate: Object.freeze(companiesToCreate),
          companiesToRestore: Object.freeze(companiesToRestore),
        });
      },
      authContext,
      { lite: true },
    );
  }

  createCompanyMapFromSnapshots(
    snapshots: readonly ContactCreationSnapshot[],
  ): Record<string, string> {
    const companies = snapshots
      .filter((row) => row.deletedAt === 'null')
      .map((row) => ({
        id: row.id,
        domainName: {
          primaryLinkUrl: (row.domainNamePrimaryLinkUrl === undefined
            ? null
            : JSON.parse(String(row.domainNamePrimaryLinkUrl))) as
            | string
            | null,
          secondaryLinks: (row.domainNameSecondaryLinks === undefined
            ? null
            : JSON.parse(String(row.domainNameSecondaryLinks))) as
            | LinksMetadata['secondaryLinks']
            | null,
        } as LinksMetadata,
      }));
    return this.createCompanyMap(companies);
  }

  async createOrRestoreCompanies(
    companies: CompanyToCreate[],
    workspaceId: string,
  ): Promise<{
    [domainName: string]: string;
  }> {
    if (companies.length === 0) {
      return {};
    }

    const authContext = buildSystemAuthContext(workspaceId);

    return this.workspaceOrmManager.executeInWorkspaceContext(async () => {
      const companyRepository = this.workspaceOrmManager.getRepository(
        CompanyWorkspaceEntity,
        {
          shouldBypassPermissionChecks: true,
        },
      );

      const normalizedCompanies = companies.map((company) => ({
        ...company,
        domainName: company.domainName
          ? normalizeDomain(company.domainName)
          : undefined,
      }));

      const uniqueCompanies = uniqueByKey(normalizedCompanies, 'domainName');

      const domainNames = uniqueCompanies
        .map((companyToCreate) => companyToCreate.domainName)
        .filter(isNonEmptyString);

      if (domainNames.length === 0) {
        return {};
      }

      const companiesMatchedOnPrimaryLink = await companyRepository.find({
        where: {
          domainName: {
            primaryLinkUrl: In(domainNames),
          },
        },
        withDeleted: true,
      });

      const domainNamesWithoutLiveCompany = domainNames.filter(
        (domainName) =>
          !isDefined(
            this.findExistingCompanyByDomainName({
              existingCompanies: companiesMatchedOnPrimaryLink.filter(
                (company) => !isDefined(company.deletedAt),
              ),
              domainName,
            }),
          ),
      );

      const companiesMatchedOnSecondaryLinks =
        await this.findCompaniesBySecondaryDomainNames({
          domainNames: domainNamesWithoutLiveCompany,
        });

      const companyIdsMatchedOnPrimaryLink = new Set(
        companiesMatchedOnPrimaryLink.map((company) => company.id),
      );

      const matchedCompanies = [
        ...companiesMatchedOnPrimaryLink,
        ...companiesMatchedOnSecondaryLinks.filter(
          (company) => !companyIdsMatchedOnPrimaryLink.has(company.id),
        ),
      ];

      const existingCompanies = [
        ...matchedCompanies.filter((company) => !isDefined(company.deletedAt)),
        ...matchedCompanies.filter((company) => isDefined(company.deletedAt)),
      ];

      const existingCompanyIdsMap = this.createCompanyMap(existingCompanies);

      const newCompaniesToCreate = uniqueCompanies.filter(
        (company) =>
          !isDefined(
            this.findExistingCompanyByDomainName({
              existingCompanies,
              domainName: company.domainName,
            }),
          ),
      );

      const companiesToRestore = this.filterCompaniesToRestore(
        uniqueCompanies,
        existingCompanies,
      );

      if (
        newCompaniesToCreate.length === 0 &&
        companiesToRestore.length === 0
      ) {
        return existingCompanyIdsMap;
      }

      let lastCompanyPosition =
        await this.getLastCompanyPosition(companyRepository);
      const newCompaniesData = await Promise.all(
        newCompaniesToCreate.map((company) =>
          this.prepareCompanyData(company, ++lastCompanyPosition),
        ),
      );

      const createdCompanies = await companyRepository.save(newCompaniesData);

      const restoredCompanies = await companyRepository.updateMany(
        companiesToRestore.map((company) => {
          return {
            criteria: company.id,
            partialEntity: {
              deletedAt: null,
            },
          };
        }),
      );

      const formattedRestoredCompanies = restoredCompanies.raw.map(
        (row: { id: string; domainNamePrimaryLinkUrl: string }) => {
          return {
            id: row.id,
            domainName: {
              primaryLinkUrl: row.domainNamePrimaryLinkUrl,
            },
          };
        },
      );

      return {
        ...existingCompanyIdsMap,
        ...(createdCompanies.length > 0
          ? this.createCompanyMap(createdCompanies)
          : {}),
        ...(formattedRestoredCompanies.length > 0
          ? this.createCompanyMap(formattedRestoredCompanies)
          : {}),
      };
    }, authContext);
  }

  private async findCompaniesBySecondaryDomainNames({
    domainNames,
    companyRepository: providedRepository,
  }: {
    domainNames: string[];
    companyRepository?: WorkspaceRepository<CompanyWorkspaceEntity>;
  }): Promise<CompanyWorkspaceEntity[]> {
    if (domainNames.length === 0) {
      return [];
    }

    const companyRepository =
      providedRepository ??
      this.workspaceOrmManager.getRepository<CompanyWorkspaceEntity>(
        'company',
        {
          shouldBypassPermissionChecks: true,
        },
      );

    const containmentConditions = domainNames
      .map(
        (_, index) =>
          `"company"."domainNameSecondaryLinks" @> CAST(:secondaryLink${index} AS jsonb)`,
      )
      .join(' OR ');

    const containmentParameters = Object.fromEntries(
      domainNames.map((domainName, index) => [
        `secondaryLink${index}`,
        JSON.stringify([{ url: domainName }]),
      ]),
    );

    return companyRepository
      .createQueryBuilder('company')
      .where(containmentConditions, containmentParameters)
      .withDeleted()
      .getMany();
  }

  private findExistingCompanyByDomainName({
    existingCompanies,
    domainName,
  }: {
    existingCompanies: CompanyWorkspaceEntity[];
    domainName: string | undefined;
  }): CompanyWorkspaceEntity | undefined {
    if (!isNonEmptyString(domainName)) {
      return undefined;
    }

    return existingCompanies.find((existingCompany) =>
      getDomainNamesFromLinks(existingCompany.domainName).includes(domainName),
    );
  }

  private filterCompaniesToRestore(
    uniqueCompanies: CompanyToCreate[],
    existingCompanies: CompanyWorkspaceEntity[],
  ) {
    return uniqueCompanies
      .map((company) => {
        const existingCompany = this.findExistingCompanyByDomainName({
          existingCompanies,
          domainName: company.domainName,
        });

        return isDefined(existingCompany) &&
          isDefined(existingCompany.deletedAt)
          ? {
              domainName: company.domainName,
              id: existingCompany.id,
              deletedAt: null,
            }
          : undefined;
      })
      .filter(isDefined);
  }

  private async prepareCompanyData(
    company: CompanyToCreate,
    position: number,
  ): Promise<DeepPartial<CompanyWorkspaceEntity>> {
    const { name, city } = await this.getCompanyInfoFromDomainName(
      company.domainName,
    );
    const createdByName = computeDisplayName(
      company.createdByWorkspaceMember?.name,
    );

    return {
      domainName: {
        primaryLinkUrl: company.domainName ?? '',
      },
      name,
      createdBy: {
        source: company.createdBySource,
        workspaceMemberId: company.createdByWorkspaceMember?.id,
        name: createdByName,
        context: {
          provider: company.createdByContext.provider,
        },
      },
      address: {
        addressCity: city,
      },
      position,
    };
  }

  private createCompanyMap(
    companies: Pick<CompanyWorkspaceEntity, 'id' | 'domainName'>[],
  ) {
    return companies.reduce(
      (acc, company) => {
        if (!company.id) {
          return acc;
        }

        for (const domainName of getDomainNamesFromLinks(company.domainName)) {
          if (!isDefined(acc[domainName])) {
            acc[domainName] = company.id;
          }
        }

        return acc;
      },
      {} as { [domainName: string]: string },
    );
  }

  private async getLastCompanyPosition(
    companyRepository: WorkspaceRepository<CompanyWorkspaceEntity>,
  ): Promise<number> {
    const lastCompanyPosition = await companyRepository.maximum(
      'position',
      undefined,
    );

    return lastCompanyPosition ?? 0;
  }

  private async getCompanyInfoFromDomainName(
    domainName: string | undefined,
  ): Promise<{
    name: string;
    city: string;
  }> {
    try {
      const response = await this.httpService.get(`/${domainName}`);

      const data = response.data;

      return {
        name: data.name ?? getCompanyNameFromDomainName(domainName ?? ''),
        city: data.city,
      };
    } catch {
      return {
        name: getCompanyNameFromDomainName(domainName ?? ''),
        city: '',
      };
    }
  }
}
