import { Logger } from '@nestjs/common';

import { isDefined } from 'twenty-shared/utils';

import { FilesFieldService } from 'src/engine/core-modules/file/files-field/services/files-field.service';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';

export type FilesFieldDeletionJobData = {
  workspaceId: string;
  fileIds: string[];
};

@Processor(MessageQueue.deleteCascadeQueue)
export class FilesFieldDeletionJob {
  private readonly logger = new Logger(FilesFieldDeletionJob.name);

  constructor(private readonly filesFieldService: FilesFieldService) {}

  @Process(FilesFieldDeletionJob.name)
  async handle(data: FilesFieldDeletionJobData): Promise<void> {
    const { workspaceId, fileIds } = data;

    if (!isDefined(fileIds) || fileIds.length === 0) {
      return;
    }

    const failures: unknown[] = [];

    for (const fileId of fileIds) {
      try {
        await this.filesFieldService.deleteFilesFieldFile({
          fileId,
          workspaceId,
        });
      } catch (error) {
        this.logger.warn(
          `Failed to delete file ${fileId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      throw failures[0];
    }
  }
}
